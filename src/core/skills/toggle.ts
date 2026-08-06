import {mkdir, symlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {AmcError, type Layout, type Target, type TargetChange, type TargetState, type ToggleResult} from '../model.js';
import {targets} from '../layout.js';
import {isOwnedLink, isSkillDirectory, lstatIfPresent, observeTargetPath, validateSkillName} from './scan.js';
import {createOperationId, createOperationRoot, moveIntoOperationRoot, type OperationRoot} from './migration.js';

type ToggleAction =
	| Readonly<{kind: 'noop'; target: Target; state: 'enabled' | 'disabled'}>
	| Readonly<{kind: 'create'; target: Target; targetPath: string}>
	| Readonly<{kind: 'restore'; target: Target; targetPath: string; parkedPath: string}>
	| Readonly<{kind: 'park'; target: Target; targetPath: string; parkedPath: string}>
	| Readonly<{kind: 'deduplicate'; target: Target; path: string; before: 'enabled'; after: 'enabled' | 'disabled'}>;

type ToggleStep =
	| Readonly<{kind: 'created'; target: Target; path: string}>
	| Readonly<{kind: 'archived'; target: Target; fromPath: string; archivePath: string}>;


async function classifyTargetPath(path: string, canonicalPath: string): Promise<TargetState> {
	return (await observeTargetPath(path, canonicalPath, await isSkillDirectory(canonicalPath))).state;
}

async function planToggle(
	layout: Layout,
	name: string,
	enabled: boolean,
	target: Target,
): Promise<ToggleAction> {
	const canonicalPath = join(layout.amc.skills, name);
	const targetPath = join(layout.targets[target], name);
	const parkedPath = join(layout.amc.disabledLinks, target, name);
	const state = await classifyTargetPath(targetPath, canonicalPath);

	if (enabled && (target === 'pi' || target === 'codex')) {
		for (const sharedRoot of [layout.sources.agents, layout.sources.agent]) {
			const sharedPath = join(sharedRoot, name);
			if (await isSkillDirectory(sharedPath)) {
				throw new AmcError(
					'TARGET_BLOCKED',
					`Shared Skill path is already discovered by ${target}. Reconcile it before enabling a second link.`,
					sharedPath,
				);
			}
		}
	}

	if (state === 'unmanaged' || state === 'conflict') {
		throw new AmcError('TARGET_BLOCKED', `Target ${target} is ${state}.`, targetPath);
	}
	const parked = await lstatIfPresent(parkedPath);
	if (state === 'enabled' && parked !== undefined) {
		if (!(await isOwnedLink(parkedPath, canonicalPath))) {
			throw new AmcError('PARKING_BLOCKED', `Parked path for ${target} is not AMC-owned.`, parkedPath);
		}
		return {
			kind: 'deduplicate',
			target,
			path: enabled ? parkedPath : targetPath,
			before: 'enabled',
			after: enabled ? 'enabled' : 'disabled',
		};
	}
	if (enabled && state === 'enabled' || !enabled && state === 'disabled') {
		return {kind: 'noop', target, state};
	}

	if (enabled) {
		if (parked === undefined) {
			return {kind: 'create', target, targetPath};
		}
		if (!(await isOwnedLink(parkedPath, canonicalPath))) {
			throw new AmcError('PARKING_BLOCKED', `Parked path for ${target} is not AMC-owned.`, parkedPath);
		}
		return {kind: 'restore', target, targetPath, parkedPath};
	}
	if (parked !== undefined) {
		throw new AmcError('PARKING_BLOCKED', `Parked path for ${target} already exists.`, parkedPath);
	}
	return {kind: 'park', target, targetPath, parkedPath};
}

async function applyToggle(
	action: ToggleAction,
	canonicalPath: string,
	name: string,
	archiveRoot: OperationRoot | undefined,
	completed: ToggleStep[],
): Promise<void> {
	switch (action.kind) {
		case 'noop':
			return;
		case 'create':
			await mkdir(dirname(action.targetPath), {recursive: true});
			await symlink(canonicalPath, action.targetPath);
			completed.push({kind: 'created', target: action.target, path: action.targetPath});
			return;
		case 'restore': {
			if (archiveRoot === undefined) {
				throw new Error('Toggle archive root was not claimed.');
			}
			await mkdir(dirname(action.targetPath), {recursive: true});
			await symlink(canonicalPath, action.targetPath);
			completed.push({kind: 'created', target: action.target, path: action.targetPath});
			const archivePath = await moveIntoOperationRoot(
				action.parkedPath,
				archiveRoot,
				['links', action.target, name],
			);
			completed.push({kind: 'archived', target: action.target, fromPath: action.parkedPath, archivePath});
			return;
		}
		case 'park': {
			if (archiveRoot === undefined) {
				throw new Error('Toggle archive root was not claimed.');
			}
			await mkdir(dirname(action.parkedPath), {recursive: true});
			await symlink(canonicalPath, action.parkedPath);
			completed.push({kind: 'created', target: action.target, path: action.parkedPath});
			const archivePath = await moveIntoOperationRoot(
				action.targetPath,
				archiveRoot,
				['links', action.target, name],
			);
			completed.push({kind: 'archived', target: action.target, fromPath: action.targetPath, archivePath});
			return;
		}
		case 'deduplicate': {
			if (archiveRoot === undefined) {
				throw new Error('Toggle archive root was not claimed.');
			}
			const archivePath = await moveIntoOperationRoot(action.path, archiveRoot, ['links', action.target, name]);
			completed.push({kind: 'archived', target: action.target, fromPath: action.path, archivePath});
		}
	}
}

async function rollbackToggles(
	layout: Layout,
	name: string,
	operationId: string,
	canonicalPath: string,
	completed: ReadonlyArray<ToggleStep>,
): Promise<ReadonlyArray<string>> {
	const recoveryPaths: string[] = [];
	let failedRoot: OperationRoot | undefined;
	if (completed.some(step => step.kind === 'created')) {
		try {
			failedRoot = await createOperationRoot(layout.amc.failed, operationId);
		} catch {
			recoveryPaths.push(join(layout.amc.failed, operationId));
		}
	}

	for (const step of completed.toReversed()) {
		try {
			switch (step.kind) {
				case 'created': {
					if (failedRoot === undefined) {
						recoveryPaths.push(step.path);
						break;
					}
					await moveIntoOperationRoot(step.path, failedRoot, ['links', step.target, name]);
					break;
				}
				case 'archived':
					await symlink(canonicalPath, step.fromPath);
			}
		} catch {
			recoveryPaths.push(step.kind === 'created' ? step.path : step.archivePath);
		}
	}

	return recoveryPaths;
}

function toggleChange(action: ToggleAction, enabled: boolean): TargetChange {
	if (action.kind === 'noop') {
		return {
			target: action.target,
			before: action.state,
			after: action.state,
			changed: false,
		};
	}
	if (action.kind === 'deduplicate') {
		return {target: action.target, before: action.before, after: action.after, changed: true};
	}
	return {
		target: action.target,
		before: enabled ? 'disabled' : 'enabled',
		after: enabled ? 'enabled' : 'disabled',
		changed: true,
	};
}

export async function setSkillEnabled(
	layout: Layout,
	name: string,
	enabled: boolean,
	selectedTargets: ReadonlyArray<Target> = targets,
): Promise<ToggleResult> {
	validateSkillName(name);
	const canonicalPath = join(layout.amc.skills, name);
	if (!(await isSkillDirectory(canonicalPath))) {
		throw new AmcError('CANONICAL_MISSING', `Canonical Skill does not exist: ${name}`, canonicalPath);
	}
	const operationId = createOperationId();

	const actions = await Promise.all(
		[...new Set(selectedTargets)].map(target => planToggle(layout, name, enabled, target)),
	);
	const completed: ToggleStep[] = [];

	try {
		const needsArchive = actions.some(action => action.kind === 'restore' || action.kind === 'park' || action.kind === 'deduplicate');
		const archiveRoot = needsArchive
			? await createOperationRoot(layout.amc.backups, operationId)
			: undefined;
		for (const action of actions) {
			await applyToggle(action, canonicalPath, name, archiveRoot, completed);
		}
		for (const action of actions) {
			const state = await classifyTargetPath(join(layout.targets[action.target], name), canonicalPath);
			if (state !== (enabled ? 'enabled' : 'disabled')) {
				throw new Error(`Verification failed for ${action.target}.`);
			}
		}
	} catch (error: unknown) {
		const recoveryPaths = await rollbackToggles(
			layout,
			name,
			operationId,
			canonicalPath,
			completed,
		);
		const detail = error instanceof Error ? error.message : 'Unknown filesystem failure.';
		if (recoveryPaths.length > 0) {
			throw new AmcError(
				'ROLLBACK_FAILED',
				`Toggle failed and needs manual recovery at: ${recoveryPaths.join(', ')}`,
				recoveryPaths[0] ?? canonicalPath,
			);
		}
		throw new AmcError('OPERATION_FAILED', `Toggle failed: ${detail}`, canonicalPath);
	}

	return {operationId, name, changes: actions.map(action => toggleChange(action, enabled))};
}


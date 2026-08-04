import {constants, type Dirent, type Stats} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {access, lstat, mkdir, readdir, readlink, rename, stat, symlink} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

export type Target = 'claude' | 'pi' | 'codex';

export type AmcPaths = Readonly<{
	root: string;
	skills: string;
	backups: string;
	disabledLinks: string;
	staging: string;
	failed: string;
}>;

export type TargetPaths = Readonly<Record<Target, string>>;

export type Layout = Readonly<{
	home: string;
	amc: AmcPaths;
	targets: TargetPaths;
}>;

export type TargetState = 'enabled' | 'disabled' | 'unmanaged' | 'conflict';

export type Skill = Readonly<{
	name: string;
	canonical: boolean;
	states: Readonly<Record<Target, TargetState>>;
}>;

export type Diagnostic = Readonly<{
	path: string;
	message: string;
}>;

export type ScanResult = Readonly<{
	skills: ReadonlyArray<Skill>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>;

export type TargetChange = Readonly<{
	target: Target;
	before: 'enabled' | 'disabled';
	after: 'enabled' | 'disabled';
	changed: boolean;
}>;

export type ToggleResult = Readonly<{
	name: string;
	changes: ReadonlyArray<TargetChange>;
}>;

export type AmcErrorCode =
	| 'INVALID_SKILL_NAME'
	| 'CANONICAL_MISSING'
	| 'TARGET_BLOCKED'
	| 'PARKING_BLOCKED'
	| 'OPERATION_FAILED'
	| 'ROLLBACK_FAILED';

export class AmcError extends Error {
	readonly code: AmcErrorCode;
	readonly path: string;

	constructor(code: AmcErrorCode, message: string, path: string) {
		super(message);
		this.name = 'AmcError';
		this.code = code;
		this.path = path;
	}
}

type TargetEntry = Readonly<{
	state: Exclude<TargetState, 'disabled'>;
	visible: boolean;
}>;

type TargetScan = Readonly<{
	entries: ReadonlyMap<string, TargetEntry>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>;

type ToggleAction =
	| Readonly<{kind: 'noop'; target: Target; state: 'enabled' | 'disabled'}>
	| Readonly<{kind: 'create'; target: Target; targetPath: string}>
	| Readonly<{kind: 'restore'; target: Target; targetPath: string; parkedPath: string}>
	| Readonly<{kind: 'park'; target: Target; targetPath: string; parkedPath: string}>;

export const targets: ReadonlyArray<Target> = ['claude', 'pi', 'codex'];

export function createLayout(home: string): Layout {
	const root = join(home, '.amc');

	return {
		home,
		amc: {
			root,
			skills: join(root, 'skills'),
			backups: join(root, 'backups'),
			disabledLinks: join(root, 'disabled-links'),
			staging: join(root, 'staging'),
			failed: join(root, 'failed'),
		},
		targets: {
			claude: join(home, '.claude', 'skills'),
			pi: join(home, '.pi', 'agent', 'skills'),
			codex: join(home, '.codex', 'skills'),
		},
	};
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return undefined;
		}
		throw error;
	}
}

async function readDirectory(path: string): Promise<ReadonlyArray<Dirent>> {
	try {
		return await readdir(path, {withFileTypes: true});
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return [];
		}
		throw error;
	}
}

async function isSkillDirectory(path: string): Promise<boolean> {
	const directory = await lstatIfPresent(path);
	if (!directory?.isDirectory()) {
		return false;
	}

	const skillFile = join(path, 'SKILL.md');
	try {
		if (!(await stat(skillFile)).isFile()) {
			return false;
		}
		await access(skillFile, constants.R_OK);
		return true;
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return false;
		}
		throw error;
	}
}

async function scanCanonical(path: string): Promise<Readonly<{
	names: ReadonlySet<string>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>> {
	const names = new Set<string>();
	const diagnostics: Diagnostic[] = [];

	for (const entry of await readDirectory(path)) {
		const entryPath = join(path, entry.name);
		if (await isSkillDirectory(entryPath)) {
			names.add(entry.name);
		} else {
			diagnostics.push({path: entryPath, message: 'Canonical entry is not a valid Skill directory.'});
		}
	}

	return {names, diagnostics};
}

async function scanTarget(
	path: string,
	canonicalPath: string,
	canonicalNames: ReadonlySet<string>,
): Promise<TargetScan> {
	const entries = new Map<string, TargetEntry>();
	const diagnostics: Diagnostic[] = [];

	for (const entry of await readDirectory(path)) {
		const entryPath = join(path, entry.name);
		if (entry.isSymbolicLink()) {
			const destination = resolve(dirname(entryPath), await readlink(entryPath));
			const expected = resolve(canonicalPath, entry.name);
			if (destination === expected && canonicalNames.has(entry.name)) {
				entries.set(entry.name, {state: 'enabled', visible: true});
				continue;
			}

			entries.set(entry.name, {
				state: 'conflict',
				visible: await isSkillDirectory(destination),
			});
			diagnostics.push({path: entryPath, message: 'Symlink is not managed by AMC.'});
			continue;
		}

		if (await isSkillDirectory(entryPath)) {
			entries.set(entry.name, {state: 'unmanaged', visible: true});
			continue;
		}

		entries.set(entry.name, {state: 'conflict', visible: false});
		diagnostics.push({path: entryPath, message: 'Target entry is not a valid Skill directory.'});
	}

	return {entries, diagnostics};
}

function targetState(scan: TargetScan, name: string): TargetState {
	return scan.entries.get(name)?.state ?? 'disabled';
}

export async function listSkills(layout: Layout): Promise<ScanResult> {
	const canonical = await scanCanonical(layout.amc.skills);
	const [claude, pi, codex] = await Promise.all([
		scanTarget(layout.targets.claude, layout.amc.skills, canonical.names),
		scanTarget(layout.targets.pi, layout.amc.skills, canonical.names),
		scanTarget(layout.targets.codex, layout.amc.skills, canonical.names),
	]);
	const names = new Set(canonical.names);

	for (const scan of [claude, pi, codex]) {
		for (const [name, entry] of scan.entries) {
			if (entry.visible) {
				names.add(name);
			}
		}
	}

	const skills = [...names].sort().map(name => ({
		name,
		canonical: canonical.names.has(name),
		states: {
			claude: targetState(claude, name),
			pi: targetState(pi, name),
			codex: targetState(codex, name),
		},
	}));
	const diagnostics = [
		...canonical.diagnostics,
		...claude.diagnostics,
		...pi.diagnostics,
		...codex.diagnostics,
	].sort((left, right) => left.path.localeCompare(right.path));

	return {skills, diagnostics};
}

function validateSkillName(name: string): void {
	if (
		name.length === 0 ||
		name === '.' ||
		name === '..' ||
		name.includes('/') ||
		name.includes('\\') ||
		name.includes('\0')
	) {
		throw new AmcError('INVALID_SKILL_NAME', `Invalid Skill name: ${name}`, name);
	}
}

async function classifyTargetPath(path: string, canonicalPath: string): Promise<TargetState> {
	const entry = await lstatIfPresent(path);
	if (entry === undefined) {
		return 'disabled';
	}
	if (entry.isSymbolicLink()) {
		const destination = resolve(dirname(path), await readlink(path));
		return destination === resolve(canonicalPath) ? 'enabled' : 'conflict';
	}
	return entry.isDirectory() && await isSkillDirectory(path) ? 'unmanaged' : 'conflict';
}

async function isOwnedLink(path: string, canonicalPath: string): Promise<boolean> {
	const entry = await lstatIfPresent(path);
	if (!entry?.isSymbolicLink()) {
		return false;
	}
	return resolve(dirname(path), await readlink(path)) === resolve(canonicalPath);
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

	if (state === 'unmanaged' || state === 'conflict') {
		throw new AmcError('TARGET_BLOCKED', `Target ${target} is ${state}.`, targetPath);
	}
	if (enabled && state === 'enabled' || !enabled && state === 'disabled') {
		return {kind: 'noop', target, state};
	}

	const parked = await lstatIfPresent(parkedPath);
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

async function applyToggle(action: ToggleAction, canonicalPath: string): Promise<void> {
	switch (action.kind) {
		case 'noop':
			return;
		case 'create':
			await mkdir(dirname(action.targetPath), {recursive: true});
			await symlink(canonicalPath, action.targetPath);
			return;
		case 'restore':
			await mkdir(dirname(action.targetPath), {recursive: true});
			await rename(action.parkedPath, action.targetPath);
			return;
		case 'park':
			await mkdir(dirname(action.parkedPath), {recursive: true});
			await rename(action.targetPath, action.parkedPath);
	}
}

async function rollbackToggles(
	layout: Layout,
	name: string,
	completed: ReadonlyArray<ToggleAction>,
): Promise<ReadonlyArray<string>> {
	const recoveryPaths: string[] = [];
	const failedRoot = join(
		layout.amc.failed,
		`${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`,
	);

	for (const action of completed.toReversed()) {
		try {
			switch (action.kind) {
				case 'noop':
					break;
				case 'create': {
					const failedPath = join(failedRoot, action.target, name);
					await mkdir(dirname(failedPath), {recursive: true});
					await rename(action.targetPath, failedPath);
					break;
				}
				case 'restore':
					await rename(action.targetPath, action.parkedPath);
					break;
				case 'park':
					await rename(action.parkedPath, action.targetPath);
			}
		} catch {
			if (action.kind !== 'noop') {
				recoveryPaths.push(action.targetPath);
			}
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

	const actions = await Promise.all(
		[...new Set(selectedTargets)].map(target => planToggle(layout, name, enabled, target)),
	);
	const completed: ToggleAction[] = [];

	try {
		for (const action of actions) {
			await applyToggle(action, canonicalPath);
			completed.push(action);
		}
		for (const action of actions) {
			const state = await classifyTargetPath(join(layout.targets[action.target], name), canonicalPath);
			if (state !== (enabled ? 'enabled' : 'disabled')) {
				throw new Error(`Verification failed for ${action.target}.`);
			}
		}
	} catch (error: unknown) {
		const recoveryPaths = await rollbackToggles(layout, name, completed);
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

	return {name, changes: actions.map(action => toggleChange(action, enabled))};
}

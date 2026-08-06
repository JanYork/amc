import {constants, type Stats} from 'node:fs';
import {createHash, type Hash, randomUUID} from 'node:crypto';
import {copyFile, cp, lstat, mkdir, readFile, readdir, readlink, rename, symlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {AmcError, type BulkMigrationFailure, type BulkMigrationItem, type BulkMigrationPlan, type BulkMigrationResult, type BulkMigrationStatus, type Layout, type MigrationBackup, type MigrationBlocker, type MigrationCanonical, type MigrationPlan, type MigrationResult, type MigrationSource, type MigrationTarget, type Target} from '../model.js';
import {targets} from '../layout.js';
import {hasErrorCode, isOwnedLink, isSkillDirectory, listSkills, observeTargetPath, readDirectory, validateSkillName} from './scan.js';

export type OperationRoot = Readonly<{path: string}>;

export function createOperationId(): string {
	return `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
}

export async function createOperationRoot(parent: string, operationId: string): Promise<OperationRoot> {
	await mkdir(parent, {recursive: true});
	const path = join(parent, operationId);
	await mkdir(path);
	return {path};
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

export async function movePathExclusive(sourcePath: string, destinationPath: string): Promise<void> {
	await mkdir(dirname(destinationPath), {recursive: true});
	if (await lstatIfPresent(destinationPath) !== undefined) {
		throw new Error(`Operation destination already exists: ${destinationPath}`);
	}
	await rename(sourcePath, destinationPath);
}

export async function moveIntoOperationRoot(
	sourcePath: string,
	root: OperationRoot,
	relativeParts: ReadonlyArray<string>,
): Promise<string> {
	const destinationPath = join(root.path, ...relativeParts);
	await movePathExclusive(sourcePath, destinationPath);
	return destinationPath;
}


function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function updateFingerprint(hash: Hash, kind: string, path: string, content: string | Uint8Array): void {
	hash.update(kind);
	hash.update('\0');
	hash.update(path);
	hash.update('\0');
	hash.update(String(content.length));
	hash.update('\0');
	hash.update(content);
	hash.update('\0');
}

async function fingerprintEntry(hash: Hash, path: string, relativePath: string): Promise<void> {
	const entry = await lstat(path);
	if (entry.isDirectory()) {
		updateFingerprint(hash, `directory:${entry.mode & 0o777}`, relativePath, '');
		const children = [...await readDirectory(path)].sort((left, right) =>
			compareCodePoints(left.name, right.name));
		for (const child of children) {
			const childRelativePath = relativePath.length === 0
				? child.name
				: `${relativePath}/${child.name}`;
			await fingerprintEntry(hash, join(path, child.name), childRelativePath);
		}
		return;
	}
	if (entry.isFile()) {
		updateFingerprint(hash, `file:${entry.mode & 0o777}`, relativePath, await readFile(path));
		return;
	}
	if (entry.isSymbolicLink()) {
		updateFingerprint(hash, 'symlink', relativePath, await readlink(path));
		return;
	}
	throw new AmcError('MIGRATION_BLOCKED', 'Unsupported filesystem entry in Skill.', path);
}

export async function fingerprintDirectory(path: string): Promise<string> {
	const root = await lstatIfPresent(path);
	if (!root?.isDirectory()) {
		throw new AmcError('MIGRATION_BLOCKED', 'Migration source is not a directory.', path);
	}
	const hash = createHash('sha256');
	await fingerprintEntry(hash, path, '');
	return hash.digest('hex');
}

export async function copyDirectoryContentsExclusive(source: string, destination: string): Promise<void> {
	const children = [...await readdir(source, {withFileTypes: true})]
		.sort((left, right) => compareCodePoints(left.name, right.name));

	for (const child of children) {
		const sourcePath = join(source, child.name);
		const destinationPath = join(destination, child.name);
		const entry = await lstat(sourcePath);
		if (entry.isDirectory()) {
			await mkdir(destinationPath);
			await copyDirectoryContentsExclusive(sourcePath, destinationPath);
			continue;
		}
		if (entry.isFile()) {
			await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
			continue;
		}
		if (entry.isSymbolicLink()) {
			await symlink(await readlink(sourcePath), destinationPath);
			continue;
		}
		throw new AmcError('MIGRATION_BLOCKED', 'Unsupported filesystem entry in staging.', sourcePath);
	}
}

export async function planMigration(layout: Layout, name: string): Promise<MigrationPlan> {
	validateSkillName(name);
	const canonicalPath = join(layout.amc.skills, name);
	const canonicalEntry = await lstatIfPresent(canonicalPath);
	let canonical: MigrationCanonical;
	const blockers: MigrationBlocker[] = [];

	if (canonicalEntry === undefined) {
		canonical = {state: 'missing', path: canonicalPath};
	} else if (await isSkillDirectory(canonicalPath)) {
		canonical = {
			state: 'valid',
			path: canonicalPath,
			fingerprint: await fingerprintDirectory(canonicalPath),
		};
	} else {
		canonical = {state: 'conflict', path: canonicalPath};
		blockers.push({
			code: 'CANONICAL_CONFLICT',
			path: canonicalPath,
			message: 'Canonical path exists but is not a valid Skill.',
		});
	}

	const targetSnapshots: MigrationTarget[] = [];
	const sources: MigrationSource[] = [];
	for (const target of targets) {
		const path = join(layout.targets[target], name);
		const observation = await observeTargetPath(path, canonicalPath, canonical.state === 'valid');
		switch (observation.state) {
			case 'disabled':
				targetSnapshots.push({target, state: observation.state, path});
				break;
			case 'enabled':
				targetSnapshots.push({target, state: observation.state, path, linkText: observation.linkText});
				break;
			case 'unmanaged': {
				const fingerprint = await fingerprintDirectory(observation.contentPath);
				targetSnapshots.push({
					target,
					state: observation.state,
					path,
					kind: observation.kind,
					contentPath: observation.contentPath,
					linkText: observation.linkText,
					fingerprint,
				});
				sources.push({
					target,
					path,
					contentPath: observation.contentPath,
					kind: observation.kind,
					linkText: observation.linkText,
					fingerprint,
				});
				break;
			}
			case 'conflict':
				targetSnapshots.push({
					target,
					state: observation.state,
					path,
					kind: observation.kind,
					contentPath: observation.contentPath,
					linkText: observation.linkText,
				});
				if (observation.kind === 'invalid') {
					blockers.push({
						code: 'TARGET_CONFLICT',
						path,
						message: `Target ${target} contains a blocking entry.`,
					});
				}
				break;
		}
	}

	if (canonical.state === 'valid') {
		for (const source of sources) {
			if (source.fingerprint !== canonical.fingerprint) {
				blockers.push({
					code: 'CANONICAL_DIFFERENCE',
					path: source.path,
					message: `Target ${source.target} differs from the canonical Skill.`,
				});
			}
		}
	} else if (canonical.state === 'missing' && sources.length === 0) {
		blockers.push({
			code: 'NO_SOURCE',
			path: canonicalPath,
			message: 'No valid unmanaged source exists for migration.',
		});
	}
	if (canonical.state !== 'valid' && sources.length === 0) {
		for (const target of targetSnapshots) {
			if (target.state === 'conflict' && target.kind === 'broken-link') {
				blockers.push({
					code: 'TARGET_CONFLICT',
					path: target.path,
					message: `Target ${target.target} contains a broken link without a valid same-name source.`,
				});
			}
		}
	}

	const distinctFingerprints = new Set(sources.map(source => source.fingerprint));
	return {
		name,
		canonical,
		targets: targetSnapshots,
		sources,
		blockers,
		sourceRequired: canonical.state === 'missing' && distinctFingerprints.size > 1,
	};
}

function isArchivableTarget(target: MigrationTarget): boolean {
	return target.state === 'unmanaged'
		|| (target.state === 'conflict' && target.kind === 'broken-link');
}

function bulkMigrationStatus(plan: MigrationPlan): BulkMigrationStatus {
	const hasHardBlocker = plan.blockers.some(blocker => blocker.code !== 'CANONICAL_DIFFERENCE');
	if (hasHardBlocker) {
		return 'blocked';
	}
	if (plan.sourceRequired || plan.blockers.some(blocker => blocker.code === 'CANONICAL_DIFFERENCE')) {
		return 'divergent';
	}
	return plan.targets.some(isArchivableTarget) ? 'ready' : 'managed';
}

export async function planBulkMigration(layout: Layout): Promise<BulkMigrationPlan> {
	const scan = await listSkills(layout);
	const items: BulkMigrationItem[] = [];
	for (const skill of scan.skills) {
		const plan = await planMigration(layout, skill.name);
		items.push({name: skill.name, status: bulkMigrationStatus(plan), plan});
	}
	return {items, diagnostics: scan.diagnostics};
}

function migrationPlansMatch(left: MigrationPlan, right: MigrationPlan): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sourceForTarget(plan: MigrationPlan, target: Target): MigrationSource | undefined {
	return plan.sources.find(source => source.target === target);
}

async function recoverMigration(
	layout: Layout,
	name: string,
	operationId: string,
	stagePath: string,
	canonicalCreated: boolean,
	backups: ReadonlyArray<MigrationBackup>,
	linkedTargets: ReadonlyArray<Target>,
): Promise<ReadonlyArray<string>> {
	const recoveryPaths: string[] = [];
	const stageExists = await lstatIfPresent(stagePath) !== undefined;
	const needsFailedRoot = linkedTargets.length > 0 || canonicalCreated || stageExists;
	let failedRoot: OperationRoot | undefined;
	if (needsFailedRoot) {
		try {
			failedRoot = await createOperationRoot(layout.amc.failed, operationId);
		} catch {
			recoveryPaths.push(join(layout.amc.failed, operationId));
		}
	}

	for (const target of linkedTargets.toReversed()) {
		const activePath = join(layout.targets[target], name);
		try {
			if (failedRoot === undefined) {
				recoveryPaths.push(activePath);
				continue;
			}
			await moveIntoOperationRoot(activePath, failedRoot, ['links', target, name]);
		} catch {
			recoveryPaths.push(activePath);
		}
	}

	const canonicalPath = join(layout.amc.skills, name);
	if (canonicalCreated && await lstatIfPresent(canonicalPath) !== undefined) {
		try {
			if (failedRoot === undefined) {
				recoveryPaths.push(canonicalPath);
			} else {
				await moveIntoOperationRoot(canonicalPath, failedRoot, ['canonical', name]);
			}
		} catch {
			recoveryPaths.push(canonicalPath);
		}
	}

	if (stageExists) {
		try {
			if (failedRoot === undefined) {
				recoveryPaths.push(stagePath);
			} else {
				await moveIntoOperationRoot(stagePath, failedRoot, ['staging', name]);
			}
		} catch {
			recoveryPaths.push(stagePath);
		}
	}

	for (const backup of backups.toReversed()) {
		const originalPath = join(layout.targets[backup.target], name);
		if (await lstatIfPresent(originalPath) !== undefined) {
			recoveryPaths.push(backup.path, originalPath);
			continue;
		}
		try {
			const backupEntry = await lstat(backup.path);
			if (backupEntry.isSymbolicLink()) {
				await mkdir(dirname(originalPath), {recursive: true});
				const linkText = await readlink(backup.path);
				await symlink(linkText, originalPath);
				if (await readlink(originalPath) !== linkText) {
					throw new Error('Restored migration link differs from backup.');
				}
			} else if (backupEntry.isDirectory()) {
				await mkdir(originalPath);
				await copyDirectoryContentsExclusive(backup.path, originalPath);
				if (await fingerprintDirectory(originalPath) !== await fingerprintDirectory(backup.path)) {
					throw new Error('Restored migration source fingerprint differs from backup.');
				}
			} else {
				throw new Error('Migration backup is neither a directory nor a symbolic link.');
			}
		} catch {
			recoveryPaths.push(backup.path, originalPath);
		}
	}

	return recoveryPaths;
}

export async function executeMigration(
	layout: Layout,
	plan: MigrationPlan,
	sourceTarget?: Target,
): Promise<MigrationResult> {
	if (plan.blockers.length > 0) {
		const blocker = plan.blockers[0];
		throw new AmcError(
			'MIGRATION_BLOCKED',
			blocker?.message ?? 'Migration is blocked.',
			blocker?.path ?? join(layout.amc.skills, plan.name),
		);
	}
	if (sourceTarget !== undefined && sourceForTarget(plan, sourceTarget) === undefined) {
		throw new AmcError(
			'SOURCE_INVALID',
			`Target ${sourceTarget} is not a valid migration source.`,
			join(layout.targets[sourceTarget], plan.name),
		);
	}
	if (plan.sourceRequired && sourceTarget === undefined) {
		throw new AmcError(
			'SOURCE_REQUIRED',
			'Migration sources differ; choose one source target.',
			join(layout.amc.skills, plan.name),
		);
	}
	if (!migrationPlansMatch(plan, await planMigration(layout, plan.name))) {
		throw new AmcError('STALE_PLAN', 'Migration plan is stale; review a fresh plan.', plan.canonical.path);
	}

	let selectedSource: MigrationSource | undefined;
	if (plan.canonical.state === 'missing') {
		selectedSource = sourceTarget === undefined ? plan.sources[0] : sourceForTarget(plan, sourceTarget);
		if (selectedSource === undefined) {
			throw new AmcError('SOURCE_REQUIRED', 'Migration needs a valid source.', plan.canonical.path);
		}
	}

	const operationId = createOperationId();
	const stagePath = join(layout.amc.staging, operationId, plan.name);
	const backups: MigrationBackup[] = [];
	const linkedTargets: Target[] = [];
	let canonicalCreated = false;
	let backupRoot: OperationRoot | undefined;

	try {
		const stageRoot = selectedSource === undefined
			? undefined
			: await createOperationRoot(layout.amc.staging, operationId);
		backupRoot = !plan.targets.some(isArchivableTarget)
			? undefined
			: await createOperationRoot(layout.amc.backups, operationId);
		if (selectedSource !== undefined) {
			if (stageRoot === undefined) {
				throw new Error('Migration staging root was not claimed.');
			}
			await cp(selectedSource.contentPath, stagePath, {
				recursive: true,
				force: false,
				errorOnExist: true,
				verbatimSymlinks: true,
			});
			if (await fingerprintDirectory(stagePath) !== selectedSource.fingerprint) {
				throw new AmcError('MIGRATION_FAILED', 'Staging fingerprint differs from source.', stagePath);
			}
		}

		if (!migrationPlansMatch(plan, await planMigration(layout, plan.name))) {
			throw new AmcError('STALE_PLAN', 'Migration plan changed during staging.', plan.canonical.path);
		}

		if (plan.targets.some(isArchivableTarget) && backupRoot === undefined) {
			throw new Error('Migration backup root was not claimed.');
		}
		for (const target of plan.targets) {
			if (!isArchivableTarget(target)) {
				continue;
			}
			if (backupRoot === undefined) {
				throw new Error('Migration backup root was not claimed.');
			}
			const backupPath = await moveIntoOperationRoot(
				target.path,
				backupRoot,
				[target.target, plan.name],
			);
			backups.push({target: target.target, path: backupPath});
		}

		if (plan.canonical.state === 'missing') {
			await mkdir(layout.amc.skills, {recursive: true});
			await mkdir(plan.canonical.path);
			canonicalCreated = true;
			await copyDirectoryContentsExclusive(stagePath, plan.canonical.path);
			if (await fingerprintDirectory(plan.canonical.path) !== selectedSource?.fingerprint) {
				throw new AmcError(
					'MIGRATION_FAILED',
					'Canonical fingerprint differs from verified staging.',
					plan.canonical.path,
				);
			}
			if (backupRoot === undefined) {
				throw new Error('Migration backup root was not claimed.');
			}
			await moveIntoOperationRoot(stagePath, backupRoot, ['staging', plan.name]);
		}

		for (const backup of backups) {
			const targetPath = join(layout.targets[backup.target], plan.name);
			await mkdir(dirname(targetPath), {recursive: true});
			await symlink(plan.canonical.path, targetPath);
			linkedTargets.push(backup.target);
		}
		for (const target of linkedTargets) {
			if (!(await isOwnedLink(join(layout.targets[target], plan.name), plan.canonical.path))) {
				throw new AmcError(
					'MIGRATION_FAILED',
					`Migration link verification failed for ${target}.`,
					join(layout.targets[target], plan.name),
				);
			}
		}
	} catch (error: unknown) {
		const recoveryPaths = await recoverMigration(
			layout,
			plan.name,
			operationId,
			stagePath,
			canonicalCreated,
			backups,
			linkedTargets,
		);
		if (recoveryPaths.length > 0) {
			throw new AmcError(
				'ROLLBACK_FAILED',
				`Migration needs manual recovery at: ${recoveryPaths.join(', ')}`,
				recoveryPaths[0] ?? plan.canonical.path,
			);
		}
		if (error instanceof AmcError) {
			throw error;
		}
		const detail = error instanceof Error ? error.message : 'Unknown filesystem failure.';
		throw new AmcError('MIGRATION_FAILED', `Migration failed: ${detail}`, plan.canonical.path);
	}

	return {
		operationId,
		name: plan.name,
		canonicalPath: plan.canonical.path,
		backupRoot: backupRoot?.path,
		backups,
		linkedTargets,
	};
}

function bulkFailure(layout: Layout, name: string, error: unknown): BulkMigrationFailure {
	if (error instanceof AmcError) {
		return {name, code: error.code, message: error.message, path: error.path};
	}
	return {
		name,
		code: 'UNEXPECTED',
		message: error instanceof Error ? error.message : 'Unexpected bulk migration failure.',
		path: join(layout.amc.skills, name),
	};
}

function bulkNames(plan: BulkMigrationPlan, status: BulkMigrationStatus): string[] {
	return plan.items.filter(item => item.status === status).map(item => item.name);
}

export async function executeBulkMigration(
	layout: Layout,
	plan: BulkMigrationPlan,
): Promise<BulkMigrationResult> {
	const ready = plan.items.filter(item => item.status === 'ready');
	const managed = bulkNames(plan, 'managed');
	const divergent = bulkNames(plan, 'divergent');
	const blocked = bulkNames(plan, 'blocked');
	const migrated: MigrationResult[] = [];
	for (const [index, item] of ready.entries()) {
		try {
			migrated.push(await executeMigration(layout, item.plan));
		} catch (error: unknown) {
			return {
				migrated,
				managed,
				divergent,
				blocked,
				pending: ready.slice(index + 1).map(candidate => candidate.name),
				diagnostics: plan.diagnostics,
				failure: bulkFailure(layout, item.name, error),
			};
		}
	}

	return {
		migrated,
		managed,
		divergent,
		blocked,
		pending: [],
		diagnostics: plan.diagnostics,
		failure: undefined,
	};
}

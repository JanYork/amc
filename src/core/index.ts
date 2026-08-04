import {constants, type Dirent, type Stats} from 'node:fs';
import {createHash, type Hash, randomUUID} from 'node:crypto';
import {
	access,
	copyFile,
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	readlink,
	rename,
	stat,
	symlink,
} from 'node:fs/promises';
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
	operationId: string;
	name: string;
	changes: ReadonlyArray<TargetChange>;
}>;

export type MigrationSource = Readonly<{
	target: Target;
	path: string;
	contentPath: string;
	kind: 'directory' | 'foreign-link';
	fingerprint: string;
}>;

export type MigrationBlocker = Readonly<{
	code: 'CANONICAL_CONFLICT' | 'CANONICAL_DIFFERENCE' | 'TARGET_CONFLICT' | 'NO_SOURCE';
	path: string;
	message: string;
}>;

export type MigrationCanonical =
	| Readonly<{state: 'missing'; path: string}>
	| Readonly<{state: 'valid'; path: string; fingerprint: string}>
	| Readonly<{state: 'conflict'; path: string}>;

export type MigrationTarget =
	| Readonly<{target: Target; state: 'disabled' | 'enabled' | 'conflict'; path: string}>
	| Readonly<{target: Target; state: 'unmanaged'; path: string; fingerprint: string}>;

export type MigrationPlan = Readonly<{
	name: string;
	canonical: MigrationCanonical;
	targets: ReadonlyArray<MigrationTarget>;
	sources: ReadonlyArray<MigrationSource>;
	blockers: ReadonlyArray<MigrationBlocker>;
	sourceRequired: boolean;
}>;

export type MigrationBackup = Readonly<{
	target: Target;
	path: string;
}>;

export type MigrationResult = Readonly<{
	operationId: string;
	name: string;
	canonicalPath: string;
	backups: ReadonlyArray<MigrationBackup>;
	linkedTargets: ReadonlyArray<Target>;
}>;

export type AmcErrorCode =
	| 'INVALID_SKILL_NAME'
	| 'CANONICAL_MISSING'
	| 'TARGET_BLOCKED'
	| 'PARKING_BLOCKED'
	| 'OPERATION_FAILED'
	| 'ROLLBACK_FAILED'
	| 'SOURCE_REQUIRED'
	| 'SOURCE_INVALID'
	| 'MIGRATION_BLOCKED'
	| 'STALE_PLAN'
	| 'MIGRATION_FAILED';

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

type TargetObservation =
	| Readonly<{state: 'disabled'}>
	| Readonly<{state: 'enabled'}>
	| Readonly<{
		state: 'unmanaged';
		kind: 'directory' | 'foreign-link';
		contentPath: string;
	}>
	| Readonly<{state: 'conflict'; kind: 'broken-link' | 'invalid'}>;

type TargetScan = Readonly<{
	entries: ReadonlyMap<string, TargetEntry>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>;

type ToggleAction =
	| Readonly<{kind: 'noop'; target: Target; state: 'enabled' | 'disabled'}>
	| Readonly<{kind: 'create'; target: Target; targetPath: string}>
	| Readonly<{kind: 'restore'; target: Target; targetPath: string; parkedPath: string}>
	| Readonly<{kind: 'park'; target: Target; targetPath: string; parkedPath: string}>;

type ToggleStep =
	| Readonly<{kind: 'created'; target: Target; path: string}>
	| Readonly<{kind: 'archived'; target: Target; fromPath: string; archivePath: string}>;

type OperationRoot = Readonly<{path: string}>;

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

function createOperationId(): string {
	return `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
}

async function createOperationRoot(parent: string, operationId: string): Promise<OperationRoot> {
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

async function moveIntoOperationRoot(
	sourcePath: string,
	root: OperationRoot,
	relativeParts: ReadonlyArray<string>,
): Promise<string> {
	const destinationPath = join(root.path, ...relativeParts);
	await mkdir(dirname(destinationPath), {recursive: true});
	if (await lstatIfPresent(destinationPath) !== undefined) {
		throw new Error(`Operation destination already exists: ${destinationPath}`);
	}
	await rename(sourcePath, destinationPath);
	return destinationPath;
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

async function observeTargetPath(
	path: string,
	canonicalPath: string,
	canonicalValid: boolean,
): Promise<TargetObservation> {
	const entry = await lstatIfPresent(path);
	if (entry === undefined) {
		return {state: 'disabled'};
	}
	if (entry.isSymbolicLink()) {
		const contentPath = resolve(dirname(path), await readlink(path));
		if (contentPath === resolve(canonicalPath) && canonicalValid) {
			return {state: 'enabled'};
		}
		if (await isSkillDirectory(contentPath)) {
			return {state: 'unmanaged', kind: 'foreign-link', contentPath};
		}
		return {state: 'conflict', kind: 'broken-link'};
	}
	if (entry.isDirectory() && await isSkillDirectory(path)) {
		return {state: 'unmanaged', kind: 'directory', contentPath: path};
	}
	return {state: 'conflict', kind: 'invalid'};
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
		const observation = await observeTargetPath(
			entryPath,
			join(canonicalPath, entry.name),
			canonicalNames.has(entry.name),
		);
		switch (observation.state) {
			case 'disabled':
				continue;
			case 'enabled':
			case 'unmanaged':
				entries.set(entry.name, {state: observation.state, visible: true});
				continue;
			case 'conflict':
				entries.set(entry.name, {state: 'conflict', visible: false});
				diagnostics.push({
					path: entryPath,
					message: observation.kind === 'broken-link'
						? 'Target symlink does not resolve to a valid Skill directory.'
						: 'Target entry is not a valid Skill directory.',
				});
		}
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

	const skills = [...names].sort(compareCodePoints).map(name => ({
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
	].sort((left, right) => compareCodePoints(left.path, right.path));

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
	return (await observeTargetPath(path, canonicalPath, await isSkillDirectory(canonicalPath))).state;
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
		const needsArchive = actions.some(action => action.kind === 'restore' || action.kind === 'park');
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
		updateFingerprint(hash, 'directory', relativePath, '');
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
		updateFingerprint(hash, 'file', relativePath, await readFile(path));
		return;
	}
	if (entry.isSymbolicLink()) {
		updateFingerprint(hash, 'symlink', relativePath, await readlink(path));
		return;
	}
	throw new AmcError('MIGRATION_BLOCKED', 'Unsupported filesystem entry in Skill.', path);
}

async function fingerprintDirectory(path: string): Promise<string> {
	const root = await lstatIfPresent(path);
	if (!root?.isDirectory()) {
		throw new AmcError('MIGRATION_BLOCKED', 'Migration source is not a directory.', path);
	}
	const hash = createHash('sha256');
	await fingerprintEntry(hash, path, '');
	return hash.digest('hex');
}

async function copyDirectoryContentsExclusive(source: string, destination: string): Promise<void> {
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
		if (observation.state === 'unmanaged') {
			const fingerprint = await fingerprintDirectory(observation.contentPath);
			targetSnapshots.push({target, state: observation.state, path, fingerprint});
			sources.push({
				target,
				path,
				contentPath: observation.contentPath,
				kind: observation.kind,
				fingerprint,
			});
		} else {
			targetSnapshots.push({target, state: observation.state, path});
			if (observation.state === 'conflict') {
				blockers.push({
					code: 'TARGET_CONFLICT',
					path,
					message: `Target ${target} contains a blocking entry.`,
				});
			}
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

	try {
		const stageRoot = selectedSource === undefined
			? undefined
			: await createOperationRoot(layout.amc.staging, operationId);
		const backupRoot = plan.sources.length === 0
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

		if (plan.sources.length > 0 && backupRoot === undefined) {
			throw new Error('Migration backup root was not claimed.');
		}
		for (const source of plan.sources) {
			if (backupRoot === undefined) {
				throw new Error('Migration backup root was not claimed.');
			}
			const backupPath = await moveIntoOperationRoot(
				source.path,
				backupRoot,
				[source.target, plan.name],
			);
			backups.push({target: source.target, path: backupPath});
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

		for (const source of plan.sources) {
			await mkdir(dirname(source.path), {recursive: true});
			await symlink(plan.canonical.path, source.path);
			linkedTargets.push(source.target);
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
		backups,
		linkedTargets,
	};
}

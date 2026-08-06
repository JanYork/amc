import {createHash} from 'node:crypto';
import {mkdir, readFile, symlink} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {
	type Layout,
	type ReconcileBlocker,
	type ReconcileCanonical,
	type ReconcileChoice,
	AmcError,
	type ReconcileHooks,
	type ReconciliationFailure,
	type ReconciliationPlan,
	type ReconciliationResult,
	type ReconcileSource,
	type SkillReconcilePlan,
	type SkillReconcileResult,
	type SkillSource,
	type Target,
} from '../model.js';
import {atomicReplace} from '../resources/persistence.js';
import {createOperationId, createOperationRoot, fingerprintDirectory, movePathExclusive} from './migration.js';
import {isOwnedLink, isSkillDirectory, listSkills, lstatIfPresent, observeTargetPath, readDirectory, validateSkillName} from './scan.js';

const sourceOrder: ReadonlyArray<SkillSource> = ['agents', 'agent', 'claude', 'pi', 'codex'];
const providerOrder: ReadonlyArray<Target> = ['claude', 'pi', 'codex'];

function providersFor(source: SkillSource): ReadonlyArray<Target> {
	return source === 'agents' || source === 'agent' ? ['pi', 'codex'] : [source];
}

function sortedProviders(sources: ReadonlyArray<ReconcileSource>): ReadonlyArray<Target> {
	const providers = new Set(sources.flatMap(source => source.providers));
	return providerOrder.filter(provider => providers.has(provider));
}

function sourceBlocker(source: ReconcileSource): ReconcileBlocker | undefined {
	switch (source.kind) {
		case 'foreign-link':
			return {code: 'FOREIGN_LINK', path: source.path, message: 'Automatic reconciliation does not move a foreign link target.'};
		case 'broken-link':
		case 'invalid':
			return {code: 'SOURCE_CONFLICT', path: source.path, message: `Skill source is ${source.kind}.`};
		case 'directory':
		case 'managed-link':
			return undefined;
	}
}

async function observeSource(
	layout: Layout,
	name: string,
	source: SkillSource,
	canonicalValid: boolean,
): Promise<ReconcileSource | undefined> {
	const path = join(layout.sources[source], name);
	const observation = await observeTargetPath(path, join(layout.amc.skills, name), canonicalValid);
	switch (observation.state) {
		case 'disabled':
			return undefined;
		case 'enabled':
			return {source, path, kind: 'managed-link', fingerprint: undefined, providers: providersFor(source)};
		case 'unmanaged':
			return observation.kind === 'directory'
				? {source, path, kind: 'directory', fingerprint: await fingerprintDirectory(path), providers: providersFor(source)}
				: {source, path, kind: 'foreign-link', fingerprint: undefined, providers: providersFor(source)};
		case 'conflict':
			return {
				source,
				path,
				kind: observation.kind === 'broken-link' ? 'broken-link' : 'invalid',
				fingerprint: undefined,
				providers: providersFor(source),
			};
	}
}

export async function planSkillReconciliation(layout: Layout, name: string): Promise<SkillReconcilePlan> {
	validateSkillName(name);
	const canonicalPath = join(layout.amc.skills, name);
	const canonicalEntry = await lstatIfPresent(canonicalPath);
	const canonicalValid = await isSkillDirectory(canonicalPath);
	const sources: ReconcileSource[] = [];
	for (const source of sourceOrder) {
		const observation = await observeSource(layout, name, source, canonicalValid);
		if (observation !== undefined) sources.push(observation);
	}

	const directorySources = sources.filter(source => source.kind === 'directory');
	const canonicalFingerprint = canonicalValid && directorySources.length > 0
		? await fingerprintDirectory(canonicalPath)
		: undefined;
	const canonical: ReconcileCanonical = canonicalEntry === undefined
		? {state: 'missing', path: canonicalPath, fingerprint: undefined}
		: canonicalValid
			? {state: 'valid', path: canonicalPath, fingerprint: canonicalFingerprint}
			: {state: 'conflict', path: canonicalPath, fingerprint: undefined};
	const blockers: ReconcileBlocker[] = [];
	if (canonical.state === 'conflict') {
		blockers.push({code: 'CANONICAL_CONFLICT', path: canonical.path, message: 'Canonical path is not a valid Skill directory.'});
	}
	for (const source of sources) {
		const blocker = sourceBlocker(source);
		if (blocker !== undefined) blockers.push(blocker);
	}
	const homeEntry = await lstatIfPresent(layout.home);
	if (homeEntry !== undefined) {
		for (const source of directorySources) {
			const sourceEntry = await lstatIfPresent(source.path);
			if (sourceEntry !== undefined && sourceEntry.dev !== homeEntry.dev) {
				blockers.push({code: 'CROSS_DEVICE', path: source.path, message: 'Automatic reconciliation requires a same-filesystem atomic move.'});
			}
		}
	}
	const fingerprints = new Set(directorySources.flatMap(source => source.fingerprint === undefined ? [] : [source.fingerprint]));
	const diverged = fingerprints.size > 1
		|| canonicalFingerprint !== undefined && [...fingerprints].some(fingerprint => fingerprint !== canonicalFingerprint);
	if (diverged) {
		blockers.push({code: 'CONTENT_DIVERGENCE', path: canonicalPath, message: 'Same-name Skill sources contain different content.'});
	}
	if (canonical.state === 'missing' && directorySources.length === 0 && blockers.length === 0) {
		blockers.push({code: 'NO_SOURCE', path: canonicalPath, message: 'No movable Skill source exists.'});
	}
	const hardBlocked = blockers.some(blocker => blocker.code !== 'CONTENT_DIVERGENCE');
	const needsWork = directorySources.length > 0
		|| sources.some(source => (source.source === 'agents' || source.source === 'agent') && source.kind === 'managed-link');
	const status = hardBlocked ? 'blocked' : diverged ? 'conflict' : needsWork ? 'ready' : 'managed';
	const selectedSource = status === 'ready' && canonical.state === 'missing'
		? directorySources[0]?.source
		: undefined;

	return {
		name,
		status,
		canonical,
		sources,
		providers: sortedProviders(sources),
		selectedSource,
		blockers,
	};
}

type MoveStep = Readonly<{from: string; to: string}>;
type ReconcileJournal = Readonly<{
	schemaVersion: 1;
	operationId: string;
	name: string;
	planDigest: string;
	moves: ReadonlyArray<MoveStep>;
	links: ReadonlyArray<Target>;
	moved: number;
	linked: number;
}>;

function digestPlan(plan: SkillReconcilePlan): string {
	return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

async function writeJournal(path: string, journal: ReconcileJournal): Promise<void> {
	await atomicReplace(path, `${JSON.stringify(journal, undefined, 2)}\n`, 0o600);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJournal(layout: Layout, path: string, text: string): ReconcileJournal {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['moves']) || !Array.isArray(value['links'])) {
		throw new Error('INVALID_RECONCILE_JOURNAL');
	}
	const operationId = value['operationId'];
	const name = value['name'];
	const planDigest = value['planDigest'];
	const moved = value['moved'];
	const linked = value['linked'];
	if (typeof operationId !== 'string' || operationId.length === 0 || operationId === '.' || operationId === '..'
		|| operationId.includes('/') || operationId.includes('\\') || /[\u0000-\u001f\u007f]/u.test(operationId)
		|| typeof name !== 'string' || typeof planDigest !== 'string' || planDigest.length === 0
		|| !Number.isInteger(moved) || !Number.isInteger(linked)
		|| path !== join(layout.amc.reconcileJournals, `${operationId}.json`)) {
		throw new Error('INVALID_RECONCILE_JOURNAL');
	}
	validateSkillName(name);
	const canonicalPath = join(layout.amc.skills, name);
	const canonicalBackup = join(layout.amc.backups, operationId, 'sources', 'canonical', name);
	const moves: MoveStep[] = [];
	for (const item of value['moves']) {
		if (!isRecord(item) || typeof item['from'] !== 'string' || typeof item['to'] !== 'string') {
			throw new Error('INVALID_RECONCILE_JOURNAL');
		}
		const validPair = item['from'] === canonicalPath && item['to'] === canonicalBackup
			|| sourceOrder.some(source => item['from'] === join(layout.sources[source], name)
				&& (item['to'] === canonicalPath || item['to'] === join(layout.amc.backups, operationId, 'sources', source, name)));
		if (!validPair) throw new Error('INVALID_RECONCILE_JOURNAL');
		moves.push({from: item['from'], to: item['to']});
	}
	const links: Target[] = [];
	for (const item of value['links']) {
		if (item !== 'claude' && item !== 'pi' && item !== 'codex') throw new Error('INVALID_RECONCILE_JOURNAL');
		links.push(item);
	}
	if (typeof moved !== 'number' || typeof linked !== 'number' || moved < 0 || moved > moves.length || linked < 0 || linked > links.length) {
		throw new Error('INVALID_RECONCILE_JOURNAL');
	}
	return {schemaVersion: 1, operationId, name, planDigest, moves, links, moved, linked};
}

async function recoverJournal(layout: Layout, journalPath: string, journal: ReconcileJournal): Promise<ReadonlyArray<string>> {
	const recoveryPaths: string[] = [];
	let failedRoot: string | undefined;
	try {
		failedRoot = (await createOperationRoot(layout.amc.failed, journal.operationId)).path;
	} catch {
		recoveryPaths.push(join(layout.amc.failed, journal.operationId));
	}
	for (const target of journal.links.toReversed()) {
		const path = join(layout.targets[target], journal.name);
		try {
			if (!(await isOwnedLink(path, join(layout.amc.skills, journal.name)))) continue;
			if (failedRoot === undefined) {
				recoveryPaths.push(path);
				continue;
			}
			await movePathExclusive(path, join(failedRoot, 'links', target, journal.name));
		} catch {
			recoveryPaths.push(path);
		}
	}
	for (const move of journal.moves.toReversed()) {
		try {
			const fromExists = await lstatIfPresent(move.from) !== undefined;
			const toExists = await lstatIfPresent(move.to) !== undefined;
			if (fromExists && !toExists) continue;
			if (!fromExists && toExists) {
				await movePathExclusive(move.to, move.from);
				continue;
			}
			recoveryPaths.push(move.from, move.to);
		} catch {
			recoveryPaths.push(move.from, move.to);
		}
	}
	try {
		if (failedRoot === undefined) {
			recoveryPaths.push(journalPath);
		} else if (await lstatIfPresent(journalPath) !== undefined) {
			await movePathExclusive(journalPath, join(failedRoot, 'reconcile-journal.json'));
		}
	} catch {
		recoveryPaths.push(journalPath);
	}
	return recoveryPaths;
}

export async function recoverIncompleteReconciliations(layout: Layout): Promise<Readonly<{
	recovered: ReadonlyArray<string>;
	failures: ReadonlyArray<string>;
}>> {
	const recovered: string[] = [];
	const failures: string[] = [];
	for (const entry of await readDirectory(layout.amc.reconcileJournals)) {
		if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
		const path = join(layout.amc.reconcileJournals, entry.name);
		try {
			const journal = parseJournal(layout, path, await readFile(path, 'utf8'));
			const recoveryPaths = await recoverJournal(layout, path, journal);
			if (recoveryPaths.length === 0) recovered.push(journal.name);
			else failures.push(...recoveryPaths);
		} catch {
			failures.push(path);
		}
	}
	return {recovered, failures};
}

export function canRepairSkillReconciliation(plan: SkillReconcilePlan): boolean {
	return plan.status === 'blocked'
		&& plan.canonical.state === 'valid'
		&& plan.blockers.length > 0
		&& plan.blockers.every(blocker => blocker.code === 'SOURCE_CONFLICT')
		&& plan.sources.some(source => source.kind === 'invalid' || source.kind === 'broken-link');
}

export async function executeSkillReconciliation(
	layout: Layout,
	plan: SkillReconcilePlan,
	source: ReconcileChoice | undefined = plan.selectedSource,
	hooks: ReconcileHooks = {},
): Promise<SkillReconcileResult> {
	const explicitConflict = plan.status === 'conflict'
		&& source !== undefined
		&& plan.blockers.every(blocker => blocker.code === 'CONTENT_DIVERGENCE');
	const explicitRepair = source === 'canonical' && canRepairSkillReconciliation(plan);
	const keepCanonical = (explicitConflict || explicitRepair) && source === 'canonical' && plan.canonical.state === 'valid';
	if (plan.status !== 'ready' && !explicitConflict && !explicitRepair) {
		throw new AmcError('RECONCILE_BLOCKED', `Skill reconciliation is ${plan.status}.`, plan.canonical.path);
	}
	if (JSON.stringify(plan) !== JSON.stringify(await planSkillReconciliation(layout, plan.name))) {
		throw new AmcError('STALE_RECONCILE_PLAN', 'Skill reconciliation plan is stale.', plan.canonical.path);
	}
	const selected = plan.canonical.state === 'missing' || explicitConflict && !keepCanonical
		? plan.sources.find(candidate => candidate.source === source && candidate.kind === 'directory')
		: undefined;
	if ((plan.canonical.state === 'missing' || explicitConflict && !keepCanonical) && selected === undefined) {
		throw new AmcError('SOURCE_REQUIRED', 'Reconciliation needs an exact directory source.', plan.canonical.path);
	}
	const links: Target[] = [];
	const preservedDisabled = new Set<Target>();
	for (const target of plan.providers) {
		const targetPath = join(layout.targets[target], plan.name);
		const parkedPath = join(layout.amc.disabledLinks, target, plan.name);
		const parkedEntry = await lstatIfPresent(parkedPath);
		if (parkedEntry !== undefined) {
			if (!(await isOwnedLink(parkedPath, plan.canonical.path))) {
				throw new AmcError('PARKING_BLOCKED', `Parked path for ${target} is not AMC-owned.`, parkedPath);
			}
			preservedDisabled.add(target);
			continue;
		}
		if (!(await isOwnedLink(targetPath, plan.canonical.path))) links.push(target);
	}
	const operationId = createOperationId();
	const backupRoot = await createOperationRoot(layout.amc.backups, operationId);
	const journalPath = join(layout.amc.reconcileJournals, `${operationId}.json`);
	const moves: MoveStep[] = [];
	if (explicitConflict && !keepCanonical && plan.canonical.state === 'valid') {
		moves.push({from: plan.canonical.path, to: join(backupRoot.path, 'sources', 'canonical', plan.name)});
	}
	for (const candidate of plan.sources) {
		const movable = candidate.kind === 'directory'
			|| (candidate.kind === 'managed-link' && (candidate.source === 'agents' || candidate.source === 'agent'))
			|| explicitRepair && (candidate.kind === 'invalid' || candidate.kind === 'broken-link');
		if (!movable) continue;
		moves.push({
			from: candidate.path,
			to: selected?.source === candidate.source
				? plan.canonical.path
				: join(backupRoot.path, 'sources', candidate.source, plan.name),
		});
	}
	let journal: ReconcileJournal = {
		schemaVersion: 1,
		operationId,
		name: plan.name,
		planDigest: digestPlan(plan),
		moves,
		links,
		moved: 0,
		linked: 0,
	};
	await writeJournal(journalPath, journal);
	try {
		for (const [index, move] of moves.entries()) {
			await movePathExclusive(move.from, move.to);
			journal = {...journal, moved: index + 1};
			await writeJournal(journalPath, journal);
			await hooks.afterMove?.(index);
		}
		for (const [index, target] of links.entries()) {
			const targetPath = join(layout.targets[target], plan.name);
			if (await lstatIfPresent(targetPath) !== undefined) {
				throw new AmcError('RECONCILE_FAILED', `Provider target remained occupied for ${target}.`, targetPath);
			}
			await mkdir(dirname(targetPath), {recursive: true});
			await symlink(plan.canonical.path, targetPath);
			journal = {...journal, linked: index + 1};
			await writeJournal(journalPath, journal);
			await hooks.afterLink?.(index);
		}
		for (const target of plan.providers) {
			const managed = await isOwnedLink(join(layout.targets[target], plan.name), plan.canonical.path)
				|| preservedDisabled.has(target) && await isOwnedLink(join(layout.amc.disabledLinks, target, plan.name), plan.canonical.path);
			if (!managed) {
				throw new AmcError('RECONCILE_FAILED', `Provider link verification failed for ${target}.`, join(layout.targets[target], plan.name));
			}
		}
		await movePathExclusive(journalPath, join(backupRoot.path, 'reconcile-journal.json'));
	} catch (error: unknown) {
		const recoveryPaths = await recoverJournal(layout, journalPath, journal);
		if (recoveryPaths.length > 0) {
			throw new AmcError('ROLLBACK_FAILED', `Reconciliation recovery needs attention at: ${recoveryPaths.join(', ')}`, recoveryPaths[0] ?? plan.canonical.path);
		}
		throw error;
	}
	return {
		operationId,
		name: plan.name,
		canonicalPath: plan.canonical.path,
		backupRoot: backupRoot.path,
		archivedSources: moves.filter(move => move.to !== plan.canonical.path).map(move => move.to),
		linkedTargets: links,
	};
}

export async function planReconciliation(layout: Layout): Promise<ReconciliationPlan> {
	const inventory = await listSkills(layout);
	const items: SkillReconcilePlan[] = [];
	const diagnostics = [...inventory.diagnostics];
	for (const skill of inventory.skills) {
		try {
			items.push(await planSkillReconciliation(layout, skill.name));
		} catch (error: unknown) {
			diagnostics.push({
				path: skill.name,
				message: error instanceof Error ? error.message : 'Skill reconciliation planning failed.',
			});
		}
	}
	return {items, diagnostics};
}

function reconciliationFailure(layout: Layout, name: string, error: unknown): ReconciliationFailure {
	return error instanceof AmcError
		? {name, code: error.code, message: error.message, path: error.path}
		: {
			name,
			code: 'UNEXPECTED',
			message: error instanceof Error ? error.message : 'Unexpected reconciliation failure.',
			path: join(layout.amc.skills, name),
		};
}

export async function executeReconciliation(
	layout: Layout,
	plan: ReconciliationPlan,
): Promise<ReconciliationResult> {
	const ready = plan.items.filter(item => item.status === 'ready');
	const reconciled: SkillReconcileResult[] = [];
	const managed = plan.items.filter(item => item.status === 'managed').map(item => item.name);
	const conflicts = plan.items.filter(item => item.status === 'conflict').map(item => item.name);
	const blocked = plan.items.filter(item => item.status === 'blocked').map(item => item.name);
	for (const [index, item] of ready.entries()) {
		try {
			reconciled.push(await executeSkillReconciliation(layout, item));
		} catch (error: unknown) {
			return {
				reconciled,
				managed,
				conflicts,
				blocked,
				pending: ready.slice(index + 1).map(candidate => candidate.name),
				diagnostics: plan.diagnostics,
				failure: reconciliationFailure(layout, item.name, error),
			};
		}
	}
	return {
		reconciled,
		managed,
		conflicts,
		blocked,
		pending: [],
		diagnostics: plan.diagnostics,
		failure: undefined,
	};
}

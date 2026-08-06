import {createHash} from 'node:crypto';
import {lstat, readFile, readlink, rm} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import type {Layout} from '../model.js';
import {targets} from '../layout.js';
import type {DeleteSlot, InstallationRecord, PermanentDeleteHooks, PermanentDeletePlan, PermanentDeleteResult} from '../marketplace/model.js';
import {atomicReplace, hasErrorCode} from '../resources/persistence.js';
import {createOperationId, fingerprintDirectory} from './migration.js';
import {isOwnedLink, lstatIfPresent, readDirectory, validateSkillName} from './scan.js';
import {readSkillsLock, writeSkillsLock} from './provenance.js';

type DeleteJournal = Readonly<{
	schemaVersion: 1;
	plan: PermanentDeletePlan;
	removed: ReadonlyArray<boolean>;
	provenanceRemoved: boolean;
}>;

function hash(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function safeSegment(value: string): boolean {
	return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}

function journalPath(layout: Layout, name: string): string {
	return join(layout.amc.deleteJournals, `${encodeURIComponent(name)}.json`);
}

async function snapshot(layout: Layout, path: string): Promise<DeleteSlot | undefined> {
	const entry = await lstatIfPresent(path);
	if (entry === undefined) return undefined;
	const relativePath = relative(layout.home, path);
	if (entry.isSymbolicLink()) return {relativePath, expectedKind: 'symlink', expectedValue: await readlink(path)};
	if (entry.isDirectory()) return {relativePath, expectedKind: 'directory', expectedValue: await fingerprintDirectory(path)};
	if (entry.isFile()) return {relativePath, expectedKind: 'file', expectedValue: hash(await readFile(path))};
	throw new Error(`Permanent delete does not support entry: ${path}`);
}

async function addSlot(layout: Layout, path: string, slots: DeleteSlot[]): Promise<void> {
	const slot = await snapshot(layout, path);
	if (slot !== undefined) slots.push(slot);
}

async function operationNames(path: string): Promise<ReadonlyArray<string>> {
	return (await readDirectory(path)).filter(entry => entry.isDirectory() && safeSegment(entry.name)).map(entry => entry.name);
}

async function collectSlots(layout: Layout, name: string): Promise<Readonly<{slots: ReadonlyArray<DeleteSlot>; foreignPaths: ReadonlyArray<string>}>> {
	const slots: DeleteSlot[] = [];
	const foreignPaths: string[] = [];
	const canonical = join(layout.amc.skills, name);
	await addSlot(layout, canonical, slots);
	for (const target of targets) {
		const active = join(layout.targets[target], name);
		if (await lstatIfPresent(active) !== undefined) {
			if (await isOwnedLink(active, canonical)) await addSlot(layout, active, slots);
			else foreignPaths.push(active);
		}
		const parked = join(layout.amc.disabledLinks, target, name);
		if (await lstatIfPresent(parked) !== undefined) {
			if (await isOwnedLink(parked, canonical)) await addSlot(layout, parked, slots);
			else foreignPaths.push(parked);
		}
	}
	for (const operation of await operationNames(layout.amc.backups)) {
		for (const target of targets) {
			await addSlot(layout, join(layout.amc.backups, operation, target, name), slots);
			await addSlot(layout, join(layout.amc.backups, operation, 'links', target, name), slots);
		}
		await addSlot(layout, join(layout.amc.backups, operation, 'staging', name), slots);
		await addSlot(layout, join(layout.amc.backups, operation, 'canonical', name), slots);
		for (const source of ['agents', 'agent', 'claude', 'pi', 'codex', 'canonical']) {
			await addSlot(layout, join(layout.amc.backups, operation, 'sources', source, name), slots);
		}
	}
	for (const operation of await operationNames(layout.amc.staging)) {
		await addSlot(layout, join(layout.amc.staging, operation, name), slots);
	}
	for (const operation of await operationNames(layout.amc.failed)) {
		await addSlot(layout, join(layout.amc.failed, operation, 'canonical', name), slots);
		await addSlot(layout, join(layout.amc.failed, operation, 'staging', name), slots);
		for (const target of targets) await addSlot(layout, join(layout.amc.failed, operation, 'links', target, name), slots);
	}
	slots.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
	foreignPaths.sort();
	return {slots, foreignPaths};
}

function planPayload(
	name: string,
	slots: ReadonlyArray<DeleteSlot>,
	foreignPaths: ReadonlyArray<string>,
	record: InstallationRecord | null,
): string {
	return JSON.stringify({name, slots, foreignPaths, record});
}

function allowedRelative(name: string, value: string): boolean {
	if (isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !safeSegment(part))) return false;
	const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	const target = '(?:claude|pi|codex)';
	const operation = '[^/]+';
	const patterns = [
		new RegExp(`^\\.amc/skills/${escapedName}$`, 'u'),
		new RegExp(`^\\.(?:claude|codex)/skills/${escapedName}$`, 'u'),
		new RegExp(`^\\.pi/agent/skills/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/disabled-links/${target}/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/backups/${operation}/${target}/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/backups/${operation}/links/${target}/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/backups/${operation}/(?:staging|canonical)/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/backups/${operation}/sources/(?:agents|agent|claude|pi|codex|canonical)/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/staging/${operation}/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/failed/${operation}/(?:canonical|staging)/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/failed/${operation}/links/${target}/${escapedName}$`, 'u'),
		new RegExp(`^\\.amc/delete-journals/${encodeURIComponent(name).replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.json$`, 'u'),
	];
	return patterns.some(pattern => pattern.test(value));
}

async function removeContained(layout: Layout, name: string, relativePath: string): Promise<void> {
	if (!allowedRelative(name, relativePath)) throw new Error(`Unsafe permanent delete path: ${relativePath}`);
	const path = resolve(layout.home, relativePath);
	const home = resolve(layout.home);
	if (!path.startsWith(`${home}${sep}`)) throw new Error(`Permanent delete path escaped home: ${relativePath}`);
	await lstat(path);
	await rm(path, {recursive: true, force: false});
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(value: unknown): InstallationRecord | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const fields = ['owner', 'repository', 'branch', 'relativePath', 'commit', 'installedHash', 'installedAt', 'updatedAt'];
	if (!fields.every(field => typeof value[field] === 'string')) return undefined;
	const owner = value['owner'];
	const repository = value['repository'];
	const branch = value['branch'];
	const relativePath = value['relativePath'];
	const commit = value['commit'];
	const installedHash = value['installedHash'];
	const installedAt = value['installedAt'];
	const updatedAt = value['updatedAt'];
	return typeof owner === 'string' && typeof repository === 'string' && typeof branch === 'string'
		&& typeof relativePath === 'string' && typeof commit === 'string' && typeof installedHash === 'string'
		&& typeof installedAt === 'string' && typeof updatedAt === 'string'
		? {owner, repository, branch, relativePath, commit, installedHash, installedAt, updatedAt}
		: undefined;
}

function parseSlot(value: unknown, name: string): DeleteSlot | undefined {
	if (!isRecord(value)) return undefined;
	const relativePath = value['relativePath'];
	const expectedKind = value['expectedKind'];
	const expectedValue = value['expectedValue'];
	return typeof relativePath === 'string' && allowedRelative(name, relativePath)
		&& (expectedKind === 'directory' || expectedKind === 'file' || expectedKind === 'symlink') && typeof expectedValue === 'string'
		? {relativePath, expectedKind, expectedValue}
		: undefined;
}

function parseJournal(text: string, expectedName: string, expectedPath: string): DeleteJournal {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value['schemaVersion'] !== 1 || !isRecord(value['plan']) || !Array.isArray(value['removed'])) {
		throw new Error('INVALID_DELETE_JOURNAL');
	}
	const source = value['plan'];
	const name = source['name'];
	const operationId = source['operationId'];
	const challenge = source['challenge'];
	const planDigest = source['planDigest'];
	const journal = source['journalPath'];
	const localDrift = source['localDrift'];
	const record = parseRecord(source['record']);
	if (name !== expectedName || typeof operationId !== 'string' || !safeSegment(operationId) || typeof challenge !== 'string'
		|| typeof planDigest !== 'string' || journal !== expectedPath || typeof localDrift !== 'boolean' || record === undefined
		|| !Array.isArray(source['slots']) || !Array.isArray(source['foreignPaths'])) {
		throw new Error('INVALID_DELETE_JOURNAL');
	}
	const slots: DeleteSlot[] = [];
	for (const item of source['slots']) {
		const slot = parseSlot(item, name);
		if (slot === undefined) throw new Error('INVALID_DELETE_JOURNAL');
		slots.push(slot);
	}
	const foreignPaths: string[] = [];
	for (const item of source['foreignPaths']) {
		if (typeof item !== 'string') throw new Error('INVALID_DELETE_JOURNAL');
		foreignPaths.push(item);
	}
	const removed: boolean[] = [];
	for (const item of value['removed']) {
		if (typeof item !== 'boolean') throw new Error('INVALID_DELETE_JOURNAL');
		removed.push(item);
	}
	if (removed.length !== slots.length || typeof value['provenanceRemoved'] !== 'boolean') {
		throw new Error('INVALID_DELETE_JOURNAL');
	}
	return {
		schemaVersion: 1,
		plan: {operationId, name, challenge, planDigest, slots, foreignPaths, localDrift, record, journalPath: journal},
		removed,
		provenanceRemoved: value['provenanceRemoved'],
	};
}

async function readJournal(layout: Layout, name: string): Promise<Readonly<{journal: DeleteJournal; text: string}> | undefined> {
	const path = journalPath(layout, name);
	try {
		const text = await readFile(path, 'utf8');
		return {journal: parseJournal(text, name, path), text};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) return undefined;
		throw error;
	}
}

async function writeJournal(path: string, journal: DeleteJournal, expected: string | undefined): Promise<string> {
	let current: string | undefined;
	try {
		current = await readFile(path, 'utf8');
	} catch (error: unknown) {
		if (!hasErrorCode(error, 'ENOENT')) throw error;
	}
	if (current !== expected) throw new Error('STALE_DELETE_JOURNAL');
	const next = `${JSON.stringify(journal, undefined, 2)}\n`;
	await atomicReplace(path, next, 0o600);
	return next;
}

async function buildPlan(layout: Layout, name: string, operationId: string): Promise<PermanentDeletePlan> {
	const collected = await collectSlots(layout, name);
	const lock = await readSkillsLock(layout);
	const record = lock.lock.skills[name] ?? null;
	if (collected.slots.length === 0 && record === null) throw new Error(`Permanent delete target not found: ${name}`);
	const canonical = collected.slots.find(slot => slot.relativePath === relative(layout.home, join(layout.amc.skills, name)));
	const localDrift = record !== null && canonical?.expectedKind === 'directory' && canonical.expectedValue !== record.installedHash;
	const planDigest = hash(planPayload(name, collected.slots, collected.foreignPaths, record));
	return {
		operationId,
		name,
		challenge: hash(`${operationId}\0${planDigest}`),
		planDigest,
		slots: collected.slots,
		foreignPaths: collected.foreignPaths,
		localDrift,
		record,
		journalPath: journalPath(layout, name),
	};
}

export async function planPermanentDelete(layout: Layout, name: string): Promise<PermanentDeletePlan> {
	validateSkillName(name);
	const existing = await readJournal(layout, name);
	return existing?.journal.plan ?? buildPlan(layout, name, createOperationId());
}

async function sameSnapshot(layout: Layout, slot: DeleteSlot): Promise<boolean | undefined> {
	const current = await snapshot(layout, resolve(layout.home, slot.relativePath));
	return current === undefined ? undefined : current.expectedKind === slot.expectedKind && current.expectedValue === slot.expectedValue;
}

export async function permanentlyDeleteSkill(
	layout: Layout,
	plan: PermanentDeletePlan,
	confirmation: Readonly<{challenge: string; name: string}>,
	hooks: PermanentDeleteHooks = {},
): Promise<PermanentDeleteResult> {
	validateSkillName(plan.name);
	if (confirmation.name !== plan.name || confirmation.challenge !== plan.challenge) throw new Error('Permanent delete confirmation failed');
	let stored = await readJournal(layout, plan.name);
	if (stored === undefined) {
		const fresh = await buildPlan(layout, plan.name, plan.operationId);
		if (fresh.planDigest !== plan.planDigest || fresh.challenge !== plan.challenge) throw new Error('Permanent delete plan is stale');
		const journal: DeleteJournal = {schemaVersion: 1, plan, removed: plan.slots.map(() => false), provenanceRemoved: false};
		const text = await writeJournal(plan.journalPath, journal, undefined);
		stored = {journal, text};
	} else if (stored.journal.plan.challenge !== plan.challenge) {
		throw new Error('Permanent delete plan is stale');
	}
	let journal = stored.journal;
	let journalText = stored.text;
	const current = await collectSlots(layout, plan.name);
	if (current.slots.some(slot => !plan.slots.some(planned => planned.relativePath === slot.relativePath))
		|| JSON.stringify(current.foreignPaths) !== JSON.stringify(plan.foreignPaths)) {
		throw new Error('Permanent delete plan is stale');
	}
	for (let index = 0; index < plan.slots.length; index += 1) {
		if (journal.removed[index] === true) continue;
		const slot = plan.slots[index];
		if (slot === undefined) throw new Error('INVALID_DELETE_JOURNAL');
		const matches = await sameSnapshot(layout, slot);
		if (matches === false) throw new Error(`Permanent delete slot changed: ${slot.relativePath}`);
		if (matches !== undefined) {
			await removeContained(layout, plan.name, slot.relativePath);
			await hooks.afterRemove?.(index);
			if (await lstatIfPresent(resolve(layout.home, slot.relativePath)) !== undefined) throw new Error(`Permanent delete verification failed: ${slot.relativePath}`);
		}
		const removed = journal.removed.map((value, removedIndex) => removedIndex === index ? true : value);
		journal = {...journal, removed};
		journalText = await writeJournal(plan.journalPath, journal, journalText);
	}
	if (!journal.provenanceRemoved) {
		const lock = await readSkillsLock(layout);
		const currentRecord = lock.lock.skills[plan.name] ?? null;
		if (currentRecord !== null && JSON.stringify(currentRecord) !== JSON.stringify(plan.record)) throw new Error('Permanent delete provenance changed');
		if (currentRecord !== null) {
			const skills = Object.fromEntries(Object.entries(lock.lock.skills).filter(([name]) => name !== plan.name));
			await writeSkillsLock(layout, {schemaVersion: 1, skills}, lock.text);
		}
		journal = {...journal, provenanceRemoved: true};
		journalText = await writeJournal(plan.journalPath, journal, journalText);
	}
	const journalRelative = relative(layout.home, plan.journalPath);
	const expectedJournal = `.amc/delete-journals/${encodeURIComponent(plan.name)}.json`;
	if (journalRelative !== expectedJournal) throw new Error('Unsafe delete journal path');
	await removeContained(layout, plan.name, journalRelative);
	return {state: 'deleted', operationId: plan.operationId, removed: plan.slots.length};
}


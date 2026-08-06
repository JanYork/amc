import {readFile} from 'node:fs/promises';
import type {Layout} from '../model.js';
import type {InstallationRecord} from '../marketplace/model.js';
import {atomicReplace, hasErrorCode} from '../resources/persistence.js';

export type SkillsLock = Readonly<{
	schemaVersion: 1;
	skills: Readonly<Record<string, InstallationRecord>>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function installationRecord(value: unknown): InstallationRecord | undefined {
	if (!isRecord(value)) return undefined;
	const owner = value['owner'];
	const repository = value['repository'];
	const branch = value['branch'];
	const relativePath = value['relativePath'];
	const commit = value['commit'];
	const installedHash = value['installedHash'];
	const installedAt = value['installedAt'];
	const updatedAt = value['updatedAt'];
	return [owner, repository, branch, relativePath, commit, installedHash, installedAt, updatedAt].every(item => typeof item === 'string')
		&& typeof owner === 'string' && typeof repository === 'string' && typeof branch === 'string'
		&& typeof relativePath === 'string' && typeof commit === 'string' && typeof installedHash === 'string'
		&& typeof installedAt === 'string' && typeof updatedAt === 'string'
		? {owner, repository, branch, relativePath, commit, installedHash, installedAt, updatedAt}
		: undefined;
}

function parseLock(text: string): SkillsLock {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value['schemaVersion'] !== 1 || !isRecord(value['skills'])) {
		throw new Error('INVALID_SKILLS_LOCK: expected schema version 1');
	}
	const entries: Array<readonly [string, InstallationRecord]> = [];
	for (const [name, item] of Object.entries(value['skills'])) {
		const record = installationRecord(item);
		if (record === undefined) throw new Error(`INVALID_SKILLS_LOCK: invalid record for ${name}`);
		entries.push([name, record]);
	}
	return {schemaVersion: 1, skills: Object.fromEntries(entries)};
}

export async function readSkillsLock(layout: Layout): Promise<Readonly<{lock: SkillsLock; text: string | undefined}>> {
	try {
		const text = await readFile(layout.amc.skillsLock, 'utf8');
		return {lock: parseLock(text), text};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) return {lock: {schemaVersion: 1, skills: {}}, text: undefined};
		throw error;
	}
}

export async function writeSkillsLock(layout: Layout, lock: SkillsLock, expected: string | undefined): Promise<void> {
	let current: string | undefined;
	try {
		current = await readFile(layout.amc.skillsLock, 'utf8');
	} catch (error: unknown) {
		if (!hasErrorCode(error, 'ENOENT')) throw error;
	}
	if (current !== expected) throw new Error('STALE_SKILLS_LOCK: installed Skill state changed');
	const next = `${JSON.stringify(lock, undefined, 2)}\n`;
	await atomicReplace(layout.amc.skillsLock, next, 0o600);
	if (await readFile(layout.amc.skillsLock, 'utf8') !== next) throw new Error('SKILLS_LOCK_WRITE_FAILED: verification failed');
}

export async function readInstalledSkills(layout: Layout): Promise<Readonly<Record<string, InstallationRecord>>> {
	return (await readSkillsLock(layout)).lock.skills;
}

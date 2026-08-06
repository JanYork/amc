import {readFile} from 'node:fs/promises';
import type {Layout} from '../model.js';
import {atomicReplace, hasErrorCode} from '../resources/persistence.js';
import type {MarketplaceRepository, MarketplaceState, RemoteSkill, RemoteSkillFile, RepositoryScan} from './model.js';

const emptyState = (): MarketplaceState => ({schemaVersion: 1, repositories: []});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function remoteFile(value: unknown): RemoteSkillFile | undefined {
	if (!isRecord(value)) return undefined;
	const path = value['path'];
	const size = value['size'];
	const executable = value['executable'];
	return typeof path === 'string' && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && typeof executable === 'boolean'
		? {path, size, executable}
		: undefined;
}

function remoteSkill(value: unknown): RemoteSkill | undefined {
	if (!isRecord(value) || !Array.isArray(value['files'])) return undefined;
	const name = value['name'];
	const description = value['description'];
	const relativePath = value['relativePath'];
	const files: RemoteSkillFile[] = [];
	for (const item of value['files']) {
		const parsed = remoteFile(item);
		if (parsed === undefined) return undefined;
		files.push(parsed);
	}
	return typeof name === 'string' && typeof description === 'string' && typeof relativePath === 'string'
		? {name, description, relativePath, files}
		: undefined;
}

function repositoryScan(value: unknown): RepositoryScan | undefined {
	if (!isRecord(value) || !isRecord(value['repository']) || !Array.isArray(value['skills']) || !Array.isArray(value['diagnostics'])) return undefined;
	const repository = value['repository'];
	const owner = repository['owner'];
	const name = repository['repository'];
	const branch = repository['branch'];
	const commit = repository['commit'];
	if (typeof owner !== 'string' || typeof name !== 'string' || typeof branch !== 'string' || typeof commit !== 'string') return undefined;
	const skills: RemoteSkill[] = [];
	for (const item of value['skills']) {
		const parsed = remoteSkill(item);
		if (parsed === undefined) return undefined;
		skills.push(parsed);
	}
	const diagnostics: string[] = [];
	for (const item of value['diagnostics']) {
		if (typeof item !== 'string') return undefined;
		diagnostics.push(item);
	}
	return {repository: {owner, repository: name, branch, commit}, skills, diagnostics};
}

function marketplaceRepository(value: unknown): MarketplaceRepository | undefined {
	if (!isRecord(value)) return undefined;
	const enabled = value['enabled'];
	const addedAt = value['addedAt'];
	const scan = repositoryScan(value['scan']);
	return typeof enabled === 'boolean' && typeof addedAt === 'string' && scan !== undefined
		? {enabled, addedAt, scan}
		: undefined;
}

function parseState(text: string): MarketplaceState {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value['schemaVersion'] !== 1 || !Array.isArray(value['repositories'])) {
		throw new Error('INVALID_MARKETPLACE_STATE: expected schema version 1');
	}
	const repositories: MarketplaceRepository[] = [];
	for (const item of value['repositories']) {
		const parsed = marketplaceRepository(item);
		if (parsed === undefined) throw new Error('INVALID_MARKETPLACE_STATE: invalid repository record');
		repositories.push(parsed);
	}
	return {schemaVersion: 1, repositories};
}

export async function readMarketplaceState(layout: Layout): Promise<Readonly<{state: MarketplaceState; text: string | undefined}>> {
	try {
		const text = await readFile(layout.amc.marketplace, 'utf8');
		return {state: parseState(text), text};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) return {state: emptyState(), text: undefined};
		throw error;
	}
}

export async function writeMarketplaceState(layout: Layout, state: MarketplaceState, expected: string | undefined): Promise<void> {
	let current: string | undefined;
	try {
		current = await readFile(layout.amc.marketplace, 'utf8');
	} catch (error: unknown) {
		if (!hasErrorCode(error, 'ENOENT')) throw error;
	}
	if (current !== expected) {
		throw new Error('STALE_MARKETPLACE_STATE: marketplace state changed during operation');
	}
	const next = `${JSON.stringify(state, undefined, 2)}\n`;
	await atomicReplace(layout.amc.marketplace, next, 0o600);
	const verified = await readFile(layout.amc.marketplace, 'utf8');
	if (verified !== next) throw new Error('MARKETPLACE_STATE_WRITE_FAILED: verification failed');
}

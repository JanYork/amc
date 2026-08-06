import type {Layout} from '../model.js';
import {scanGitHubRepository} from './github.js';
import {readMarketplaceState, writeMarketplaceState} from './persistence.js';
import type {MarketplaceRepository, MarketplaceRuntime} from './model.js';

function key(owner: string, repository: string): string {
	return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function requestedKey(source: string): string {
	const cleaned = source.trim().replace(/^https:\/\/github\.com\//iu, '').replace(/\/$/u, '').replace(/\.git$/iu, '');
	if (!/^[a-z\d-]+\/[a-z\d._-]+$/iu.test(cleaned)) throw new Error('Repository must be owner/repository');
	return cleaned.toLowerCase();
}

export async function listMarketplaceRepositories(layout: Layout): Promise<ReadonlyArray<MarketplaceRepository>> {
	return (await readMarketplaceState(layout)).state.repositories;
}

export async function addMarketplaceRepository(
	layout: Layout,
	runtime: MarketplaceRuntime,
	input: Readonly<{source: string; branch?: string}>,
): Promise<MarketplaceRepository> {
	const before = await readMarketplaceState(layout);
	if (before.state.repositories.length >= 50) throw new Error('Marketplace repository limit reached');
	const scan = await scanGitHubRepository(runtime, input);
	if (scan.skills.length === 0) throw new Error('GitHub repository contains no valid Skill');
	const repositoryKey = key(scan.repository.owner, scan.repository.repository);
	const existing = before.state.repositories.find(item => key(item.scan.repository.owner, item.scan.repository.repository) === repositoryKey);
	if (existing !== undefined) {
		if (existing.scan.repository.branch !== scan.repository.branch) throw new Error('Repository already exists with another branch');
		return existing;
	}
	const repository: MarketplaceRepository = {enabled: true, addedAt: new Date().toISOString(), scan};
	await writeMarketplaceState(layout, {
		schemaVersion: 1,
		repositories: [...before.state.repositories, repository].sort((left, right) => {
			const leftKey = key(left.scan.repository.owner, left.scan.repository.repository);
			const rightKey = key(right.scan.repository.owner, right.scan.repository.repository);
			return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
		}),
	}, before.text);
	return repository;
}

export async function refreshMarketplaceRepository(
	layout: Layout,
	runtime: MarketplaceRuntime,
	source: string,
): Promise<MarketplaceRepository> {
	const before = await readMarketplaceState(layout);
	const wanted = requestedKey(source);
	const index = before.state.repositories.findIndex(item => key(item.scan.repository.owner, item.scan.repository.repository) === wanted);
	const current = before.state.repositories[index];
	if (index < 0 || current === undefined) throw new Error(`Marketplace repository not found: ${source}`);
	const scan = await scanGitHubRepository(runtime, {
		source: wanted,
		branch: current.scan.repository.branch,
	});
	if (scan.skills.length === 0) throw new Error('GitHub repository contains no valid Skill');
	const updated: MarketplaceRepository = {...current, scan};
	const repositories = [...before.state.repositories];
	repositories[index] = updated;
	await writeMarketplaceState(layout, {schemaVersion: 1, repositories}, before.text);
	return updated;
}

export async function setMarketplaceRepositoryEnabled(layout: Layout, source: string, enabled: boolean): Promise<void> {
	const before = await readMarketplaceState(layout);
	const wanted = requestedKey(source);
	let found = false;
	const repositories = before.state.repositories.map(item => {
		if (key(item.scan.repository.owner, item.scan.repository.repository) !== wanted) return item;
		found = true;
		return {...item, enabled};
	});
	if (!found) throw new Error(`Marketplace repository not found: ${source}`);
	await writeMarketplaceState(layout, {schemaVersion: 1, repositories}, before.text);
}

export async function removeMarketplaceRepository(layout: Layout, source: string): Promise<void> {
	const before = await readMarketplaceState(layout);
	const wanted = requestedKey(source);
	const repositories = before.state.repositories.filter(item => key(item.scan.repository.owner, item.scan.repository.repository) !== wanted);
	if (repositories.length === before.state.repositories.length) throw new Error(`Marketplace repository not found: ${source}`);
	await writeMarketplaceState(layout, {schemaVersion: 1, repositories}, before.text);
}

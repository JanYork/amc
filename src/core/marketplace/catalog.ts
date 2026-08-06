import type {Layout} from '../model.js';
import type {MarketplaceFeaturedPage, MarketplaceItem, MarketplaceRuntime, MarketplaceSearchResult, SkillsShLead} from './model.js';

export type MarketplaceSearchSource = 'skills.sh' | 'github';
import {scanGitHubRepository} from './github.js';
import {readMarketplaceState} from './persistence.js';
import {selectRemoteSkill} from './select.js';
import {listPopularSkillsSh, searchSkillsSh} from './skills-sh.js';

function sourceKey(owner: string, repository: string): string {
	return `${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function includesQuery(item: MarketplaceItem, query: string): boolean {
	return [item.name, item.description ?? '', item.source, item.relativePath ?? '']
		.some(value => value.toLowerCase().includes(query));
}

function rank(item: MarketplaceItem, query: string): number {
	const name = item.name.toLowerCase();
	return name === query ? 0 : name.startsWith(query) ? 1 : name.includes(query) ? 2 : 3;
}

export async function resolveMarketplaceItem(
	runtime: MarketplaceRuntime,
	item: MarketplaceItem,
): Promise<MarketplaceItem> {
	if (item.description !== undefined) return item;
	const scan = await scanGitHubRepository(runtime, item.branch === undefined
		? {source: item.source}
		: {source: item.source, branch: item.branch});
	const selected = selectRemoteSkill(scan.skills, item.name, 'Skill metadata', item.relativePath);
	return {
		...item,
		description: selected.description,
		branch: scan.repository.branch,
		relativePath: selected.relativePath,
		commit: scan.repository.commit,
	};
}

function fromLead(lead: SkillsShLead): MarketplaceItem {
	return {
		name: lead.name,
		description: undefined,
		source: lead.source,
		branch: undefined,
		relativePath: undefined,
		commit: undefined,
		installs: lead.installs,
		freshness: 'live',
	};
}

export async function listMarketplaceFeatured(runtime: MarketplaceRuntime, page = 0): Promise<MarketplaceFeaturedPage> {
	const result = await listPopularSkillsSh(runtime, page);
	return {...result, items: result.items.map(fromLead)};
}

export async function searchMarketplace(
	layout: Layout,
	runtime: MarketplaceRuntime,
	query: string,
	source?: MarketplaceSearchSource,
): Promise<MarketplaceSearchResult> {
	const normalized = query.trim().toLowerCase();
	if (normalized.length === 0) throw new Error('Marketplace search query must not be empty');
	const state = await readMarketplaceState(layout);
	const items: MarketplaceItem[] = [];
	for (const repository of state.state.repositories) {
		if (source === 'skills.sh' || !repository.enabled) continue;
		const repositorySource = sourceKey(repository.scan.repository.owner, repository.scan.repository.repository);
		for (const skill of repository.scan.skills) {
			const item: MarketplaceItem = {
				name: skill.name,
				description: skill.description,
				source: repositorySource,
				branch: repository.scan.repository.branch,
				relativePath: skill.relativePath,
				commit: repository.scan.repository.commit,
				installs: undefined,
				freshness: 'cached',
			};
			if (includesQuery(item, normalized)) items.push(item);
		}
	}
	const diagnostics: string[] = [];
	let leads: ReadonlyArray<SkillsShLead> = [];
	if (source !== 'github') {
		try {
			leads = await searchSkillsSh(runtime, query);
		} catch (error: unknown) {
			diagnostics.push(`skills.sh: ${error instanceof Error ? error.message : 'unavailable'}`);
		}
	}
	for (const lead of leads) {
		const candidates = items.filter(item => item.source.toLowerCase() === lead.source.toLowerCase()
			&& (item.name.toLowerCase() === lead.name.toLowerCase()
				|| item.relativePath?.split('/').at(-1)?.toLowerCase() === lead.skillId.toLowerCase()));
		if (candidates.length === 1) {
			const candidate = candidates[0];
			if (candidate !== undefined) {
				const index = items.indexOf(candidate);
				items[index] = {...candidate, installs: lead.installs};
			}
			continue;
		}
		const item = fromLead(lead);
		if (includesQuery(item, normalized)) items.push(item);
	}
	if (items.length === 0 && diagnostics.length > 0) {
		throw new Error(diagnostics.join('; '));
	}
	items.sort((left, right) => {
		const rankDifference = rank(left, normalized) - rank(right, normalized);
		if (rankDifference !== 0) return rankDifference;
		const installDifference = (right.installs ?? 0) - (left.installs ?? 0);
		if (installDifference !== 0) return installDifference;
		const leftKey = `${left.source}:${left.branch ?? ''}:${left.relativePath ?? left.name}`;
		const rightKey = `${right.source}:${right.branch ?? ''}:${right.relativePath ?? right.name}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
	return {items, diagnostics};
}

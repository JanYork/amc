import type {MarketplaceRuntime, SkillsShLead, SkillsShPage} from './model.js';

const maximumResponseBytes = 1024 * 1024;

function safeText(value: string): boolean {
	return value.length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestSkills(runtime: MarketplaceRuntime, url: string): Promise<unknown> {
	const response = await runtime.get(url, maximumResponseBytes, 10_000);
	const finalUrl = new URL(response.url);
	if (response.url !== url || finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'skills.sh') {
		throw new Error('Unexpected skills.sh response URL');
	}
	if (response.status < 200 || response.status >= 300 || response.body.length > maximumResponseBytes) {
		throw new Error(`skills.sh request failed with status ${response.status}`);
	}
	return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(response.body));
}

function parseLeads(parsed: unknown, synthesizeId: boolean): ReadonlyArray<SkillsShLead> {
	if (!isRecord(parsed) || !Array.isArray(parsed['skills'])) {
		throw new Error('Invalid skills.sh response');
	}
	const leads: SkillsShLead[] = [];
	for (const item of parsed['skills']) {
		if (!isRecord(item)) continue;
		const name = item['name'];
		const skillId = item['skillId'];
		const source = item['source'];
		const installs = item['installs'];
		const suppliedId = item['id'];
		if (
			typeof name !== 'string' || typeof skillId !== 'string' || typeof source !== 'string'
			|| typeof installs !== 'number' || !Number.isSafeInteger(installs) || installs < 0
			|| !safeText(name) || !safeText(skillId)
			|| !/^[a-z\d._-]+\/[a-z\d._-]+$/iu.test(source)
		) {
			continue;
		}
		const id = synthesizeId ? `${source}/${skillId}` : suppliedId;
		if (typeof id !== 'string' || !safeText(id)) continue;
		leads.push({id, name, skillId, source, installs});
	}
	return leads;
}

export async function listPopularSkillsSh(runtime: MarketplaceRuntime, page = 0): Promise<SkillsShPage> {
	if (!Number.isSafeInteger(page) || page < 0) throw new Error('skills.sh page must be a non-negative integer');
	const parsed = await requestSkills(runtime, `https://skills.sh/api/skills/all-time/${page}`);
	if (!isRecord(parsed)) throw new Error('Invalid skills.sh response');
	const responsePage = parsed['page'];
	const total = parsed['total'];
	const hasMore = parsed['hasMore'];
	if (responsePage !== page || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || typeof hasMore !== 'boolean') {
		throw new Error('Invalid skills.sh pagination');
	}
	return {items: parseLeads(parsed, true), page, total, hasMore};
}

export async function searchSkillsSh(runtime: MarketplaceRuntime, query: string): Promise<ReadonlyArray<SkillsShLead>> {
	const normalized = query.trim();
	if (normalized.length === 0) {
		throw new Error('Marketplace search query must not be empty');
	}
	const parsed = await requestSkills(runtime, `https://skills.sh/api/search?q=${encodeURIComponent(normalized)}&limit=20`);
	return parseLeads(parsed, false);
}

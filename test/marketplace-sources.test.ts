import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {
	listPopularSkillsSh,
	parseSkillManifest,
	resolveMarketplaceItem,
	scanGitHubRepository,
	searchSkillsSh,
	type MarketplaceRuntime,
} from '../src/core/marketplace.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const fixture = (name: string): Promise<Uint8Array> => readFile(resolve('test/fixtures/marketplace', name));

function runtime(responses: Readonly<Record<string, Uint8Array>>): MarketplaceRuntime {
	return {
		get: url => {
			const body = responses[url];
			return Promise.resolve(body === undefined
				? {status: 404, url, body: text('not found')}
				: {status: 200, url, body});
		},
	};
}

test('strict remote manifests require non-empty string name and description frontmatter', () => {
	assert.deepEqual(parseSkillManifest('---\nname: alpha\ndescription: Useful skill.\n---\n# Alpha\n'), {
		name: 'alpha',
		description: 'Useful skill.',
	});
	assert.equal(parseSkillManifest('# Alpha\n\nBody fallback.'), undefined);
	assert.equal(parseSkillManifest('---\nname: alpha\ndescription:   \n---\n'), undefined);
	assert.equal(parseSkillManifest('---\nname: 42\ndescription: useful\n---\n'), undefined);
});

test('GitHub scan discovers root and nested Skills at one commit and reports invalid candidates', async () => {
	const [tree, rootManifest, nestedManifest] = await Promise.all([
		fixture('github-tree.json'),
		fixture('root-SKILL.md'),
		fixture('nested-SKILL.md'),
	]);
	const api = runtime({
		'https://api.github.com/repos/example/skills': json({private: false, default_branch: 'main'}),
		'https://api.github.com/repos/example/skills/git/ref/heads/main': json({object: {sha: '0123456789abcdef0123456789abcdef01234567'}}),
		'https://api.github.com/repos/example/skills/git/trees/0123456789abcdef0123456789abcdef01234567?recursive=1': tree,
		'https://raw.githubusercontent.com/example/skills/0123456789abcdef0123456789abcdef01234567/SKILL.md': rootManifest,
		'https://raw.githubusercontent.com/example/skills/0123456789abcdef0123456789abcdef01234567/skills/beta/SKILL.md': nestedManifest,
		'https://raw.githubusercontent.com/example/skills/0123456789abcdef0123456789abcdef01234567/broken/SKILL.md': text('# Broken'),
		'https://raw.githubusercontent.com/example/skills/0123456789abcdef0123456789abcdef01234567/unsafe/SKILL.md': text('---\nname: ../escape\ndescription: Unsafe name.\n---\n'),
	});

	const result = await scanGitHubRepository(api, {source: 'example/skills'});

	assert.equal(result.repository.owner, 'example');
	assert.equal(result.repository.repository, 'skills');
	assert.equal(result.repository.branch, 'main');
	assert.equal(result.repository.commit, '0123456789abcdef0123456789abcdef01234567');
	assert.deepEqual(result.skills.map(skill => [skill.name, skill.relativePath]), [
		['alpha', '.'],
		['beta', 'skills/beta'],
	]);
	assert.equal(result.skills[1]?.files[1]?.executable, true);
	assert.equal(result.diagnostics.length, 2);
});

test('registry lead resolution returns the selected GitHub Skill description and provenance', async () => {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const manifest = text('---\nname: alpha\ndescription: Resolved description.\n---\n# Alpha\n');
	const api = runtime({
		'https://api.github.com/repos/example/skills': json({private: false, default_branch: 'main'}),
		'https://api.github.com/repos/example/skills/git/ref/heads/main': json({object: {sha: commit}}),
		[`https://api.github.com/repos/example/skills/git/trees/${commit}?recursive=1`]: json({truncated: false, tree: [{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: manifest.length}]}),
		[`https://raw.githubusercontent.com/example/skills/${commit}/skills/alpha/SKILL.md`]: manifest,
	});

	const resolved = await resolveMarketplaceItem(api, {
		name: 'alpha', description: undefined, source: 'example/skills', branch: undefined,
		relativePath: undefined, commit: undefined, installs: 12_345, freshness: 'live',
	});

	assert.deepEqual(resolved, {
		name: 'alpha', description: 'Resolved description.', source: 'example/skills', branch: 'main',
		relativePath: 'skills/alpha', commit, installs: 12_345, freshness: 'live',
	});
});

test('registry resolution prefers the conventional Skill path over a hidden plugin mirror', async () => {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const manifest = text('---\nname: azure-storage\ndescription: Azure Storage guidance.\n---\n');
	const api = runtime({
		'https://api.github.com/repos/microsoft/azure-skills': json({private: false, default_branch: 'main'}),
		'https://api.github.com/repos/microsoft/azure-skills/git/ref/heads/main': json({object: {sha: commit}}),
		[`https://api.github.com/repos/microsoft/azure-skills/git/trees/${commit}?recursive=1`]: json({truncated: false, tree: [
			{path: '.github/plugins/azure-skills/skills/azure-storage/SKILL.md', type: 'blob', mode: '100644', size: manifest.length},
			{path: 'skills/azure-storage/SKILL.md', type: 'blob', mode: '100644', size: manifest.length},
		]}),
		[`https://raw.githubusercontent.com/microsoft/azure-skills/${commit}/.github/plugins/azure-skills/skills/azure-storage/SKILL.md`]: manifest,
		[`https://raw.githubusercontent.com/microsoft/azure-skills/${commit}/skills/azure-storage/SKILL.md`]: manifest,
	});

	const resolved = await resolveMarketplaceItem(api, {
		name: 'azure-storage', description: undefined, source: 'microsoft/azure-skills', branch: undefined,
		relativePath: undefined, commit: undefined, installs: 1, freshness: 'live',
	});
	assert.equal(resolved.relativePath, 'skills/azure-storage');
	assert.equal(resolved.description, 'Azure Storage guidance.');
});

test('GitHub scan rejects private and truncated repositories', async () => {
	await assert.rejects(scanGitHubRepository(runtime({
		'https://api.github.com/repos/example/private': json({private: true, default_branch: 'main'}),
	}), {source: 'example/private'}), /public GitHub repository/u);

	await assert.rejects(scanGitHubRepository(runtime({
		'https://api.github.com/repos/example/huge': json({private: false, default_branch: 'main'}),
		'https://api.github.com/repos/example/huge/git/ref/heads/main': json({object: {sha: '0123456789abcdef0123456789abcdef01234567'}}),
		'https://api.github.com/repos/example/huge/git/trees/0123456789abcdef0123456789abcdef01234567?recursive=1': json({truncated: true, tree: []}),
	}), {source: 'example/huge'}), /truncated/u);

});

test('GitHub scan isolates symlinks and submodules to the containing Skill directory', async () => {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const alpha = text('---\nname: alpha\ndescription: Blocked by its own link.\n---\n');
	const beta = text('---\nname: beta\ndescription: Safe sibling Skill.\n---\n');
	const api = runtime({
		'https://api.github.com/repos/example/links': json({private: false, default_branch: 'main'}),
		'https://api.github.com/repos/example/links/git/ref/heads/main': json({object: {sha: commit}}),
		[`https://api.github.com/repos/example/links/git/trees/${commit}?recursive=1`]: json({
			truncated: false,
			tree: [
				{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: alpha.length},
				{path: 'skills/alpha/external', type: 'blob', mode: '120000', size: 12},
				{path: 'skills/beta/SKILL.md', type: 'blob', mode: '100644', size: beta.length},
				{path: 'skills/beta/readme.md', type: 'blob', mode: '100644', size: 4},
				{path: 'tools/vendor', type: 'commit', mode: '160000'},
			],
		}),
		[`https://raw.githubusercontent.com/example/links/${commit}/skills/alpha/SKILL.md`]: alpha,
		[`https://raw.githubusercontent.com/example/links/${commit}/skills/beta/SKILL.md`]: beta,
	});

	const result = await scanGitHubRepository(api, {source: 'example/links'});

	assert.deepEqual(result.skills.map(skill => skill.name), ['beta']);
	assert.deepEqual(result.skills[0]?.files.map(file => file.path), ['skills/beta/SKILL.md', 'skills/beta/readme.md']);
	assert.equal(result.skills[0]?.files.some(file => file.path.includes('external') || file.path.includes('vendor')), false);
	assert.match(result.diagnostics.join('\n'), /skills\/alpha.*symlink or submodule.*skills\/alpha\/external/u);
	assert.doesNotMatch(result.diagnostics.join('\n'), /tools\/vendor/u);
});

test('root Skill remains blocked by an unsupported entry anywhere in its install directory', async () => {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const manifest = text('---\nname: root-skill\ndescription: Root candidate.\n---\n');
	const api = runtime({
		'https://api.github.com/repos/example/root-links': json({private: false, default_branch: 'main'}),
		'https://api.github.com/repos/example/root-links/git/ref/heads/main': json({object: {sha: commit}}),
		[`https://api.github.com/repos/example/root-links/git/trees/${commit}?recursive=1`]: json({truncated: false, tree: [
			{path: 'SKILL.md', type: 'blob', mode: '100644', size: manifest.length},
			{path: 'docs/external', type: 'blob', mode: '120000', size: 5},
		]}),
		[`https://raw.githubusercontent.com/example/root-links/${commit}/SKILL.md`]: manifest,
	});

	const result = await scanGitHubRepository(api, {source: 'example/root-links'});
	assert.equal(result.skills.length, 0);
	assert.match(result.diagnostics.join('\n'), /SKILL\.md.*symlink or submodule.*docs\/external/u);
});

test('GitHub scan rejects a same-host redirect to different content', async () => {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const api: MarketplaceRuntime = {get: url => {
		if (url === 'https://api.github.com/repos/example/redirect') return Promise.resolve({status: 200, url, body: json({private: false, default_branch: 'main'})});
		if (url.includes('/git/ref/')) return Promise.resolve({status: 200, url, body: json({object: {sha: commit}})});
		if (url.includes('/git/trees/')) return Promise.resolve({status: 200, url, body: json({truncated: false, tree: [{path: 'SKILL.md', type: 'blob', mode: '100644', size: 50}]})});
		return Promise.resolve({status: 200, url: `https://raw.githubusercontent.com/other/repository/${commit}/SKILL.md`, body: text('---\nname: alpha\ndescription: Wrong source.\n---\n')});
	}};
	const result = await scanGitHubRepository(api, {source: 'example/redirect'});
	assert.equal(result.skills.length, 0);
	assert.match(result.diagnostics[0] ?? '', /URL|redirect/u);
});

test('skills.sh popular listing accepts its public leaderboard shape and keeps installable GitHub sources', async () => {
	const api = runtime({
		'https://skills.sh/api/skills/all-time/0': json({
			skills: [
				{source: 'vercel-labs/skills', skillId: 'find-skills', name: 'find-skills', installs: 2_835_218, weeklyInstalls: [1, 2]},
				{source: 'example.com', skillId: 'site-skill', name: 'site-skill', installs: 99},
			],
			page: 0,
			total: 2,
			hasMore: true,
		}),
	});

	assert.deepEqual(await listPopularSkillsSh(api), {
		items: [{
			id: 'vercel-labs/skills/find-skills',
			name: 'find-skills',
			skillId: 'find-skills',
			source: 'vercel-labs/skills',
			installs: 2_835_218,
		}],
		page: 0,
		total: 2,
		hasMore: true,
	});
});

test('skills.sh search validates and normalizes public results', async () => {
	const api = runtime({
		'https://skills.sh/api/search?q=testing&limit=20': await fixture('skills-sh-search.json'),
	});

	assert.deepEqual(await searchSkillsSh(api, 'testing'), [{
		id: 'anthropics/skills/webapp-testing',
		name: 'webapp-testing',
		skillId: 'webapp-testing',
		source: 'anthropics/skills',
		installs: 127_234,
	}]);
});

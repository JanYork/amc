import assert from 'node:assert/strict';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
	addMarketplaceRepository,
	listMarketplaceRepositories,
	refreshMarketplaceRepository,
	removeMarketplaceRepository,
	searchMarketplace,
	setMarketplaceRepositoryEnabled,
	type MarketplaceRuntime,
} from '../src/core/marketplace.js';
import {createLayout} from '../src/core/index.js';
import {createTestHome, pathExists, writeSkill} from './helpers.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function repositoryRuntime(description = 'Useful skill.'): MarketplaceRuntime {
	return {
		get: url => {
			const responses: Readonly<Record<string, Uint8Array>> = {
				'https://api.github.com/repos/example/skills': json({private: false, default_branch: 'main'}),
				'https://api.github.com/repos/example/skills/git/ref/heads/main': json({object: {sha: '0123456789abcdef0123456789abcdef01234567'}}),
				'https://api.github.com/repos/example/skills/git/trees/0123456789abcdef0123456789abcdef01234567?recursive=1': json({
					truncated: false,
					tree: [{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: 80}],
				}),
				'https://raw.githubusercontent.com/example/skills/0123456789abcdef0123456789abcdef01234567/skills/alpha/SKILL.md': text(`---\nname: alpha\ndescription: ${description}\n---\n# Alpha\n`),
			};
			const body = responses[url];
			return Promise.resolve(body === undefined
				? {status: 404, url, body: text('missing')}
				: {status: 200, url, body});
		},
	};
}

test('repository add validates before persisting and creates owner-only state', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const added = await addMarketplaceRepository(layout, repositoryRuntime(), {source: 'example/skills'});

	assert.equal(added.scan.skills[0]?.name, 'alpha');
	assert.deepEqual(await listMarketplaceRepositories(layout), [added]);
	assert.equal((await stat(layout.amc.marketplace)).mode & 0o777, 0o600);

	const invalid: MarketplaceRuntime = {get: url => Promise.resolve({status: 200, url, body: json(
		url.endsWith('/example/empty') ? {private: false, default_branch: 'main'}
			: url.includes('/git/ref/') ? {object: {sha: '0123456789abcdef0123456789abcdef01234567'}}
				: {truncated: false, tree: []},
	)})};
	await assert.rejects(addMarketplaceRepository(layout, invalid, {source: 'example/empty'}), /valid Skill/u);
	assert.equal((await listMarketplaceRepositories(layout)).length, 1);
});

test('refresh retains the last successful index on failure and disable/remove do not touch installed content', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await addMarketplaceRepository(layout, repositoryRuntime(), {source: 'example/skills'});
	const before = await readFile(layout.amc.marketplace, 'utf8');
	const unavailable: MarketplaceRuntime = {get: url => Promise.resolve({status: 503, url, body: text('unavailable')})};

	await assert.rejects(refreshMarketplaceRepository(layout, unavailable, 'example/skills'), /503/u);
	assert.equal(await readFile(layout.amc.marketplace, 'utf8'), before);

	await setMarketplaceRepositoryEnabled(layout, 'example/skills', false);
	assert.equal((await listMarketplaceRepositories(layout))[0]?.enabled, false);
	const canonical = await writeSkill(layout.amc.skills, 'alpha', 'owned content');
	await writeFile(layout.amc.skillsLock, '{"schemaVersion":1,"skills":{}}', {mode: 0o600});
	const lockBefore = await readFile(layout.amc.skillsLock, 'utf8');

	await removeMarketplaceRepository(layout, 'example/skills');
	assert.deepEqual(await listMarketplaceRepositories(layout), []);
	assert.equal(await readFile(join(canonical, 'SKILL.md'), 'utf8'), 'owned content');
	assert.equal(await readFile(layout.amc.skillsLock, 'utf8'), lockBefore);
});

test('marketplace search merges one resolved registry lead and keeps partial cached results', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await addMarketplaceRepository(layout, repositoryRuntime(), {source: 'example/skills'});
	const runtime: MarketplaceRuntime = {
		get: url => Promise.resolve(url.startsWith('https://skills.sh/')
			? {status: 200, url, body: json({skills: [{id: 'example/skills/alpha', skillId: 'alpha', name: 'alpha', source: 'example/skills', installs: 10}]})}
			: {status: 503, url, body: text('unavailable')}),
	};

	const result = await searchMarketplace(layout, runtime, 'alpha');
	assert.equal(result.items.length, 1);
	assert.equal(result.items[0]?.relativePath, 'skills/alpha');
	assert.equal(result.items[0]?.installs, 10);
	assert.equal(result.items[0]?.freshness, 'cached');

	const unavailable: MarketplaceRuntime = {get: url => Promise.resolve({status: 503, url, body: text('unavailable')})};
	const partial = await searchMarketplace(layout, unavailable, 'alpha');
	assert.equal(partial.items.length, 1);
	assert.equal(partial.diagnostics.length, 1);
	assert.equal(await pathExists(layout.amc.marketplace), true);
});

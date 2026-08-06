import assert from 'node:assert/strict';
import {chmod, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {checkAppliedSkillUpdates, installMarketplaceSkill, readInstalledSkills, upgradeMarketplaceSkill, type MarketplaceRuntime} from '../src/core/marketplace.js';
import {createLayout} from '../src/core/index.js';
import {createTestHome, writeSkill} from './helpers.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function runtime(commit: string, description: string): MarketplaceRuntime {
	const manifest = `---\nname: alpha\ndescription: ${description}\n---\n# Alpha\n`;
	return {
		get: url => {
			const responses: Readonly<Record<string, Uint8Array>> = {
				'https://api.github.com/repos/example/skills': json({private: false, default_branch: 'main'}),
				'https://api.github.com/repos/example/skills/git/ref/heads/main': json({object: {sha: commit}}),
				[`https://api.github.com/repos/example/skills/git/trees/${commit}?recursive=1`]: json({
					truncated: false,
					tree: [{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: new TextEncoder().encode(manifest).length}],
				}),
				[`https://raw.githubusercontent.com/example/skills/${commit}/skills/alpha/SKILL.md`]: text(manifest),
			};
			const body = responses[url];
			return Promise.resolve(body === undefined ? {status: 404, url, body: text('missing')} : {status: 200, url, body});
		},
	};
}

test('read-only update check distinguishes current, remote update, and untracked applied Skills', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const first = '0123456789abcdef0123456789abcdef01234567';
	const second = '1123456789abcdef0123456789abcdef01234567';
	await installMarketplaceSkill(layout, runtime(first, 'First.'), {source: 'example/skills', skill: 'alpha'});
	await writeSkill(layout.amc.skills, 'beta', 'local only');

	assert.deepEqual(await checkAppliedSkillUpdates(layout, runtime(second, 'First.')), [
		{name: 'alpha', state: 'current'},
		{name: 'beta', state: 'untracked'},
	]);
	assert.deepEqual(await checkAppliedSkillUpdates(layout, runtime(second, 'Second.')), [
		{name: 'alpha', state: 'update'},
		{name: 'beta', state: 'untracked'},
	]);
});

test('read-only update check reports local drift before remote requests', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const first = '0123456789abcdef0123456789abcdef01234567';
	await installMarketplaceSkill(layout, runtime(first, 'First.'), {source: 'example/skills', skill: 'alpha'});
	await writeFile(join(layout.amc.skills, 'alpha', 'local.txt'), 'changed');
	let requests = 0;
	const unused: MarketplaceRuntime = {get: url => {
		requests += 1;
		return Promise.resolve({status: 500, url, body: text('unused')});
	}};
	assert.deepEqual(await checkAppliedSkillUpdates(layout, unused), [{name: 'alpha', state: 'drift'}]);
	assert.equal(requests, 0);
});

test('upgrade handles unchanged, metadata-only, and changed content versions', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const first = '0123456789abcdef0123456789abcdef01234567';
	const second = '1123456789abcdef0123456789abcdef01234567';
	const third = '2123456789abcdef0123456789abcdef01234567';
	await installMarketplaceSkill(layout, runtime(first, 'First.'), {source: 'example/skills', skill: 'alpha'});

	assert.equal((await upgradeMarketplaceSkill(layout, runtime(first, 'First.'), 'alpha')).state, 'unchanged');
	assert.equal((await upgradeMarketplaceSkill(layout, runtime(second, 'First.'), 'alpha')).state, 'metadata-updated');
	assert.equal((await readInstalledSkills(layout))['alpha']?.commit, second);

	const updated = await upgradeMarketplaceSkill(layout, runtime(third, 'Third.'), 'alpha');
	assert.equal(updated.state, 'updated');
	assert.match(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), /Third\./u);
	assert.equal((await readInstalledSkills(layout))['alpha']?.commit, third);
});

test('upgrade restores the previous canonical content when replacement verification fails', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const first = '0123456789abcdef0123456789abcdef01234567';
	const second = '1123456789abcdef0123456789abcdef01234567';
	await installMarketplaceSkill(layout, runtime(first, 'First.'), {source: 'example/skills', skill: 'alpha'});
	await assert.rejects(upgradeMarketplaceSkill(layout, runtime(second, 'Second.'), 'alpha', {
		afterReplace: path => writeFile(join(path, 'SKILL.md'), 'corrupted'),
	}), /verification/u);
	assert.match(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), /First\./u);
	assert.equal((await readInstalledSkills(layout))['alpha']?.commit, first);
});

test('upgrade treats local file mode changes as drift', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const first = '0123456789abcdef0123456789abcdef01234567';
	await installMarketplaceSkill(layout, runtime(first, 'First.'), {source: 'example/skills', skill: 'alpha'});
	await chmod(join(layout.amc.skills, 'alpha', 'SKILL.md'), 0o700);
	let requests = 0;
	const unused: MarketplaceRuntime = {get: url => {
		requests += 1;
		return Promise.resolve({status: 500, url, body: text('unused')});
	}};
	await assert.rejects(upgradeMarketplaceSkill(layout, unused, 'alpha'), /LOCAL_DRIFT/u);
	assert.equal(requests, 0);
});

test('upgrade blocks local drift before fetching and preserves local bytes', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const first = '0123456789abcdef0123456789abcdef01234567';
	await installMarketplaceSkill(layout, runtime(first, 'First.'), {source: 'example/skills', skill: 'alpha'});
	await writeFile(join(layout.amc.skills, 'alpha', 'local.txt'), 'do not overwrite');
	let requests = 0;
	const unused: MarketplaceRuntime = {get: url => {
		requests += 1;
		return Promise.resolve({status: 500, url, body: text('unused')});
	}};

	await assert.rejects(upgradeMarketplaceSkill(layout, unused, 'alpha'), /LOCAL_DRIFT/u);
	assert.equal(requests, 0);
	assert.equal(await readFile(join(layout.amc.skills, 'alpha', 'local.txt'), 'utf8'), 'do not overwrite');
});

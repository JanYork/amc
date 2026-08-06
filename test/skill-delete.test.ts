import assert from 'node:assert/strict';
import {mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
	installMarketplaceSkill,
	permanentlyDeleteSkill,
	planPermanentDelete,
	readInstalledSkills,
	type MarketplaceRuntime,
} from '../src/core/marketplace.js';
import {createLayout, setSkillEnabled} from '../src/core/index.js';
import {createTestHome, pathExists, writeSkill} from './helpers.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function runtime(): MarketplaceRuntime {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const manifest = '---\nname: alpha\ndescription: Delete me.\n---\n# Alpha\n';
	return {get: url => {
		const responses: Readonly<Record<string, Uint8Array>> = {
			'https://api.github.com/repos/example/skills': json({private: false, default_branch: 'main'}),
			'https://api.github.com/repos/example/skills/git/ref/heads/main': json({object: {sha: commit}}),
			[`https://api.github.com/repos/example/skills/git/trees/${commit}?recursive=1`]: json({truncated: false, tree: [{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: text(manifest).length}]}),
			[`https://raw.githubusercontent.com/example/skills/${commit}/skills/alpha/SKILL.md`]: text(manifest),
		};
		const body = responses[url];
		return Promise.resolve(body === undefined ? {status: 404, url, body: text('missing')} : {status: 200, url, body});
	}};
}

test('permanent delete requires a fresh exact confirmation and erases every AMC-owned copy only', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await installMarketplaceSkill(layout, runtime(), {source: 'example/skills', skill: 'alpha'});
	await setSkillEnabled(layout, 'alpha', true, ['claude', 'pi']);
	await setSkillEnabled(layout, 'alpha', false, ['pi']);
	await writeSkill(join(layout.amc.backups, 'old', 'claude'), 'alpha', 'backup');
	await writeSkill(join(layout.amc.backups, 'old', 'staging'), 'alpha', 'staging backup');
	await writeSkill(join(layout.amc.backups, 'old', 'canonical'), 'alpha', 'canonical backup');
	await writeSkill(join(layout.amc.backups, 'old', 'sources', 'agents'), 'alpha', 'reconciled shared backup');
	await writeSkill(join(layout.amc.failed, 'failed', 'canonical'), 'alpha', 'failed copy');
	await writeSkill(join(layout.amc.staging, 'pending'), 'alpha', 'pending copy');
	const outside = join(home, 'outside.txt');
	await writeFile(outside, 'outside');
	await mkdir(join(layout.amc.backups, 'old', 'links', 'codex'), {recursive: true});
	await symlink(outside, join(layout.amc.backups, 'old', 'links', 'codex', 'alpha'));
	const foreign = await writeSkill(layout.targets.codex, 'alpha', 'foreign');

	const plan = await planPermanentDelete(layout, 'alpha');
	assert.equal(plan.localDrift, false);
	assert.ok(plan.slots.length >= 8);
	await assert.rejects(permanentlyDeleteSkill(layout, plan, {challenge: plan.challenge, name: 'wrong'}), /confirmation/u);
	assert.equal(await pathExists(join(layout.amc.skills, 'alpha')), true);

	const result = await permanentlyDeleteSkill(layout, plan, {challenge: plan.challenge, name: 'alpha'});
	assert.equal(result.state, 'deleted');
	assert.equal(await pathExists(join(layout.amc.skills, 'alpha')), false);
	assert.equal(await pathExists(join(layout.targets.claude, 'alpha')), false);
	assert.equal(await pathExists(join(layout.amc.disabledLinks, 'pi', 'alpha')), false);
	assert.equal(await pathExists(join(layout.amc.backups, 'old', 'claude', 'alpha')), false);
	assert.equal(await pathExists(join(layout.amc.backups, 'old', 'sources', 'agents', 'alpha')), false);
	assert.equal(await pathExists(join(layout.amc.failed, 'failed', 'canonical', 'alpha')), false);
	assert.equal(await pathExists(join(layout.amc.staging, 'pending', 'alpha')), false);
	assert.equal(await readFile(outside, 'utf8'), 'outside');
	assert.equal(await readFile(join(foreign, 'SKILL.md'), 'utf8'), 'foreign');
	assert.equal((await readInstalledSkills(layout))['alpha'], undefined);
});

test('a stale delete plan writes nothing durable and can be replanned', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await installMarketplaceSkill(layout, runtime(), {source: 'example/skills', skill: 'alpha'});
	const plan = await planPermanentDelete(layout, 'alpha');
	await writeSkill(join(layout.amc.backups, 'late', 'staging'), 'alpha', 'late backup');
	await assert.rejects(permanentlyDeleteSkill(layout, plan, {challenge: plan.challenge, name: 'alpha'}), /stale/u);
	assert.equal(await pathExists(plan.journalPath), false);
	const fresh = await planPermanentDelete(layout, 'alpha');
	assert.ok(fresh.slots.length > plan.slots.length);
});

test('interrupted permanent delete keeps a resumable content-free journal', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await installMarketplaceSkill(layout, runtime(), {source: 'example/skills', skill: 'alpha'});
	await writeSkill(join(layout.amc.backups, 'old', 'staging'), 'alpha', 'backup');
	const plan = await planPermanentDelete(layout, 'alpha');

	await assert.rejects(permanentlyDeleteSkill(
		layout,
		plan,
		{challenge: plan.challenge, name: 'alpha'},
		{afterRemove: index => index === 0 ? Promise.reject(new Error('injected interruption')) : Promise.resolve()},
	), /injected interruption/u);
	assert.equal(await pathExists(plan.journalPath), true);

	const resumed = await planPermanentDelete(layout, 'alpha');
	assert.equal(resumed.challenge, plan.challenge);
	assert.equal((await permanentlyDeleteSkill(layout, resumed, {challenge: resumed.challenge, name: 'alpha'})).state, 'deleted');
	assert.equal(await pathExists(plan.journalPath), false);
});

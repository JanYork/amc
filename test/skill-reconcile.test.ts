import assert from 'node:assert/strict';
import {chmod, lstat, mkdir, readFile, rename, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
	createLayout,
	executeReconciliation,
	executeSkillReconciliation,
	planReconciliation,
	planSkillReconciliation,
	recoverIncompleteReconciliations,
} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

test('shared-only Skill plans one atomic adoption with independent Pi and Codex coverage', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agents, 'alpha', 'same content');

	const plan = await planSkillReconciliation(layout, 'alpha');

	assert.equal(plan.status, 'ready');
	assert.equal(plan.canonical.state, 'missing');
	assert.deepEqual(plan.providers, ['pi', 'codex']);
	assert.deepEqual(plan.sources.map(source => [source.source, source.kind]), [['agents', 'directory']]);
	assert.equal(plan.selectedSource, 'agents');
	assert.deepEqual(plan.blockers, []);
	assert.equal(await pathExists(layout.amc.root), false);
});

test('identical shared and direct copies deduplicate while divergent copies conflict without writes', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agent, 'same', 'identical');
	await writeSkill(layout.sources.claude, 'same', 'identical');
	await writeSkill(layout.sources.agents, 'different', 'shared version');
	await writeSkill(layout.sources.claude, 'different', 'claude version');

	const identical = await planSkillReconciliation(layout, 'same');
	assert.equal(identical.status, 'ready');
	assert.equal(identical.selectedSource, 'agent');
	assert.deepEqual(identical.providers, ['claude', 'pi', 'codex']);
	assert.equal(new Set(identical.sources.map(source => source.fingerprint)).size, 1);

	const divergent = await planSkillReconciliation(layout, 'different');
	assert.equal(divergent.status, 'conflict');
	assert.equal(divergent.selectedSource, undefined);
	assert.equal(new Set(divergent.sources.map(source => source.fingerprint)).size, 2);
	assert.equal(await pathExists(layout.amc.root), false);
});

test('ready shared Skill moves to canonical without copying and creates independent links', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const sourcePath = await writeSkill(layout.sources.agents, 'alpha', 'unique bytes');
	const sourceStat = await lstat(sourcePath);
	const plan = await planSkillReconciliation(layout, 'alpha');

	const result = await executeSkillReconciliation(layout, plan);

	const canonicalStat = await lstat(join(layout.amc.skills, 'alpha'));
	assert.equal(canonicalStat.dev, sourceStat.dev);
	assert.equal(canonicalStat.ino, sourceStat.ino);
	assert.equal(await pathExists(sourcePath), false);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await pathExists(join(layout.targets.claude, 'alpha')), false);
	assert.equal((await lstat(join(result.backupRoot, 'reconcile-journal.json'))).mode & 0o777, 0o600);
	assert.doesNotMatch(await readFile(join(result.backupRoot, 'reconcile-journal.json'), 'utf8'), /unique bytes/u);

	const repeated = await planSkillReconciliation(layout, 'alpha');
	assert.equal(repeated.status, 'managed');
});

test('identical sources move one inode to canonical and preserve the other in a source backup', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const selected = await writeSkill(layout.sources.agent, 'alpha', 'identical');
	const duplicate = await writeSkill(layout.sources.claude, 'alpha', 'identical');
	const selectedStat = await lstat(selected);
	const duplicateStat = await lstat(duplicate);
	const plan = await planSkillReconciliation(layout, 'alpha');

	const result = await executeSkillReconciliation(layout, plan);

	assert.equal((await lstat(join(layout.amc.skills, 'alpha'))).ino, selectedStat.ino);
	assert.equal(result.archivedSources.length, 1);
	assert.equal((await lstat(result.archivedSources[0] ?? '')).ino, duplicateStat.ino);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), join(layout.amc.skills, 'alpha'));
});

test('explicit source resolves divergent content and preserves every losing source', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agents, 'alpha', 'shared version');
	await writeSkill(layout.sources.claude, 'alpha', 'claude version');
	const plan = await planSkillReconciliation(layout, 'alpha');
	assert.equal(plan.status, 'conflict');

	const result = await executeSkillReconciliation(layout, plan, 'claude');

	assert.equal(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), 'claude version');
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(result.archivedSources.length, 1);
	assert.equal(await readFile(join(result.archivedSources[0] ?? '', 'SKILL.md'), 'utf8'), 'shared version');
});

test('explicit canonical choice keeps canonical bytes and archives a divergent shared source', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha', 'canonical version');
	const canonicalStat = await lstat(canonical);
	await writeSkill(layout.sources.agents, 'alpha', 'shared version');
	const plan = await planSkillReconciliation(layout, 'alpha');
	assert.equal(plan.status, 'conflict');

	const result = await executeSkillReconciliation(layout, plan, 'canonical');

	assert.equal(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), 'canonical version');
	assert.equal((await lstat(join(layout.amc.skills, 'alpha'))).ino, canonicalStat.ino);
	assert.equal(result.archivedSources.length, 1);
	assert.equal(await readFile(join(result.archivedSources[0] ?? '', 'SKILL.md'), 'utf8'), 'shared version');
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), join(layout.amc.skills, 'alpha'));
});

test('explicit canonical repair archives an invalid shared wrapper and restores provider links', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha', 'canonical version');
	const canonicalStat = await lstat(canonical);
	const wrapper = join(layout.sources.agents, 'alpha');
	await mkdir(join(wrapper, 'alpha'), {recursive: true});
	await writeFile(join(wrapper, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: nested\n---\n');
	await writeFile(join(wrapper, 'README.md'), 'repository wrapper');
	for (const target of ['pi', 'codex'] as const) {
		await mkdir(join(layout.amc.disabledLinks, target), {recursive: true});
		await symlink(canonical, join(layout.amc.disabledLinks, target, 'alpha'));
	}
	const plan = await planSkillReconciliation(layout, 'alpha');
	assert.equal(plan.status, 'blocked');
	assert.deepEqual(plan.sources.map(source => [source.source, source.kind]), [['agents', 'invalid']]);

	const result = await executeSkillReconciliation(layout, plan, 'canonical');

	assert.equal((await lstat(join(layout.amc.skills, 'alpha'))).ino, canonicalStat.ino);
	assert.equal(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), 'canonical version');
	assert.equal(await readFile(join(result.archivedSources[0] ?? '', 'README.md'), 'utf8'), 'repository wrapper');
	for (const target of ['pi', 'codex'] as const) {
		assert.equal(await pathExists(join(layout.targets[target], 'alpha')), false);
		assert.equal(await resolvedLink(join(layout.amc.disabledLinks, target, 'alpha')), join(layout.amc.skills, 'alpha'));
	}
});

test('stale reconciliation plan performs zero writes', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.sources.agents, 'alpha', 'before');
	const plan = await planSkillReconciliation(layout, 'alpha');
	await writeFile(join(source, 'SKILL.md'), 'after');

	await assert.rejects(executeSkillReconciliation(layout, plan), /stale/u);
	assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), 'after');
	assert.equal(await pathExists(layout.amc.root), false);
});

test('failed reconciliation restores original source and preserves recovery evidence', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const sourcePath = await writeSkill(layout.sources.agent, 'alpha', 'original');
	const plan = await planSkillReconciliation(layout, 'alpha');

	await assert.rejects(executeSkillReconciliation(layout, plan, undefined, {
		afterMove: () => Promise.reject(new Error('injected failure')),
	}), /injected failure/u);

	assert.equal(await readFile(join(sourcePath, 'SKILL.md'), 'utf8'), 'original');
	assert.equal(await pathExists(join(layout.amc.skills, 'alpha')), false);
	assert.equal(await pathExists(join(layout.targets.pi, 'alpha')), false);
	assert.equal(await pathExists(join(layout.targets.codex, 'alpha')), false);
	assert.equal((await lstat(layout.amc.failed)).isDirectory(), true);
});

test('failure after link creation restores sources and removes effective discovery', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.sources.agents, 'alpha', 'alpha');
	const plan = await planSkillReconciliation(layout, 'alpha');

	await assert.rejects(executeSkillReconciliation(layout, plan, undefined, {
		afterLink: index => index === 0 ? Promise.reject(new Error('link failure')) : Promise.resolve(),
	}), /link failure/u);

	assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), 'alpha');
	assert.equal(await pathExists(join(layout.amc.skills, 'alpha')), false);
	assert.equal(await pathExists(join(layout.targets.pi, 'alpha')), false);
	assert.equal(await pathExists(join(layout.targets.codex, 'alpha')), false);
});

test('bulk reconciliation applies ready items, skips conflicts, and is idempotent', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agents, 'alpha', 'alpha');
	await writeSkill(layout.amc.skills, 'disabled', 'disabled');
	await writeSkill(layout.sources.agents, 'divergent', 'shared');
	await writeSkill(layout.sources.claude, 'divergent', 'claude');

	const plan = await planReconciliation(layout);
	assert.deepEqual(plan.items.map(item => [item.name, item.status]), [
		['alpha', 'ready'],
		['disabled', 'managed'],
		['divergent', 'conflict'],
	]);
	const result = await executeReconciliation(layout, plan);
	assert.deepEqual(result.reconciled.map(item => item.name), ['alpha']);
	assert.deepEqual(result.managed, ['disabled']);
	assert.deepEqual(result.conflicts, ['divergent']);
	assert.deepEqual(result.blocked, []);
	assert.equal(result.failure, undefined);

	const repeated = await executeReconciliation(layout, await planReconciliation(layout));
	assert.deepEqual(repeated.reconciled, []);
	assert.deepEqual(repeated.managed, ['alpha', 'disabled']);
});

test('startup recovery restores a move completed before its journal checkpoint', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.sources.agents, 'alpha', 'alpha');
	const canonical = join(layout.amc.skills, 'alpha');
	const operationId = '2026-08-06T00-00-00.000Z-test';
	await mkdir(layout.amc.skills, {recursive: true});
	await rename(source, canonical);
	await mkdir(layout.amc.reconcileJournals, {recursive: true});
	await writeFile(join(layout.amc.reconcileJournals, `${operationId}.json`), `${JSON.stringify({
		schemaVersion: 1,
		operationId,
		name: 'alpha',
		planDigest: 'digest',
		moves: [{from: source, to: canonical}],
		links: ['pi', 'codex'],
		moved: 0,
		linked: 0,
	})}\n`, {mode: 0o600});

	const recovery = await recoverIncompleteReconciliations(layout);

	assert.deepEqual(recovery.recovered, ['alpha']);
	assert.deepEqual(recovery.failures, []);
	assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), 'alpha');
	assert.equal(await pathExists(canonical), false);
});

test('recovery rejects a journal that names paths outside approved slots', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const operationId = '2026-08-06T00-00-00.000Z-unsafe';
	const outside = join(home, 'outside');
	await writeSkill(home, 'outside', 'outside');
	await mkdir(layout.amc.reconcileJournals, {recursive: true});
	const journalPath = join(layout.amc.reconcileJournals, `${operationId}.json`);
	await writeFile(journalPath, `${JSON.stringify({
		schemaVersion: 1,
		operationId,
		name: 'alpha',
		planDigest: 'digest',
		moves: [{from: outside, to: join(layout.amc.skills, 'alpha')}],
		links: [],
		moved: 0,
		linked: 0,
	})}\n`);

	const recovery = await recoverIncompleteReconciliations(layout);
	assert.deepEqual(recovery.recovered, []);
	assert.deepEqual(recovery.failures, [journalPath]);
	assert.equal(await readFile(join(outside, 'SKILL.md'), 'utf8'), 'outside');
});

test('managed links do not trigger repeat canonical content fingerprinting', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha', 'alpha');
	await writeFile(join(canonical, 'unreadable.bin'), 'do not hash');
	await chmod(join(canonical, 'unreadable.bin'), 0o000);
	await mkdir(layout.targets.pi, {recursive: true});
	await symlink(canonical, join(layout.targets.pi, 'alpha'));

	const plan = await planSkillReconciliation(layout, 'alpha');

	assert.equal(plan.status, 'managed');
	assert.equal(plan.canonical.fingerprint, undefined);
});

test('canonical-only disabled Skill is managed and foreign source links are blocked', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'disabled', 'canonical');
	const external = await writeSkill(join(home, 'external'), 'foreign', 'external');
	await mkdir(layout.sources.agents, {recursive: true});
	await symlink(external, join(layout.sources.agents, 'foreign'));

	const disabled = await planSkillReconciliation(layout, 'disabled');
	assert.equal(disabled.status, 'managed');
	assert.deepEqual(disabled.providers, []);
	assert.equal(disabled.selectedSource, undefined);

	const foreign = await planSkillReconciliation(layout, 'foreign');
	assert.equal(foreign.status, 'blocked');
	assert.match(foreign.blockers[0]?.message ?? '', /foreign link/u);
	assert.equal(await pathExists(layout.amc.backups), false);
});

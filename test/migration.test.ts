import assert from 'node:assert/strict';
import {mkdir, readFile, readlink, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
	createLayout,
	executeMigration,
	planMigration,
} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

test('migration moves one source to backup and links it to canonical storage', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.targets.claude, 'alpha', 'single source');
	await mkdir(join(source, 'empty'), {recursive: true});
	await writeFile(join(source, 'notes.txt'), 'notes');
	await symlink('notes.txt', join(source, 'notes-link'));

	const plan = await planMigration(layout, 'alpha');

	assert.equal(plan.sourceRequired, false);
	assert.deepEqual(plan.sources.map(candidate => candidate.target), ['claude']);
	assert.deepEqual(plan.blockers, []);
	const result = await executeMigration(layout, plan);
	assert.equal(await readFile(join(result.canonicalPath, 'SKILL.md'), 'utf8'), 'single source');
	assert.equal(await readlink(join(result.canonicalPath, 'notes-link')), 'notes.txt');
	assert.equal(await pathExists(join(result.canonicalPath, 'empty')), true);
	assert.equal(result.backups.length, 1);
	assert.equal(await pathExists(join(result.backups[0]?.path ?? '', 'SKILL.md')), true);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), result.canonicalPath);
	assert.equal(await pathExists(join(layout.targets.pi, 'alpha')), false);
});

test('migration deduplicates identical unmanaged sources and backs up every original', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', 'identical');
	await writeSkill(layout.targets.pi, 'alpha', 'identical');

	const plan = await planMigration(layout, 'alpha');

	assert.equal(plan.sourceRequired, false);
	assert.equal(plan.sources.length, 2);
	const result = await executeMigration(layout, plan);
	assert.equal(result.backups.length, 2);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), result.canonicalPath);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), result.canonicalPath);
	for (const backup of result.backups) {
		assert.equal(await pathExists(join(backup.path, 'SKILL.md')), true);
	}
});

test('divergent sources require an explicit valid source and preserve both backups', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', 'claude source');
	await writeSkill(layout.targets.pi, 'alpha', 'pi source');
	const plan = await planMigration(layout, 'alpha');

	assert.equal(plan.sourceRequired, true);
	await assert.rejects(executeMigration(layout, plan), {
		name: 'AmcError',
		code: 'SOURCE_REQUIRED',
	});
	await assert.rejects(executeMigration(layout, plan, 'codex'), {
		name: 'AmcError',
		code: 'SOURCE_INVALID',
	});
	assert.equal(await pathExists(join(layout.targets.claude, 'alpha', 'SKILL.md')), true);
	assert.equal(await pathExists(layout.amc.backups), false);

	const result = await executeMigration(layout, plan, 'pi');
	assert.equal(await readFile(join(result.canonicalPath, 'SKILL.md'), 'utf8'), 'pi source');
	assert.equal(result.backups.length, 2);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), result.canonicalPath);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), result.canonicalPath);
});

test('migration adopts only an unmanaged copy identical to an existing canonical Skill', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha', 'canonical');
	await writeSkill(layout.targets.codex, 'alpha', 'canonical');

	const accepted = await planMigration(layout, 'alpha');
	assert.deepEqual(accepted.blockers, []);
	const result = await executeMigration(layout, accepted);
	assert.equal(result.canonicalPath, canonical);
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), canonical);

	const otherHome = await createTestHome();
	const otherLayout = createLayout(otherHome);
	await writeSkill(otherLayout.amc.skills, 'alpha', 'canonical');
	const unmanaged = await writeSkill(otherLayout.targets.codex, 'alpha', 'different');
	const blocked = await planMigration(otherLayout, 'alpha');
	assert.deepEqual(blocked.blockers.map(blocker => blocker.code), ['CANONICAL_DIFFERENCE']);
	await assert.rejects(executeMigration(otherLayout, blocked), {
		name: 'AmcError',
		code: 'MIGRATION_BLOCKED',
	});
	assert.equal(await readFile(join(unmanaged, 'SKILL.md'), 'utf8'), 'different');
	assert.equal(await pathExists(otherLayout.amc.backups), false);
});

test('migration reports target conflicts and writes nothing', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.targets.claude, 'alpha');
	const foreign = await writeSkill(join(home, 'foreign'), 'alpha');
	await mkdir(layout.targets.pi, {recursive: true});
	await symlink(foreign, join(layout.targets.pi, 'alpha'));

	const plan = await planMigration(layout, 'alpha');

	assert.deepEqual(plan.blockers.map(blocker => blocker.code), ['TARGET_CONFLICT']);
	await assert.rejects(executeMigration(layout, plan), {
		name: 'AmcError',
		code: 'MIGRATION_BLOCKED',
	});
	assert.equal(await pathExists(join(source, 'SKILL.md')), true);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), foreign);
	assert.equal(await pathExists(layout.amc.backups), false);
});

test('migration rejects a stale plan before moving an original', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.targets.claude, 'alpha', 'before');
	const plan = await planMigration(layout, 'alpha');
	await writeFile(join(source, 'SKILL.md'), 'after');

	await assert.rejects(executeMigration(layout, plan), {
		name: 'AmcError',
		code: 'STALE_PLAN',
	});
	assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), 'after');
	assert.equal(await pathExists(join(layout.amc.skills, 'alpha')), false);
	assert.equal(await pathExists(layout.amc.backups), false);
});

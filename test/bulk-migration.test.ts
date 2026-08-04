import assert from 'node:assert/strict';
import {lstat, mkdir, readFile, readlink, rename, symlink, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import test from 'node:test';
import {
	createLayout,
	executeBulkMigration,
	planBulkMigration,
} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

test('bulk planning is read-only, sorted, and classifies every valid logical Skill', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', 'alpha');
	await writeSkill(layout.targets.claude, 'beta', 'beta claude');
	await writeSkill(layout.targets.pi, 'beta', 'beta pi');
	await writeSkill(layout.targets.claude, 'delta', 'delta');
	await mkdir(layout.targets.pi, {recursive: true});
	await writeFile(join(layout.targets.pi, 'delta'), 'invalid collision');
	await writeSkill(layout.targets.claude, 'gamma', 'gamma');
	const gammaMissing = join(home, 'missing', 'gamma');
	await symlink(gammaMissing, join(layout.targets.pi, 'gamma'));
	await symlink(join(home, 'missing', 'broken-only'), join(layout.targets.pi, 'broken-only'));
	await writeFile(join(layout.targets.pi, 'junk'), 'not a Skill');

	const plan = await planBulkMigration(layout);

	assert.deepEqual(plan.items.map(item => [item.name, item.status]), [
		['alpha', 'ready'],
		['beta', 'divergent'],
		['delta', 'blocked'],
		['gamma', 'ready'],
	]);
	assert.deepEqual(
		plan.diagnostics.map(diagnostic => basename(diagnostic.path)).sort(),
		['broken-only', 'delta', 'gamma', 'junk'],
	);
	assert.equal(await pathExists(layout.amc.root), false);
});

test('bulk apply adopts ready Skills, repairs only colliding broken links, and is idempotent', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', 'alpha');
	await writeSkill(layout.targets.claude, 'beta', 'beta claude');
	await writeSkill(layout.targets.pi, 'beta', 'beta pi');
	await writeSkill(layout.targets.claude, 'delta', 'delta');
	await mkdir(layout.targets.pi, {recursive: true});
	const invalidDelta = join(layout.targets.pi, 'delta');
	await writeFile(invalidDelta, 'invalid collision');
	await writeSkill(layout.targets.claude, 'gamma', 'gamma');
	const gammaMissing = join(home, 'missing', 'gamma');
	const gammaBroken = join(layout.targets.pi, 'gamma');
	await symlink(gammaMissing, gammaBroken);
	const brokenOnlyDestination = join(home, 'missing', 'broken-only');
	const brokenOnly = join(layout.targets.pi, 'broken-only');
	await symlink(brokenOnlyDestination, brokenOnly);

	const first = await executeBulkMigration(layout, await planBulkMigration(layout));

	assert.deepEqual(first.migrated.map(result => result.name), ['alpha', 'gamma']);
	assert.deepEqual(first.managed, []);
	assert.deepEqual(first.divergent, ['beta']);
	assert.deepEqual(first.blocked, ['delta']);
	assert.deepEqual(first.pending, []);
	assert.equal(first.failure, undefined);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.claude, 'gamma')), join(layout.amc.skills, 'gamma'));
	assert.equal(await resolvedLink(gammaBroken), join(layout.amc.skills, 'gamma'));
	const gammaResult = first.migrated.find(result => result.name === 'gamma');
	if (gammaResult === undefined) {
		assert.fail('gamma migration result is missing');
	}
	const gammaBrokenBackup = gammaResult.backups.find(backup => backup.target === 'pi');
	if (gammaBrokenBackup === undefined) {
		assert.fail('gamma broken-link backup is missing');
	}
	assert.equal((await lstat(gammaBrokenBackup.path)).isSymbolicLink(), true);
	assert.equal(await readlink(gammaBrokenBackup.path), gammaMissing);
	assert.equal(await readlink(brokenOnly), brokenOnlyDestination);
	assert.equal(await readFile(invalidDelta, 'utf8'), 'invalid collision');

	const secondPlan = await planBulkMigration(layout);
	assert.deepEqual(secondPlan.items.map(item => [item.name, item.status]), [
		['alpha', 'managed'],
		['beta', 'divergent'],
		['delta', 'blocked'],
		['gamma', 'managed'],
	]);
	const second = await executeBulkMigration(layout, secondPlan);
	assert.deepEqual(second.migrated, []);
	assert.deepEqual(second.managed, ['alpha', 'gamma']);
	assert.deepEqual(second.divergent, ['beta']);
	assert.deepEqual(second.blocked, ['delta']);
	assert.equal(second.failure, undefined);
});

test('bulk apply stops on the first stale Skill and a fresh run resumes from filesystem truth', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const alpha = await writeSkill(layout.targets.claude, 'alpha', 'alpha before');
	const beta = await writeSkill(layout.targets.claude, 'beta', 'beta');
	const stalePlan = await planBulkMigration(layout);
	await writeFile(join(alpha, 'SKILL.md'), 'alpha after');

	const stopped = await executeBulkMigration(layout, stalePlan);

	assert.deepEqual(stopped.migrated, []);
	assert.equal(stopped.failure?.name, 'alpha');
	assert.equal(stopped.failure?.code, 'STALE_PLAN');
	assert.deepEqual(stopped.pending, ['beta']);
	assert.equal(await readFile(join(alpha, 'SKILL.md'), 'utf8'), 'alpha after');
	assert.equal(await readFile(join(beta, 'SKILL.md'), 'utf8'), 'beta');

	const resumed = await executeBulkMigration(layout, await planBulkMigration(layout));
	assert.deepEqual(resumed.migrated.map(result => result.name), ['alpha', 'beta']);
	assert.equal(resumed.failure, undefined);
});

test('bulk apply rejects foreign-link path drift even when content remains identical', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const firstExternal = await writeSkill(join(home, 'external-a'), 'alpha', 'same content');
	const secondExternal = await writeSkill(join(home, 'external-b'), 'alpha', 'same content');
	await mkdir(layout.targets.claude, {recursive: true});
	const targetPath = join(layout.targets.claude, 'alpha');
	const preservedLink = join(layout.targets.claude, 'alpha-before-drift');
	await symlink(firstExternal, targetPath);
	const plan = await planBulkMigration(layout);
	await rename(targetPath, preservedLink);
	await symlink(secondExternal, targetPath);

	const result = await executeBulkMigration(layout, plan);

	assert.equal(result.failure?.code, 'STALE_PLAN');
	assert.equal(await resolvedLink(targetPath), secondExternal);
	assert.equal(await resolvedLink(preservedLink), firstExternal);
	assert.equal(await pathExists(layout.amc.root), false);
});

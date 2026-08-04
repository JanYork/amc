import assert from 'node:assert/strict';
import {lstat, mkdir, readFile, readdir, readlink, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
	AmcError,
	createLayout,
	executeMigration,
	planMigration,
} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

async function waitUntilMissing(path: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (!(await pathExists(path))) {
			return;
		}
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	assert.fail(`Timed out waiting for path to move: ${path}`);
}

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

test('migration adopts valid foreign links without mutating their resolved source', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const external = await writeSkill(join(home, 'external'), 'alpha', 'external source');
	await writeFile(join(external, 'notes.txt'), 'external notes');
	await symlink('notes.txt', join(external, 'notes-link'));
	await mkdir(layout.targets.claude, {recursive: true});
	await mkdir(layout.targets.pi, {recursive: true});
	await symlink(external, join(layout.targets.claude, 'alpha'));
	await symlink(external, join(layout.targets.pi, 'alpha'));
	const beforeSkill = await lstat(join(external, 'SKILL.md'));

	const plan = await planMigration(layout, 'alpha');

	assert.deepEqual(plan.blockers, []);
	assert.equal(plan.sourceRequired, false);
	assert.deepEqual(plan.sources.map(source => ({
		target: source.target,
		path: source.path,
		contentPath: source.contentPath,
		kind: source.kind,
	})), [
		{
			target: 'claude',
			path: join(layout.targets.claude, 'alpha'),
			contentPath: external,
			kind: 'foreign-link',
		},
		{
			target: 'pi',
			path: join(layout.targets.pi, 'alpha'),
			contentPath: external,
			kind: 'foreign-link',
		},
	]);

	const result = await executeMigration(layout, plan);
	assert.equal(await readFile(join(result.canonicalPath, 'SKILL.md'), 'utf8'), 'external source');
	assert.equal(await readlink(join(result.canonicalPath, 'notes-link')), 'notes.txt');
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), result.canonicalPath);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), result.canonicalPath);
	assert.equal(await readFile(join(external, 'SKILL.md'), 'utf8'), 'external source');
	assert.equal(await readFile(join(external, 'notes.txt'), 'utf8'), 'external notes');
	assert.equal(await readlink(join(external, 'notes-link')), 'notes.txt');
	assert.equal((await lstat(join(external, 'SKILL.md'))).ino, beforeSkill.ino);
	for (const backup of result.backups) {
		assert.equal((await lstat(backup.path)).isSymbolicLink(), true);
		assert.equal(await resolvedLink(backup.path), external);
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
	await mkdir(layout.targets.pi, {recursive: true});
	const invalid = join(layout.targets.pi, 'alpha');
	await writeFile(invalid, 'invalid collision');

	const plan = await planMigration(layout, 'alpha');

	assert.deepEqual(plan.blockers.map(blocker => blocker.code), ['TARGET_CONFLICT']);
	await assert.rejects(executeMigration(layout, plan), {
		name: 'AmcError',
		code: 'MIGRATION_BLOCKED',
	});
	assert.equal(await pathExists(join(source, 'SKILL.md')), true);
	assert.equal(await readFile(invalid, 'utf8'), 'invalid collision');
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

test('migration never overwrites a canonical path created after planning', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.targets.claude, 'alpha', 'planned source');
	const plan = await planMigration(layout, 'alpha');
	const canonical = await writeSkill(layout.amc.skills, 'alpha', 'concurrent canonical');

	await assert.rejects(executeMigration(layout, plan), {
		name: 'AmcError',
		code: 'STALE_PLAN',
	});
	assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), 'planned source');
	assert.equal(await readFile(join(canonical, 'SKILL.md'), 'utf8'), 'concurrent canonical');
	assert.equal(await pathExists(layout.amc.backups), false);
});

test('migration preserves both objects when a target path reappears during apply', async () => {
	type Outcome =
		| Readonly<{kind: 'result'}>
		| Readonly<{kind: 'error'; error: unknown}>;

	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.targets.claude, 'alpha', 'original source');
	const payload = join(source, 'payload');
	await mkdir(payload);
	await Promise.all(Array.from({length: 300}, (_, index) =>
		writeFile(join(payload, `${index}.txt`), `payload ${index}`),
	));
	const plan = await planMigration(layout, 'alpha');
	const outcomePromise: Promise<Outcome> = executeMigration(layout, plan).then(
		() => ({kind: 'result'}),
		(error: unknown) => ({kind: 'error', error}),
	);

	await waitUntilMissing(source);
	await mkdir(source);
	await writeFile(join(source, 'SKILL.md'), 'concurrent object');
	const outcome = await outcomePromise;

	assert.equal(outcome.kind, 'error');
	if (outcome.kind !== 'error') {
		assert.fail('Migration unexpectedly succeeded after a target collision.');
	}
	if (!(outcome.error instanceof AmcError)) {
		assert.fail('Migration failed with a non-AMC error.');
	}
	const error = outcome.error;
	assert.equal(error.code, 'ROLLBACK_FAILED');
	const operationIds = await readdir(layout.amc.backups);
	assert.equal(operationIds.length, 1);
	const backupPath = join(layout.amc.backups, operationIds[0] ?? '', 'claude', 'alpha');
	assert.equal(await readFile(join(source, 'SKILL.md'), 'utf8'), 'concurrent object');
	assert.equal(await readFile(join(backupPath, 'SKILL.md'), 'utf8'), 'original source');
	assert.match(error.message, new RegExp(source.replaceAll('/', '\\/'), 'u'));
	assert.match(error.message, new RegExp(backupPath.replaceAll('/', '\\/'), 'u'));
});

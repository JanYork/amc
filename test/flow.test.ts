import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import test from 'node:test';
import {executeCommand} from '../src/cli/index.js';
import {createLayout} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

const binary = join(process.cwd(), 'dist', 'src', 'main.js');

function runBinary(home: string, arguments_: ReadonlyArray<string>) {
	return spawnSync(process.execPath, [binary, ...arguments_], {
		encoding: 'utf8',
		env: {...process.env, HOME: home},
	});
}

test('headless list formats the exact core state without creating stores', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha');
	await writeSkill(layout.targets.pi, 'beta');

	assert.equal(await executeCommand(layout, {kind: 'list'}), [
		'Skill\tClaude\tPi\tCodex',
		'alpha\tdisabled\tdisabled\tdisabled',
		'beta\tdisabled\tunmanaged\tdisabled',
	].join('\n'));
	assert.equal(await pathExists(layout.amc.backups), false);
});

test('headless enable, disable, and migrate call the shared core', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha');

	assert.match(await executeCommand(layout, {kind: 'enable', name: 'alpha', target: 'codex'}), /codex=changed/);
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), canonical);
	assert.match(await executeCommand(layout, {kind: 'disable', name: 'alpha', target: 'codex'}), /codex=changed/);
	assert.equal(await pathExists(join(layout.targets.codex, 'alpha')), false);

	await writeSkill(layout.targets.pi, 'beta', 'migrate me');
	const output = await executeCommand(layout, {kind: 'migrate', name: 'beta', source: undefined});
	assert.match(output, /^Migrated beta to /);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'beta')), join(layout.amc.skills, 'beta'));
});

test('compiled binary supports help, empty list, and usage exit codes in an isolated home', async () => {
	const home = await createTestHome();

	const help = runBinary(home, ['--help']);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /AMC — Agent Management CLI/);

	const list = runBinary(home, ['list']);
	assert.equal(list.status, 0, list.stderr);
	assert.equal(list.stdout, 'No Skills found.\n');
	assert.equal(await pathExists(join(home, '.amc')), false);

	const invalid = runBinary(home, ['enable']);
	assert.equal(invalid.status, 2);
	assert.match(invalid.stderr, /Invalid command arguments/);
});

test('compiled headless binary completes migrate, disable, enable, and list end to end', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', 'binary flow');

	const migrated = runBinary(home, ['migrate', 'alpha']);
	assert.equal(migrated.status, 0, migrated.stderr);
	assert.match(migrated.stdout, /^Migrated alpha/);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await pathExists(layout.amc.backups), true);

	const disabled = runBinary(home, ['disable', 'alpha']);
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.match(disabled.stdout, /claude=changed pi=no-op codex=no-op/);

	const enabled = runBinary(home, ['enable', 'alpha', '--target', 'codex']);
	assert.equal(enabled.status, 0, enabled.stderr);
	assert.match(enabled.stdout, /codex=changed/);

	const listed = runBinary(home, ['list']);
	assert.equal(listed.status, 0, listed.stderr);
	assert.match(listed.stdout, /alpha\tdisabled\tdisabled\tenabled/);
});

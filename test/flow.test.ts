import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import test from 'node:test';
import {executeCommand} from '../src/cli/index.js';
import {createLayout} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

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
	const binary = join(process.cwd(), 'dist', 'src', 'main.js');
	const environment = {...process.env, HOME: home};

	const help = spawnSync(process.execPath, [binary, '--help'], {encoding: 'utf8', env: environment});
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /AMC — Agent Management CLI/);

	const list = spawnSync(process.execPath, [binary, 'list'], {encoding: 'utf8', env: environment});
	assert.equal(list.status, 0, list.stderr);
	assert.equal(list.stdout, 'No Skills found.\n');
	assert.equal(await pathExists(join(home, '.amc')), false);

	const invalid = spawnSync(process.execPath, [binary, 'enable'], {encoding: 'utf8', env: environment});
	assert.equal(invalid.status, 2);
	assert.match(invalid.stderr, /Invalid command arguments/);
});

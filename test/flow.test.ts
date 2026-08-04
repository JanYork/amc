import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
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

	assert.equal(await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: false,
	}), [
		'AMC Skills · 2 total · 0 warnings',
		'',
		'SKILL  CLAUDE     PI         CODEX',
		'alpha  disabled   disabled   disabled',
		'beta   disabled   unmanaged  disabled',
		'',
		'Showing 1–2 of 2 · Page 1/1',
	].join('\n'));
	assert.equal(await pathExists(layout.amc.backups), false);
});

test('headless list renders bounded pages, search, and separate diagnostics', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	for (let index = 1; index <= 25; index += 1) {
		await writeSkill(layout.amc.skills, `skill-${String(index).padStart(2, '0')}`);
	}
	await mkdir(layout.targets.claude, {recursive: true});
	const invalidPath = join(layout.targets.claude, 'not-a-skill');
	await writeFile(invalidPath, 'invalid');

	const firstPage = await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: false,
	}, {isTTY: false, columns: 80});
	assert.match(firstPage, /^AMC Skills · 25 total · 1 warning/m);
	assert.equal(firstPage.split('\n').filter(line => line.startsWith('skill-')).length, 20);
	assert.match(firstPage, /Showing 1–20 of 25 · Page 1\/2/);
	assert.match(firstPage, /Next: amc list --page 2/);
	assert.doesNotMatch(firstPage, /skill-21/);
	assert.doesNotMatch(firstPage, /not-a-skill/);

	const secondPage = await executeCommand(layout, {
		kind: 'list',
		page: 2,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: false,
	}, {isTTY: false, columns: 80});
	assert.equal(secondPage.split('\n').filter(line => line.startsWith('skill-')).length, 5);
	assert.match(secondPage, /skill-21/);
	assert.match(secondPage, /Showing 21–25 of 25 · Page 2\/2/);

	const searched = await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: true,
		search: 'SKILL-2',
		diagnostics: false,
	}, {isTTY: false, columns: 80});
	assert.equal(searched.split('\n').filter(line => line.startsWith('skill-')).length, 6);
	assert.doesNotMatch(searched, /skill-19/);

	const diagnostics = await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: true,
	}, {isTTY: false, columns: 80});
	assert.match(diagnostics, /^AMC Diagnostics · 1 total/m);
	assert.match(diagnostics, /not-a-skill/);
	assert.doesNotMatch(diagnostics, /^skill-01/m);
	assert.doesNotMatch(diagnostics, /\u001B\[/u);
});

test('redirected list preserves complete long names without ANSI', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const longName = `skill-${'very-long-'.repeat(12)}`;
	await writeSkill(layout.amc.skills, longName);

	const output = await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: false,
	}, {isTTY: false, columns: 44});
	assert.match(output, new RegExp(longName, 'u'));
	assert.doesNotMatch(output, /\u001B\[/u);
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
	assert.equal(list.stdout, [
		'AMC Skills · 0 total · 0 warnings',
		'',
		'No Skills found.',
		'',
		'Showing 0–0 of 0 · Page 1/1',
		'',
	].join('\n'));
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
	assert.match(listed.stdout, /alpha\s+disabled\s+disabled\s+enabled/);
});

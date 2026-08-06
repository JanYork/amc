import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {executeCommand} from '../src/cli/index.js';
import {createLayout} from '../src/core/index.js';
import type {ResourceRuntime} from '../src/core/resources.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

const binary = join(process.cwd(), 'dist', 'src', 'main.js');

function runBinary(home: string, arguments_: ReadonlyArray<string>, input?: string) {
	return spawnSync(process.execPath, [binary, ...arguments_], {
		encoding: 'utf8',
		env: {...process.env, HOME: home},
		input,
	});
}

test('compiled CLI persists a GitHub Token from stdin without echoing it', async () => {
	const home = await createTestHome();
	const secret = 'github_pat_compiled_abcdefghijklmnopqrstuvwxyz';
	const result = runBinary(home, ['auth', 'github', 'set', '--token-stdin'], `${secret}\n`);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, 'GitHub Token configured.\n');
	assert.equal(result.stdout.includes(secret), false);
	assert.equal(result.stderr.includes(secret), false);
	assert.equal(await readFile(join(home, '.amc', 'credentials', 'github-token'), 'utf8'), `${secret}\n`);
});

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
		'┌───────┬───────────┬───────────┬───────────┐',
		'│ SKILL │ CLAUDE    │ PI        │ CODEX     │',
		'├───────┼───────────┼───────────┼───────────┤',
		'│ alpha │ disabled  │ disabled  │ disabled  │',
		'│ beta  │ disabled  │ unmanaged │ disabled  │',
		'└───────┴───────────┴───────────┴───────────┘',
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
	}, {isTTY: false, columns: 80, presentation: {theme: 'mono', colorDepth: 1}});
	assert.match(firstPage, /^AMC Skills · 25 total · 1 warning/m);
	assert.equal(firstPage.split('\n').filter(line => line.startsWith('│ skill-')).length, 20);
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
	}, {isTTY: false, columns: 80, presentation: {theme: 'mono', colorDepth: 1}});
	assert.equal(secondPage.split('\n').filter(line => line.startsWith('│ skill-')).length, 5);
	assert.match(secondPage, /skill-21/);
	assert.match(secondPage, /Showing 21–25 of 25 · Page 2\/2/);

	const searched = await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: true,
		search: 'SKILL-2',
		diagnostics: false,
	}, {isTTY: false, columns: 80, presentation: {theme: 'mono', colorDepth: 1}});
	assert.equal(searched.split('\n').filter(line => line.startsWith('│ skill-')).length, 6);
	assert.doesNotMatch(searched, /skill-19/);

	const diagnostics = await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: true,
	}, {isTTY: false, columns: 80, presentation: {theme: 'mono', colorDepth: 1}});
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
	}, {isTTY: false, columns: 44, presentation: {theme: 'mono', colorDepth: 1}});
	assert.match(output, new RegExp(longName, 'u'));
	assert.match(output, /┌.*┬.*┐/u);
	assert.doesNotMatch(output, /\u001B\[/u);
});

test('interactive list uses table borders and ANSI emphasis', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha');

	const output = await executeCommand(layout, {
		kind: 'list',
		page: 1,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: false,
	}, {
		isTTY: true,
		columns: 80,
		presentation: {theme: 'dark', colorDepth: 24},
	});

	assert.match(output, /┌.*┬.*┐/u);
	assert.match(output, /\u001B\[38;2;204;120;92mAMC\u001B\[0m/u);
	assert.match(output, /\u001B\[38;2;85;82;78m┌/u);
	assert.match(output, /\u001B\[38;2;232;165;90munmanaged/u);
	assert.doesNotMatch(output, /\u001B\[[^m]*36m/u);
});

test('headless plugin list reports Pi packages as installed and interactive', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const runtime: ResourceRuntime = {
		run: program => Promise.resolve({
			exitCode: 0,
			stdout: program === 'pi'
				? 'User packages:\n  npm:pi-tools@1.2.3\n    /tmp/pi-tools\n'
				: program === 'claude' ? '[]' : '{"installed":[]}',
			stderr: '',
		}),
		openEditor: () => Promise.resolve(),
	};
	const output = await executeCommand(layout, {
		kind: 'plugins-list', page: 1, limit: 20, all: false, search: undefined,
	}, undefined, {context: {home, cwd: home}, runtime});

	assert.match(output, /^AMC Plugins · 1 shown · 0 warnings/mu);
	assert.match(output, /npm:pi-tools@1\.2\.3.*pi.*installed.*native-interactive/u);
	assert.doesNotMatch(output, /unknown/u);
});

test('headless MCP list is paginated, searchable, and never prints transport secrets', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const runtime: ResourceRuntime = {
		run: () => Promise.resolve({
			exitCode: 0,
			stdout: JSON.stringify([{name: 'node_repl', enabled: true, transport: {type: 'stdio', env: {TOKEN: 'do-not-print'}}}]),
			stderr: '',
		}),
		openEditor: () => Promise.resolve(),
	};
	const output = await executeCommand(layout, {
		kind: 'mcp-list', page: 1, limit: 20, all: false, search: 'node',
	}, undefined, {context: {home, cwd: home}, runtime});

	assert.match(output, /^AMC MCP · 1 shown · 0 warnings/mu);
	assert.match(output, /node_repl.*codex.*user.*stdio.*enabled/u);
	assert.match(output, /Pi does not provide native MCP/u);
	assert.doesNotMatch(output, /do-not-print|TOKEN/u);
});

test('headless bulk dry run caps the human preview without hiding totals', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	for (let index = 0; index < 15; index += 1) {
		await writeSkill(layout.targets.claude, `skill-${String(index).padStart(2, '0')}`);
	}

	const output = await executeCommand(layout, {kind: 'migrate-all', apply: false});

	assert.match(output, /Ready 15/);
	assert.match(output, /skill-09/);
	assert.doesNotMatch(output, /skill-10/);
	assert.match(output, /… 5 more/);
	assert.ok(output.split('\n').length <= 24, output);
	assert.equal(await pathExists(layout.amc.root), false);
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

test('headless list reports shared effective discovery instead of disabled links', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agents, 'alpha', 'shared');

	const output = await executeCommand(layout, {
		kind: 'list', page: 1, limit: 20, all: false, search: undefined, diagnostics: false,
	});

	assert.match(output, /alpha\s+│\s+disabled\s+│\s+shared\s+│\s+shared/u);
	assert.equal(await pathExists(layout.amc.root), false);
});

test('headless reconcile preview is read-only and explicit apply adopts shared Skills', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agents, 'alpha', 'shared alpha');

	const preview = await executeCommand(layout, {kind: 'reconcile', apply: false, name: undefined, source: undefined});
	assert.match(preview, /alpha\s+ready\s+pi,codex\s+agents/u);
	assert.equal(await pathExists(layout.amc.root), false);

	const applied = await executeCommand(layout, {kind: 'reconcile', apply: true, name: undefined, source: undefined});
	assert.match(applied, /Reconciled 1 Skills/u);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), join(layout.amc.skills, 'alpha'));
});

test('compiled reconcile preview stays read-only and explicit apply splits shared discovery', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agent, 'alpha', 'compiled shared');

	const preview = runBinary(home, ['reconcile']);
	assert.equal(preview.status, 0, preview.stderr);
	assert.match(preview.stdout, /alpha\s+ready\s+pi,codex\s+agent/u);
	assert.equal(await pathExists(layout.amc.root), false);

	const applied = runBinary(home, ['reconcile', '--apply', '--yes']);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.stdout, /Reconciled 1 Skills/u);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await pathExists(join(layout.sources.agent, 'alpha')), false);
});

test('compiled reconcile resolves an exact divergent source and supports prototype toggles', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.sources.agents, 'alpha', 'shared');
	await writeSkill(layout.sources.claude, 'alpha', 'claude');

	const resolved = runBinary(home, ['reconcile', 'alpha', '--source', 'claude', '--apply', '--yes']);
	assert.equal(resolved.status, 0, resolved.stderr);
	assert.match(resolved.stdout, /Reconciled alpha/u);
	assert.equal(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), 'claude');
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), join(layout.amc.skills, 'alpha'));

	await writeSkill(layout.amc.skills, 'prototype', 'prototype');
	const enabled = runBinary(home, ['enable', 'prototype', '--target', 'claude']);
	assert.equal(enabled.status, 0, enabled.stderr);
	const disabled = runBinary(home, ['disable', 'prototype', '--target', 'claude']);
	assert.equal(disabled.status, 0, disabled.stderr);
	assert.equal(await pathExists(join(layout.targets.claude, 'prototype')), false);
});

test('compiled bulk migrate dry run is read-only and apply mode adopts only ready Skills', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.pi, 'beta', 'beta source');
	await writeSkill(layout.targets.claude, 'alpha', 'alpha source');
	await writeSkill(layout.targets.claude, 'gamma', 'gamma claude');
	await writeSkill(layout.targets.pi, 'gamma', 'gamma pi');

	const dryRun = runBinary(home, ['migrate', '--all']);
	assert.equal(dryRun.status, 0, dryRun.stderr);
	assert.match(dryRun.stdout, /DRY RUN/);
	assert.match(dryRun.stdout, /Ready/);
	assert.match(dryRun.stdout, /alpha/);
	assert.match(dryRun.stdout, /beta/);
	assert.match(dryRun.stdout, /gamma/);
	assert.ok(dryRun.stdout.indexOf('alpha') < dryRun.stdout.indexOf('beta'));
	assert.ok(dryRun.stdout.trimEnd().split('\n').length <= 24, dryRun.stdout);
	assert.equal(await pathExists(layout.amc.root), false);
	assert.equal(await pathExists(join(layout.targets.claude, 'alpha', 'SKILL.md')), true);
	assert.equal(await pathExists(join(layout.targets.pi, 'beta', 'SKILL.md')), true);

	const applied = runBinary(home, ['migrate', '--all', '--yes']);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.stdout, /alpha/);
	assert.match(applied.stdout, /beta/);
	assert.match(applied.stdout, /gamma/);
	assert.match(applied.stdout, /\.amc\/backups\//);
	assert.ok(applied.stdout.indexOf('alpha') < applied.stdout.indexOf('beta'));
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.pi, 'beta')), join(layout.amc.skills, 'beta'));
	assert.equal(await pathExists(join(layout.targets.claude, 'gamma', 'SKILL.md')), true);
	assert.equal(await pathExists(join(layout.targets.pi, 'gamma', 'SKILL.md')), true);

	const repeated = runBinary(home, ['migrate', '--all', '--yes']);
	assert.equal(repeated.status, 0, repeated.stderr);
	assert.match(repeated.stdout, /managed/i);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), join(layout.amc.skills, 'alpha'));
	assert.equal(await resolvedLink(join(layout.targets.pi, 'beta')), join(layout.amc.skills, 'beta'));
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
	assert.match(listed.stdout, /│ alpha\s+│ disabled\s+│ disabled\s+│ enabled/);
});

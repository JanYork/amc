import assert from 'node:assert/strict';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
	editHook,
	scanMcpServers,
	scanHooks,
	scanPlugins,
	setMcpServerEnabled,
	setPluginEnabled,
	type ResourceContext,
	type ResourceRuntime,
} from '../src/core/resources.js';
import {createTestHome} from './helpers.js';

type Call = Readonly<{program: string; arguments_: ReadonlyArray<string>}>;

const contextFor = (home: string): ResourceContext => ({home, cwd: join(home, 'project')});

const runtimeWith = (
	outputs: Readonly<Record<string, string>>,
	calls: Array<Call> = [],
): ResourceRuntime => ({
	run: (program, arguments_) => {
		calls.push({program, arguments_});
		const key = `${program} ${arguments_.join(' ')}`;
		const stdout = outputs[key];
		return Promise.resolve(stdout === undefined
			? {exitCode: 1, stdout: '', stderr: `missing fixture: ${key}`}
			: {exitCode: 0, stdout, stderr: ''});
	},
	openEditor: path => {
		calls.push({program: 'editor', arguments_: [path]});
		return Promise.resolve();
	},
});

test('scanPlugins normalizes Claude, Codex, and Pi without hiding provider failures', async () => {
	const runtime = runtimeWith({
		'claude plugin list --json': JSON.stringify([
			{id: 'review@official', version: '1.2.0', scope: 'user', enabled: true},
		]),
		'codex plugin list --json': JSON.stringify({installed: [
			{id: 'docs', version: '0.4.0', enabled: false},
		]}),
		'pi list': 'User packages:\n  npm:pi-tools\n    /tmp/pi-tools\n',
	});

	const result = await scanPlugins(contextFor('/tmp/amc-home'), runtime);

	assert.deepEqual(result.plugins, [
		{
			id: 'claude:review@official',
			provider: 'claude',
			name: 'review@official',
			version: '1.2.0',
			scope: 'user',
			state: 'enabled',
			capability: 'native-headless',
		},
		{
			id: 'codex:docs',
			provider: 'codex',
			name: 'docs',
			version: '0.4.0',
			scope: undefined,
			state: 'disabled',
			capability: 'config-edit',
		},
		{
			id: 'pi:npm:pi-tools',
			provider: 'pi',
			name: 'npm:pi-tools',
			version: undefined,
			scope: 'user',
			state: 'unknown',
			capability: 'native-interactive',
		},
	]);
	assert.deepEqual(result.diagnostics, []);

	const partial = await scanPlugins(contextFor('/tmp/amc-home'), runtimeWith({
		'claude plugin list --json': '[]',
		'pi list': '',
	}));
	assert.equal(partial.plugins.length, 0);
	assert.equal(partial.diagnostics.length, 1);
	assert.equal(partial.diagnostics[0]?.provider, 'codex');
});

test('setPluginEnabled mutates Claude natively and Codex through backed-up config', async () => {
	const calls: Array<Call> = [];
	let enabled = false;
	const runtime: ResourceRuntime = {
		run: (program, arguments_) => {
			calls.push({program, arguments_});
			if (program === 'claude' && arguments_[0] === 'plugin' && arguments_[1] === 'enable') {
				enabled = true;
				return Promise.resolve({exitCode: 0, stdout: '', stderr: ''});
			}
			if (program === 'claude') {
				return Promise.resolve({
					exitCode: 0,
					stdout: JSON.stringify([{id: 'review@official', scope: 'user', enabled}]),
					stderr: '',
				});
			}
			return Promise.resolve({exitCode: 0, stdout: program === 'pi' ? '' : '{"installed":[]}', stderr: ''});
		},
		openEditor: () => Promise.resolve(),
	};

	const changed = await setPluginEnabled(contextFor('/tmp/amc-home'), runtime, 'claude:review@official', true);
	assert.equal(changed.state, 'enabled');
	assert.deepEqual(calls.find(call => call.arguments_[1] === 'enable'), {
		program: 'claude',
		arguments_: ['plugin', 'enable', 'review@official', '--scope', 'user'],
	});

	const home = await createTestHome();
	const configPath = join(home, '.codex', 'config.toml');
	await mkdir(join(home, '.codex'), {recursive: true});
	await writeFile(configPath, '[plugins."docs"]\nenabled = false\n', 'utf8');
	const codexRuntime: ResourceRuntime = {
		run: async program => {
			if (program === 'codex') {
				const config = await readFile(configPath, 'utf8');
				return {exitCode: 0, stdout: JSON.stringify({installed: [{id: 'docs', enabled: /enabled = true/u.test(config)}]}), stderr: ''};
			}
			return {exitCode: 0, stdout: program === 'claude' ? '[]' : '', stderr: ''};
		},
		openEditor: () => Promise.resolve(),
	};
	const codex = await setPluginEnabled(contextFor(home), codexRuntime, 'codex:docs', true);
	assert.equal(codex.state, 'enabled');
	assert.match(await readFile(configPath, 'utf8'), /\[plugins\."docs"\]\nenabled = true/u);
	assert.equal((await readdir(join(home, '.codex'))).some(name => name.startsWith('config.toml.amc-backup-')), true);
});

test('scanMcpServers normalizes Codex and Claude while reporting Pi as unsupported', async () => {
	const home = await createTestHome();
	const context = contextFor(home);
	await mkdir(context.cwd, {recursive: true});
	await writeFile(join(home, '.claude.json'), JSON.stringify({
		mcpServers: {codegraph: {command: 'codegraph', args: ['serve', '--mcp']}},
		projects: {[context.cwd]: {disabledMcpServers: ['codegraph']}},
	}), 'utf8');
	await writeFile(join(context.cwd, '.mcp.json'), JSON.stringify({
		mcpServers: {browser: {type: 'http', url: 'https://example.invalid/mcp'}},
	}), 'utf8');
	await mkdir(join(context.cwd, '.codex'), {recursive: true});
	await writeFile(join(context.cwd, '.codex', 'config.toml'), '[mcp_servers.node_repl]\ncommand = "node"\n', 'utf8');
	const runtime = runtimeWith({
		'codex mcp list --json': JSON.stringify([
			{name: 'node_repl', enabled: true, transport: {type: 'stdio'}},
		]),
	});

	const result = await scanMcpServers(context, runtime);
	assert.deepEqual(result.servers.map(server => [server.id, server.scope, server.transport, server.state, server.capability]), [
		['claude:browser:project', 'project', 'http', 'enabled', 'config-edit'],
		['claude:codegraph:user', 'user', 'stdio', 'disabled', 'config-edit'],
		['codex:node_repl:project', 'project', 'stdio', 'enabled', 'config-edit'],
	]);
	assert.equal(result.notes.some(note => note.includes('Pi does not provide native MCP')), true);
});

test('setMcpServerEnabled updates Codex config atomically and confirms state', async () => {
	const home = await createTestHome();
	const context = contextFor(home);
	const configPath = join(home, '.codex', 'config.toml');
	await mkdir(join(home, '.codex'), {recursive: true});
	await writeFile(configPath, '[mcp_servers.node_repl]\ncommand = "node"\nenabled = false\n', 'utf8');
	const runtime: ResourceRuntime = {
		run: async program => {
			if (program !== 'codex') {
				return {exitCode: 1, stdout: '', stderr: 'unexpected'};
			}
			const config = await readFile(configPath, 'utf8');
			return {exitCode: 0, stdout: JSON.stringify([{name: 'node_repl', enabled: /enabled = true/u.test(config), transport: {type: 'stdio'}}]), stderr: ''};
		},
		openEditor: () => Promise.resolve(),
	};

	const changed = await setMcpServerEnabled(context, runtime, 'codex:node_repl:user', true);
	assert.equal(changed.state, 'enabled');
	assert.match(await readFile(configPath, 'utf8'), /enabled = true/u);
});

test('Codex config mutation restores the original when inventory confirmation fails', async () => {
	const home = await createTestHome();
	const context = contextFor(home);
	const configPath = join(home, '.codex', 'config.toml');
	const original = '[mcp_servers.node_repl]\ncommand = "node"\nenabled = false\n';
	await mkdir(join(home, '.codex'), {recursive: true});
	await writeFile(configPath, original, 'utf8');
	const runtime = runtimeWith({
		'codex mcp list --json': '[{"name":"node_repl","enabled":false,"transport":{"type":"stdio"}}]',
	});

	await assert.rejects(
		setMcpServerEnabled(context, runtime, 'codex:node_repl:user', true),
		/CONFIG_CONFIRMATION_FAILED: original config restored/u,
	);
	assert.equal(await readFile(configPath, 'utf8'), original);
});

test('setMcpServerEnabled persists a scoped Claude disable with a backup', async () => {
	const home = await createTestHome();
	const context = contextFor(home);
	await mkdir(context.cwd, {recursive: true});
	const configPath = join(home, '.claude.json');
	await writeFile(configPath, JSON.stringify({
		mcpServers: {codegraph: {command: 'codegraph'}},
		projects: {},
	}), 'utf8');
	const runtime = runtimeWith({'codex mcp list --json': '[]'});

	const changed = await setMcpServerEnabled(context, runtime, 'claude:codegraph:user', false);
	assert.equal(changed.state, 'disabled');
	assert.match(await readFile(configPath, 'utf8'), /"disabledMcpServers": \[\s*"codegraph"/u);
	assert.equal((await readdir(home)).some(name => name.startsWith('.claude.json.amc-backup-')), true);
});

test('scanHooks reads provider-owned config and Pi extensions without executing them', async () => {
	const home = await createTestHome();
	const context = contextFor(home);
	await mkdir(join(home, '.claude'), {recursive: true});
	await mkdir(join(home, '.codex'), {recursive: true});
	await mkdir(join(home, '.pi', 'agent', 'extensions'), {recursive: true});
	await mkdir(join(context.cwd, '.claude'), {recursive: true});
	await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
		hooks: {PostToolUse: [{matcher: 'Write', hooks: [{type: 'command', command: 'format'}]}]},
	}), 'utf8');
	await writeFile(join(home, '.codex', 'hooks.json'), JSON.stringify({
		hooks: [{event: 'after_tool', command: 'lint'}],
	}), 'utf8');
	await writeFile(join(context.cwd, '.claude', 'settings.local.json'), '{bad json', 'utf8');
	await writeFile(join(home, '.pi', 'agent', 'extensions', 'guard.ts'), 'export default function guard() {}\n', 'utf8');
	await mkdir(join(home, '.pi', 'agent', 'extensions', 'bundle'), {recursive: true});
	await writeFile(join(home, '.pi', 'agent', 'extensions', 'bundle', 'index.ts'), 'export default function bundle() {}\n', 'utf8');

	const result = await scanHooks(context, runtimeWith({
		'codex plugin list --json': '{"installed":[]}',
	}));

	assert.deepEqual(result.hooks.map(hook => [hook.provider, hook.scope, hook.event, hook.type]), [
		['claude', 'user', 'PostToolUse', 'command'],
		['codex', 'user', 'after_tool', 'command'],
		['pi', 'user', 'Extension', 'extension'],
		['pi', 'user', 'Extension', 'extension'],
	]);
	assert.equal(result.hooks.every(hook => /^[a-f0-9]{16}$/u.test(hook.id)), true);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0]?.message ?? '', /invalid JSON/iu);
});

test('scanHooks includes hooks from enabled Codex plugins', async () => {
	const home = await createTestHome();
	const context = contextFor(home);
	const pluginRoot = join(home, '.codex', 'plugins', 'cache', 'acme', 'guard', '1.2.3');
	await mkdir(join(pluginRoot, '.codex-plugin'), {recursive: true});
	await mkdir(join(pluginRoot, 'hooks'), {recursive: true});
	await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
		name: 'guard',
		version: '1.2.3',
		hooks: './hooks/hooks.json',
	}), 'utf8');
	await writeFile(join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
		hooks: {
			SessionStart: [{hooks: [{type: 'command'}]}],
			UserPromptSubmit: [{hooks: [{type: 'command'}]}],
		},
	}), 'utf8');
	const runtime = runtimeWith({
		'codex plugin list --json': JSON.stringify({installed: [{
			pluginId: 'guard@acme',
			name: 'guard',
			marketplaceName: 'acme',
			version: '1.2.3',
			enabled: true,
		}]}),
	});

	const result = await scanHooks(context, runtime);

	assert.deepEqual(result.hooks.map(hook => [hook.provider, hook.scope, hook.event, hook.type]), [
		['codex', 'user', 'SessionStart', 'command'],
		['codex', 'user', 'UserPromptSubmit', 'command'],
	]);
});

test('editHook opens the exact source file selected from a fresh inventory', async () => {
	const home = await createTestHome();
	await mkdir(join(home, '.claude'), {recursive: true});
	const sourcePath = join(home, '.claude', 'settings.json');
	await writeFile(sourcePath, JSON.stringify({hooks: {Stop: [{hooks: [{type: 'command'}]}]}}), 'utf8');
	const calls: Array<Call> = [];
	const runtime = runtimeWith({
		'claude plugin list --json': '[]',
		'codex plugin list --json': '{"installed":[]}',
		'pi list': '',
	}, calls);
	const inventory = await scanHooks(contextFor(home), runtime);
	const hook = inventory.hooks[0];
	assert.ok(hook);

	await editHook(contextFor(home), runtime, hook.id);
	assert.deepEqual(calls.filter(call => call.program === 'editor'), [{program: 'editor', arguments_: [sourcePath]}]);
});

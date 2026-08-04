import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {
	editHook,
	scanHooks,
	scanPlugins,
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
			capability: 'native-interactive',
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

test('setPluginEnabled mutates only Claude and confirms the resulting inventory', async () => {
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

	const unsupportedCalls: Array<Call> = [];
	await assert.rejects(
		setPluginEnabled(contextFor('/tmp/amc-home'), runtimeWith({
			'claude plugin list --json': '[]',
			'codex plugin list --json': '{"installed":[{"id":"docs","enabled":false}]}',
			'pi list': '',
		}, unsupportedCalls), 'codex:docs', true),
		/INTERACTIVE_REQUIRED: Codex does not expose a headless plugin toggle\. Run `codex`, enter `\/plugins`, select `docs`, then press Space\./u,
	);
	assert.equal(unsupportedCalls.some(call => call.arguments_.includes('enable')), false);
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

	const result = await scanHooks(context);

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
	const inventory = await scanHooks(contextFor(home));
	const hook = inventory.hooks[0];
	assert.ok(hook);

	await editHook(contextFor(home), runtime, hook.id);
	assert.deepEqual(calls, [{program: 'editor', arguments_: [sourcePath]}]);
});

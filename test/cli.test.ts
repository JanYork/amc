import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCommand, UsageError} from '../src/cli/index.js';

test('parseCommand selects the TUI when no arguments are present', () => {
	assert.deepEqual(parseCommand([]), {kind: 'tui'});
});

test('parseCommand recognizes help, version, and list', () => {
	assert.deepEqual(parseCommand(['--help']), {kind: 'help'});
	assert.deepEqual(parseCommand(['-v']), {kind: 'version'});
	assert.deepEqual(parseCommand(['list']), {
		kind: 'list',
		page: 1,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: false,
	});
});

test('parseCommand accepts bounded list paging, search, all, and diagnostics', () => {
	assert.deepEqual(parseCommand(['list', '--page', '3', '--limit=7', '--search', 'Code']), {
		kind: 'list',
		page: 3,
		limit: 7,
		all: false,
		search: 'Code',
		diagnostics: false,
	});
	assert.deepEqual(parseCommand(['list', '--all', '--search=gstack']), {
		kind: 'list',
		page: 1,
		limit: 20,
		all: true,
		search: 'gstack',
		diagnostics: false,
	});
	assert.deepEqual(parseCommand(['list', '--diagnostics', '--page=2']), {
		kind: 'list',
		page: 2,
		limit: 20,
		all: false,
		search: undefined,
		diagnostics: true,
	});
});

test('parseCommand defaults enable and disable to all targets', () => {
	assert.deepEqual(parseCommand(['enable', 'code-review']), {
		kind: 'enable',
		name: 'code-review',
		target: undefined,
	});
	assert.deepEqual(parseCommand(['disable', 'code-review']), {
		kind: 'disable',
		name: 'code-review',
		target: undefined,
	});
});

test('parseCommand accepts one explicit enable or disable target', () => {
	assert.deepEqual(parseCommand(['enable', 'code-review', '--target', 'codex']), {
		kind: 'enable',
		name: 'code-review',
		target: 'codex',
	});
	assert.deepEqual(parseCommand(['disable', 'code-review', '--target=pi']), {
		kind: 'disable',
		name: 'code-review',
		target: 'pi',
	});
});

test('parseCommand accepts migration with an optional valid source', () => {
	assert.deepEqual(parseCommand(['migrate', 'code-review']), {
		kind: 'migrate',
		name: 'code-review',
		source: undefined,
	});
	assert.deepEqual(parseCommand(['migrate', 'code-review', '--source', 'claude']), {
		kind: 'migrate',
		name: 'code-review',
		source: 'claude',
	});
});

test('parseCommand accepts bulk migration inspection and apply modes', () => {
	assert.deepEqual(parseCommand(['migrate', '--all']), {
		kind: 'migrate-all',
		apply: false,
	});
	assert.deepEqual(parseCommand(['migrate', '--all', '--yes']), {
		kind: 'migrate-all',
		apply: true,
	});
});

test('parseCommand accepts read-only and explicitly authorized reconciliation', () => {
	assert.deepEqual(parseCommand(['reconcile']), {kind: 'reconcile', apply: false, name: undefined, source: undefined});
	assert.deepEqual(parseCommand(['reconcile', '--apply', '--yes']), {kind: 'reconcile', apply: true, name: undefined, source: undefined});
	assert.deepEqual(parseCommand(['reconcile', 'alpha', '--source', 'agents', '--apply', '--yes']), {
		kind: 'reconcile', apply: true, name: 'alpha', source: 'agents',
	});
	assert.deepEqual(parseCommand(['reconcile', 'alpha', '--source', 'canonical', '--apply', '--yes']), {
		kind: 'reconcile', apply: true, name: 'alpha', source: 'canonical',
	});
	assert.deepEqual(parseCommand(['disable', 'prototype']), {kind: 'disable', name: 'prototype', target: undefined});
});

test('parseCommand accepts one-Skill and all-applied update checks', () => {
	assert.deepEqual(parseCommand(['updates', 'check']), {kind: 'updates-check', name: undefined});
	assert.deepEqual(parseCommand(['updates', 'check', 'alpha']), {kind: 'updates-check', name: 'alpha'});
});

test('parseCommand accepts GitHub OAuth, token-stdin, and status commands', () => {
	assert.deepEqual(parseCommand(['auth', 'github', 'login']), {kind: 'github-auth-login'});
	assert.deepEqual(parseCommand(['auth', 'github', 'set', '--token-stdin']), {kind: 'github-auth-token'});
	assert.deepEqual(parseCommand(['auth', 'github', 'status']), {kind: 'github-auth-status'});
});

test('parseCommand accepts marketplace, repository, install, upgrade, and permanent delete commands', () => {
	assert.deepEqual(parseCommand(['search', 'testing']), {kind: 'marketplace-search', query: 'testing', source: undefined});
	assert.deepEqual(parseCommand(['search', 'testing', '--source', 'github']), {kind: 'marketplace-search', query: 'testing', source: 'github'});
	assert.deepEqual(parseCommand(['repos', 'list']), {kind: 'repos-list'});
	assert.deepEqual(parseCommand(['repos', 'add', 'example/skills', '--branch', 'main']), {kind: 'repos-add', source: 'example/skills', branch: 'main'});
	assert.deepEqual(parseCommand(['repos', 'refresh', 'example/skills']), {kind: 'repos-refresh', source: 'example/skills'});
	assert.deepEqual(parseCommand(['repos', 'remove', 'example/skills']), {kind: 'repos-remove', source: 'example/skills'});
	assert.deepEqual(parseCommand(['repos', 'disable', 'example/skills']), {kind: 'repos-disable', source: 'example/skills'});
	assert.deepEqual(parseCommand(['repos', 'enable', 'example/skills']), {kind: 'repos-enable', source: 'example/skills'});
	assert.deepEqual(parseCommand(['install', 'example/skills', '--skill', 'alpha']), {kind: 'install', source: 'example/skills', skill: 'alpha', branch: undefined});
	assert.deepEqual(parseCommand(['upgrade', 'alpha']), {kind: 'upgrade', name: 'alpha'});
	assert.deepEqual(parseCommand(['delete', 'alpha', '--yes', '--confirm', 'alpha']), {kind: 'delete', name: 'alpha', confirmation: 'alpha'});
});

test('parseCommand accepts plugin and hook management commands', () => {
	assert.deepEqual(parseCommand(['plugins', 'list', '--page=2', '--limit=10', '--search', 'review']), {
		kind: 'plugins-list', page: 2, limit: 10, all: false, search: 'review',
	});
	assert.deepEqual(parseCommand(['plugins', 'enable', 'claude:review@official']), {
		kind: 'plugin-enable', id: 'claude:review@official',
	});
	assert.deepEqual(parseCommand(['plugins', 'disable', 'claude:review@official']), {
		kind: 'plugin-disable', id: 'claude:review@official',
	});
	assert.deepEqual(parseCommand(['hooks', 'list', '--all']), {
		kind: 'hooks-list', page: 1, limit: 20, all: true, search: undefined,
	});
	assert.deepEqual(parseCommand(['hooks', 'edit', '0123456789abcdef']), {
		kind: 'hook-edit', id: '0123456789abcdef',
	});
	assert.deepEqual(parseCommand(['hooks', 'enable', '0123456789abcdef']), {
		kind: 'hook-enable', id: '0123456789abcdef',
	});
	assert.deepEqual(parseCommand(['hooks', 'disable', '0123456789abcdef']), {
		kind: 'hook-disable', id: '0123456789abcdef',
	});
	assert.deepEqual(parseCommand(['mcp', 'list', '--search', 'graph']), {
		kind: 'mcp-list', page: 1, limit: 20, all: false, search: 'graph',
	});
	assert.deepEqual(parseCommand(['mcp', 'enable', 'codex:node_repl:user']), {
		kind: 'mcp-enable', id: 'codex:node_repl:user',
	});
	assert.deepEqual(parseCommand(['mcp', 'disable', 'claude:codegraph:user']), {
		kind: 'mcp-disable', id: 'claude:codegraph:user',
	});
});

test('parseCommand rejects every invalid usage before execution', async context => {
	const invalidCases: ReadonlyArray<ReadonlyArray<string>> = [
		['unknown'],
		['list', 'extra'],
		['list', '--page', '0'],
		['list', '--page', '1.5'],
		['list', '--limit', '0'],
		['list', '--limit', '101'],
		['list', '--all', '--page', '1'],
		['list', '--all', '--limit', '20'],
		['list', '--search', ''],
		['enable'],
		['enable', '../escape'],
		['enable', 'bad\nname'],
		['enable', '__proto__'],
		['enable', 'constructor'],
		['enable', 'code-review', '--page', '2'],
		['enable', 'code-review', '--yes'],
		['enable', 'code-review', '--target', 'other'],
		['enable', 'code-review', '--source', 'claude'],
		['disable', 'code-review', '--target', 'claude', 'extra'],
		['migrate', '--yes'],
		['migrate', 'code-review', '--all'],
		['migrate', 'code-review', '--source', 'other'],
		['migrate', '--all', '--source', 'claude'],
		['migrate', 'code-review', '--target', 'codex'],
		['reconcile', '--apply'],
		['reconcile', '--yes'],
		['reconcile', 'alpha', '--apply', '--yes'],
		['reconcile', 'alpha', '--source', 'other', '--apply', '--yes'],
		['reconcile', '--source', 'agents', '--apply', '--yes'],
		['list', '--yes'],
		['--help', 'list'],
		['--target', 'codex'],
		['--not-an-option'],
		['plugins'],
		['plugins', 'enable'],
		['plugins', 'enable', '../bad'],
		['plugins', 'list', '--target', 'claude'],
		['hooks'],
		['hooks', 'edit', 'not-a-hook-id'],
		['hooks', 'list', '--diagnostics'],
		['mcp'],
		['mcp', 'enable'],
		['mcp', 'enable', '../bad'],
		['mcp', 'list', '--target', 'codex'],
		['updates'],
		['updates', 'check', 'alpha', 'extra'],
		['updates', 'check', '--all'],
		['auth'],
		['auth', 'github'],
		['auth', 'gitlab', 'status'],
		['auth', 'github', 'login', '--token-stdin'],
		['auth', 'github', 'set'],
		['auth', 'github', 'status', '--token-stdin'],
		['search'],
		['search', 'testing', '--source', 'other'],
		['repos'],
		['repos', 'add', 'example/skills', '--skill', 'alpha'],
		['install', 'example/skills'],
		['install', 'example/skills', '--skill', '../bad'],
		['upgrade'],
		['upgrade', 'alpha', '--yes'],
		['delete', 'alpha'],
		['delete', 'alpha', '--yes'],
		['delete', 'alpha', '--confirm', 'alpha'],
		['delete', 'alpha', '--yes', '--confirm', 'beta'],
	];

	for (const arguments_ of invalidCases) {
		await context.test(arguments_.join(' '), () => {
			assert.throws(() => parseCommand(arguments_), UsageError);
		});
	}
});

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
		['list', '--yes'],
		['--help', 'list'],
		['--target', 'codex'],
		['--not-an-option'],
	];

	for (const arguments_ of invalidCases) {
		await context.test(arguments_.join(' '), () => {
			assert.throws(() => parseCommand(arguments_), UsageError);
		});
	}
});

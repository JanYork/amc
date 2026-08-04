import assert from 'node:assert/strict';
import test from 'node:test';
import {parseCommand, UsageError} from '../src/cli/index.js';

test('parseCommand selects the TUI when no arguments are present', () => {
	assert.deepEqual(parseCommand([]), {kind: 'tui'});
});

test('parseCommand recognizes help, version, and list', () => {
	assert.deepEqual(parseCommand(['--help']), {kind: 'help'});
	assert.deepEqual(parseCommand(['-v']), {kind: 'version'});
	assert.deepEqual(parseCommand(['list']), {kind: 'list'});
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

test('parseCommand rejects every invalid usage before execution', async context => {
	const invalidCases: ReadonlyArray<ReadonlyArray<string>> = [
		['unknown'],
		['list', 'extra'],
		['enable'],
		['enable', '../escape'],
		['enable', 'code-review', '--target', 'other'],
		['enable', 'code-review', '--source', 'claude'],
		['disable', 'code-review', '--target', 'claude', 'extra'],
		['migrate', 'code-review', '--source', 'other'],
		['migrate', 'code-review', '--target', 'codex'],
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

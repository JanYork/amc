import assert from 'node:assert/strict';
import test from 'node:test';
import type {Skill} from '../src/core/index.js';
import {
	filterSkills,
	layoutForTerminal,
	moveSelection,
	moveScope,
	visibleWindow,
} from '../src/tui/view.js';

function skill(name: string): Skill {
	return {
		name,
		canonical: true,
		states: {claude: 'enabled', pi: 'disabled', codex: 'unmanaged'},
	};
}

test('terminal layout bounds rows and switches compact/minimum modes', () => {
	assert.deepEqual(layoutForTerminal(43, 24), {kind: 'too-small', minimumColumns: 44, minimumRows: 10});
	assert.deepEqual(layoutForTerminal(80, 9), {kind: 'too-small', minimumColumns: 44, minimumRows: 10});

	const compact = layoutForTerminal(44, 10);
	assert.equal(compact.kind, 'ready');
	if (compact.kind === 'ready') {
		assert.equal(compact.compact, true);
		assert.equal(compact.visibleRows, 1);
		assert.equal(compact.skillWidth, 16);
		assert.equal(compact.showLegend, false);
		assert.equal(compact.showDetails, false);
	}

	const normal = layoutForTerminal(80, 24);
	assert.equal(normal.kind, 'ready');
	if (normal.kind === 'ready') {
		assert.equal(normal.compact, false);
		assert.equal(normal.visibleRows, 12);
		assert.equal(normal.skillWidth, 37);
		assert.equal(normal.showLegend, true);
		assert.equal(normal.showDetails, true);
	}

	const short = layoutForTerminal(80, 12);
	assert.equal(short.kind, 'ready');
	if (short.kind === 'ready') {
		assert.equal(short.visibleRows, 2);
		assert.equal(short.showDetails, false);
	}

	const tall = layoutForTerminal(120, 80);
	assert.equal(tall.kind, 'ready');
	if (tall.kind === 'ready') {
		assert.equal(tall.visibleRows, 20);
	}
});

test('literal search is case-insensitive and preserves sorted input order', () => {
	const skills = [skill('Code-Review'), skill('gstack-review'), skill('review')];
	assert.deepEqual(filterSkills(skills, 'REVIEW').map(item => item.name), [
		'Code-Review',
		'gstack-review',
		'review',
	]);
	assert.deepEqual(filterSkills(skills, 'stack').map(item => item.name), ['gstack-review']);
	assert.deepEqual(filterSkills(skills, '').map(item => item.name), skills.map(item => item.name));
	assert.deepEqual(filterSkills(skills, 'missing'), []);
});

test('visible window never exceeds its row budget and keeps selection visible', () => {
	const skills = Array.from({length: 227}, (_, index) => skill(`skill-${String(index).padStart(3, '0')}`));
	const window = visibleWindow(skills, 'skill-030', 17);
	assert.equal(window.rows.length, 17);
	assert.equal(window.start, 22);
	assert.equal(window.end, 39);
	assert.equal(window.selectedIndex, 30);
	assert.equal(window.rows.some(item => item.name === 'skill-030'), true);

	const last = visibleWindow(skills, 'skill-226', 17);
	assert.equal(last.start, 210);
	assert.equal(last.end, 227);
	assert.equal(last.rows.at(-1)?.name, 'skill-226');

	assert.deepEqual(visibleWindow([], undefined, 17), {
		rows: [],
		start: 0,
		end: 0,
		selectedIndex: undefined,
	});
});

test('selection supports line, page, and endpoint navigation with clamping', () => {
	const skills = Array.from({length: 50}, (_, index) => skill(`skill-${String(index).padStart(2, '0')}`));
	assert.equal(moveSelection(skills, undefined, 'next', 17), 'skill-00');
	assert.equal(moveSelection(skills, 'skill-01', 'previous', 17), 'skill-00');
	assert.equal(moveSelection(skills, 'skill-01', 'page-down', 17), 'skill-18');
	assert.equal(moveSelection(skills, 'skill-18', 'page-up', 17), 'skill-01');
	assert.equal(moveSelection(skills, 'skill-20', 'first', 17), 'skill-00');
	assert.equal(moveSelection(skills, 'skill-20', 'last', 17), 'skill-49');
	assert.equal(moveSelection(skills, 'skill-49', 'next', 17), 'skill-49');
	assert.equal(moveSelection([], undefined, 'next', 17), undefined);
});

test('scope navigation follows All, Claude, Pi, Codex and clamps', () => {
	assert.equal(moveScope('all', 'left'), 'all');
	assert.equal(moveScope('all', 'right'), 'claude');
	assert.equal(moveScope('claude', 'right'), 'pi');
	assert.equal(moveScope('pi', 'right'), 'codex');
	assert.equal(moveScope('codex', 'right'), 'codex');
	assert.equal(moveScope('codex', 'left'), 'pi');
});

import type {Skill, Target} from '../core/index.js';

export type ActionScope = 'all' | Target;

export type SelectionMovement =
	| 'previous'
	| 'next'
	| 'page-up'
	| 'page-down'
	| 'first'
	| 'last';

export type TerminalLayout =
	| Readonly<{kind: 'too-small'; minimumColumns: 44; minimumRows: 10}>
	| Readonly<{
		kind: 'ready';
		compact: boolean;
		showLegend: boolean;
		showDetails: boolean;
		visibleRows: number;
		skillWidth: number;
		targetWidth: number;
	}>;

export type VisibleWindow = Readonly<{
	rows: ReadonlyArray<Skill>;
	start: number;
	end: number;
	selectedIndex: number | undefined;
}>;

const minimumColumns = 44;
const minimumRows = 10;
const maximumVisibleRows = 20;

export function layoutForTerminal(columns: number, rows: number): TerminalLayout {
	if (columns < minimumColumns || rows < minimumRows) {
		return {kind: 'too-small', minimumColumns, minimumRows};
	}

	const compact = columns < 68;
	const showLegend = rows > minimumRows;
	const showDetails = rows >= 14;
	const targetWidth = compact ? 5 : 10;
	return {
		kind: 'ready',
		compact,
		showLegend,
		showDetails,
		visibleRows: Math.min(maximumVisibleRows, Math.max(1, rows - (showLegend ? 10 : 9) - (showDetails ? 2 : 0))),
		skillWidth: Math.max(1, columns - 13 - (targetWidth * 3)),
		targetWidth,
	};
}

export function filterSkills(skills: ReadonlyArray<Skill>, query: string): ReadonlyArray<Skill> {
	if (query.length === 0) {
		return skills;
	}

	const normalized = query.toLowerCase();
	return skills.filter(skill => skill.name.toLowerCase().includes(normalized));
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

export function visibleWindow(
	skills: ReadonlyArray<Skill>,
	selectedName: string | undefined,
	rowCount: number,
): VisibleWindow {
	if (skills.length === 0) {
		return {rows: [], start: 0, end: 0, selectedIndex: undefined};
	}

	const foundIndex = selectedName === undefined
		? -1
		: skills.findIndex(skill => skill.name === selectedName);
	const selectedIndex = foundIndex < 0 ? 0 : foundIndex;
	const boundedRows = Math.max(1, rowCount);
	const maximumStart = Math.max(0, skills.length - boundedRows);
	const start = clamp(selectedIndex - Math.floor(boundedRows / 2), 0, maximumStart);
	const end = Math.min(skills.length, start + boundedRows);

	return {
		rows: skills.slice(start, end),
		start,
		end,
		selectedIndex,
	};
}

export function moveSelection(
	skills: ReadonlyArray<Skill>,
	selectedName: string | undefined,
	movement: SelectionMovement,
	pageSize: number,
): string | undefined {
	if (skills.length === 0) {
		return undefined;
	}

	const foundIndex = selectedName === undefined
		? -1
		: skills.findIndex(skill => skill.name === selectedName);
	if (foundIndex < 0) {
		return movement === 'last' ? skills.at(-1)?.name : skills[0]?.name;
	}

	const distance = Math.max(1, pageSize);
	let nextIndex: number;
	switch (movement) {
		case 'previous':
			nextIndex = foundIndex - 1;
			break;
		case 'next':
			nextIndex = foundIndex + 1;
			break;
		case 'page-up':
			nextIndex = foundIndex - distance;
			break;
		case 'page-down':
			nextIndex = foundIndex + distance;
			break;
		case 'first':
			nextIndex = 0;
			break;
		case 'last':
			nextIndex = skills.length - 1;
			break;
	}

	return skills[clamp(nextIndex, 0, skills.length - 1)]?.name;
}

export function moveScope(scope: ActionScope, direction: 'left' | 'right'): ActionScope {
	if (direction === 'left') {
		switch (scope) {
			case 'all':
				return 'all';
			case 'claude':
				return 'all';
			case 'pi':
				return 'claude';
			case 'codex':
				return 'pi';
		}
	}

	switch (scope) {
		case 'all':
			return 'claude';
		case 'claude':
			return 'pi';
		case 'pi':
			return 'codex';
		case 'codex':
			return 'codex';
	}
}

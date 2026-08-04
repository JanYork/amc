import {useCallback, useEffect, useMemo, useState} from 'react';
import {Box, render, Text, useApp, useInput, useWindowSize} from 'ink';
import {
	AmcError,
	executeMigration,
	listSkills,
	planMigration,
	setSkillEnabled,
	targets,
	type Layout,
	type MigrationPlan,
	type Skill,
	type Target,
	type TargetState,
} from '../core/index.js';
import {
	filterSkills,
	layoutForTerminal,
	moveScope,
	moveSelection,
	visibleWindow,
	type ActionScope,
	type SelectionMovement,
	type TerminalLayout,
} from './view.js';

export type AppProps = Readonly<{
	layout: Layout;
	windowSize?: Readonly<{columns: number; rows: number}>;
}>;

type Notice = Readonly<{
	kind: 'info' | 'success' | 'error';
	text: string;
}>;

type Modal =
	| Readonly<{kind: 'source'; plan: MigrationPlan}>
	| Readonly<{kind: 'confirm'; plan: MigrationPlan; source: Target | undefined}>;

function errorText(error: unknown): string {
	if (error instanceof AmcError) {
		return `${error.code}: ${error.message}`;
	}
	return error instanceof Error ? error.message : 'Unexpected AMC failure.';
}

function targetFromInput(input: string): Target | undefined {
	switch (input) {
		case '1':
			return 'claude';
		case '2':
			return 'pi';
		case '3':
			return 'codex';
		default:
			return undefined;
	}
}

function StateMark({state, focused}: Readonly<{state: TargetState; focused: boolean}>): React.JSX.Element {
	switch (state) {
		case 'enabled':
			return <Text color="green" inverse={focused}>●</Text>;
		case 'disabled':
			return <Text dimColor inverse={focused}>○</Text>;
		case 'unmanaged':
			return <Text color="yellow" inverse={focused}>◇</Text>;
		case 'conflict':
			return <Text color="red" inverse={focused}>!</Text>;
	}
}

function SkillRow({
	skill,
	selected,
	scope,
	terminalLayout,
}: Readonly<{
	skill: Skill;
	selected: boolean;
	scope: ActionScope;
	terminalLayout: Extract<TerminalLayout, {kind: 'ready'}>;
}>): React.JSX.Element {
	return (
		<Box>
			<Box width={terminalLayout.skillWidth + 2}>
				<Text inverse={selected && scope === 'all'} wrap="truncate-end">
					{selected ? '› ' : '  '}{skill.name}
				</Text>
			</Box>
			<Box width={terminalLayout.targetWidth}><StateMark state={skill.states.claude} focused={selected && scope === 'claude'}/></Box>
			<Box width={terminalLayout.targetWidth}><StateMark state={skill.states.pi} focused={selected && scope === 'pi'}/></Box>
			<Box width={terminalLayout.targetWidth}><StateMark state={skill.states.codex} focused={selected && scope === 'codex'}/></Box>
		</Box>
	);
}

function scopeLabel(scope: ActionScope): string {
	switch (scope) {
		case 'all':
			return 'All';
		case 'claude':
			return 'Claude';
		case 'pi':
			return 'Pi';
		case 'codex':
			return 'Codex';
	}
}

function noticeColor(kind: Notice['kind']): 'yellow' | 'green' | 'red' {
	switch (kind) {
		case 'info':
			return 'yellow';
		case 'success':
			return 'green';
		case 'error':
			return 'red';
	}
}

function currentStatus(
	modal: Modal | undefined,
	busy: boolean,
	notice: Notice | undefined,
	searching: boolean,
): Notice {
	if (modal?.kind === 'source') {
		return {kind: 'info', text: 'Choose source: 1 Claude  2 Pi  3 Codex  Esc cancel'};
	}
	if (modal?.kind === 'confirm') {
		return {
			kind: 'info',
			text: `Migrate ${modal.plan.name}?${modal.source === undefined ? '' : ` Source: ${modal.source}.`} y confirm / n cancel`,
		};
	}
	if (busy) {
		return {kind: 'info', text: 'Working…'};
	}
	if (searching) {
		return {kind: 'info', text: 'Type to filter · Enter accept · Esc clear'};
	}
	return notice ?? {kind: 'info', text: 'Ready.'};
}

function HelpPanel(): React.JSX.Element {
	return (
		<Box flexDirection="column">
			<Text bold>Keyboard</Text>
			<Text wrap="truncate-end">↑/↓ or j/k move · Page Up/Down page · Home/End jump</Text>
			<Text wrap="truncate-end">←/→ choose scope · Space toggle · 1/2/3 direct target</Text>
			<Text wrap="truncate-end">/ search · m migrate · r refresh · Esc cancel/clear</Text>
			<Text wrap="truncate-end">? close help · q quit</Text>
		</Box>
	);
}

export function App({layout, windowSize}: AppProps): React.JSX.Element {
	const {exit} = useApp();
	const detectedWindowSize = useWindowSize();
	const dimensions = windowSize ?? detectedWindowSize;
	const terminalLayout = layoutForTerminal(dimensions.columns, dimensions.rows);
	const [skills, setSkills] = useState<ReadonlyArray<Skill> | undefined>();
	const [diagnosticCount, setDiagnosticCount] = useState(0);
	const [selectedName, setSelectedName] = useState<string | undefined>();
	const [query, setQuery] = useState('');
	const [searching, setSearching] = useState(false);
	const [scope, setScope] = useState<ActionScope>('all');
	const [helpOpen, setHelpOpen] = useState(false);
	const [notice, setNotice] = useState<Notice | undefined>();
	const [modal, setModal] = useState<Modal | undefined>();
	const [busy, setBusy] = useState(false);
	const filteredSkills = useMemo(
		() => skills === undefined ? undefined : filterSkills(skills, query),
		[query, skills],
	);
	const currentWindow = terminalLayout.kind === 'ready' && filteredSkills !== undefined
		? visibleWindow(filteredSkills, selectedName, terminalLayout.visibleRows)
		: undefined;
	const selectedSkill = filteredSkills?.find(skill => skill.name === selectedName)
		?? filteredSkills?.[0];

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const result = await listSkills(layout);
			setSkills(result.skills);
			setDiagnosticCount(result.diagnostics.length);
			setSelectedName(current => result.skills.some(skill => skill.name === current)
				? current
				: result.skills[0]?.name);
		} catch (error: unknown) {
			setSkills([]);
			setNotice({kind: 'error', text: errorText(error)});
		}
	}, [layout]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (filteredSkills === undefined) {
			return;
		}
		setSelectedName(current => filteredSkills.some(skill => skill.name === current)
			? current
			: filteredSkills[0]?.name);
	}, [filteredSkills]);

	const toggle = useCallback(async (
		skill: Skill,
		enabled: boolean,
		target?: Target,
	): Promise<void> => {
		setBusy(true);
		try {
			const result = target === undefined
				? await setSkillEnabled(layout, skill.name, enabled)
				: await setSkillEnabled(layout, skill.name, enabled, [target]);
			const changes = result.changes
				.map(change => `${change.target}=${change.changed ? 'changed' : 'no-op'}`)
				.join(' ');
			await refresh();
			setBusy(false);
			setNotice({kind: 'success', text: `${enabled ? 'Enabled' : 'Disabled'} ${skill.name}: ${changes}`});
		} catch (error: unknown) {
			setBusy(false);
			setNotice({kind: 'error', text: errorText(error)});
		}
	}, [layout, refresh]);

	const beginMigration = useCallback(async (skill: Skill): Promise<void> => {
		setBusy(true);
		try {
			const plan = await planMigration(layout, skill.name);
			const blocker = plan.blockers[0];
			if (blocker !== undefined) {
				setBusy(false);
				setNotice({kind: 'error', text: `${blocker.code}: ${blocker.message}`});
				return;
			}
			setBusy(false);
			setModal(plan.sourceRequired
				? {kind: 'source', plan}
				: {kind: 'confirm', plan, source: undefined});
		} catch (error: unknown) {
			setBusy(false);
			setNotice({kind: 'error', text: errorText(error)});
		}
	}, [layout]);

	const migrate = useCallback(async (
		plan: MigrationPlan,
		source: Target | undefined,
	): Promise<void> => {
		setModal(undefined);
		setBusy(true);
		try {
			const result = await executeMigration(layout, plan, source);
			await refresh();
			setBusy(false);
			setNotice({kind: 'success', text: `Migrated ${result.name} to ${result.canonicalPath}`});
		} catch (error: unknown) {
			setBusy(false);
			setNotice({kind: 'error', text: errorText(error)});
		}
	}, [layout, refresh]);

	const updateSearch = useCallback((nextQuery: string): void => {
		setQuery(nextQuery);
		const nextSkills = filterSkills(skills ?? [], nextQuery);
		setSelectedName(nextSkills[0]?.name);
	}, [skills]);

	const navigate = useCallback((movement: SelectionMovement): void => {
		if (filteredSkills === undefined || terminalLayout.kind !== 'ready') {
			return;
		}
		setSelectedName(current => moveSelection(
			filteredSkills,
			current,
			movement,
			terminalLayout.visibleRows,
		));
		setNotice(undefined);
	}, [filteredSkills, terminalLayout]);

	useInput((input, key) => {
		if (busy) {
			return;
		}
		if (modal?.kind === 'source') {
			if (input === 'n' || key.escape) {
				setModal(undefined);
				setNotice({kind: 'info', text: 'Migration cancelled.'});
				return;
			}
			const source = targetFromInput(input);
			if (source !== undefined && modal.plan.sources.some(candidate => candidate.target === source)) {
				setModal({kind: 'confirm', plan: modal.plan, source});
			}
			return;
		}
		if (modal?.kind === 'confirm') {
			if (input === 'y') {
				void migrate(modal.plan, modal.source);
			} else if (input === 'n' || key.escape) {
				setModal(undefined);
				setNotice({kind: 'info', text: 'Migration cancelled.'});
			}
			return;
		}
		if (helpOpen) {
			if (input === '?' || key.escape) {
				setHelpOpen(false);
				return;
			}
			if (input === 'q') {
				exit();
			}
			return;
		}
		if (searching) {
			if (key.escape) {
				setSearching(false);
				updateSearch('');
				return;
			}
			if (key.return) {
				setSearching(false);
				return;
			}
			if (key.backspace || key.delete) {
				updateSearch(Array.from(query).slice(0, -1).join(''));
				return;
			}
			if (key.ctrl && input === 'u') {
				updateSearch('');
				return;
			}
			if (input.length > 0 && !key.ctrl && !key.meta && !key.super && !key.hyper) {
				updateSearch(`${query}${input}`);
			}
			return;
		}
		if (input === 'q') {
			exit();
			return;
		}
		if (input === '?') {
			setHelpOpen(true);
			setNotice(undefined);
			return;
		}
		if (input === '/') {
			setSearching(true);
			setNotice(undefined);
			return;
		}
		if (key.escape && query.length > 0) {
			updateSearch('');
			return;
		}
		if (input === 'r') {
			setNotice({kind: 'info', text: 'Refreshed.'});
			void refresh();
			return;
		}
		if (terminalLayout.kind !== 'ready') {
			return;
		}
		if (key.downArrow || input === 'j') {
			navigate('next');
			return;
		}
		if (key.upArrow || input === 'k') {
			navigate('previous');
			return;
		}
		if (key.pageDown) {
			navigate('page-down');
			return;
		}
		if (key.pageUp) {
			navigate('page-up');
			return;
		}
		if (key.home) {
			navigate('first');
			return;
		}
		if (key.end) {
			navigate('last');
			return;
		}
		if (key.leftArrow) {
			setScope(current => moveScope(current, 'left'));
			setNotice(undefined);
			return;
		}
		if (key.rightArrow) {
			setScope(current => moveScope(current, 'right'));
			setNotice(undefined);
			return;
		}

		if (selectedSkill === undefined) {
			return;
		}
		if (input === ' ') {
			if (scope === 'all') {
				const allEnabled = targets.every(target => selectedSkill.states[target] === 'enabled');
				void toggle(selectedSkill, !allEnabled);
			} else {
				void toggle(selectedSkill, selectedSkill.states[scope] !== 'enabled', scope);
			}
			return;
		}
		const target = targetFromInput(input);
		if (target !== undefined) {
			void toggle(selectedSkill, selectedSkill.states[target] !== 'enabled', target);
			return;
		}
		if (input === 'm') {
			void beginMigration(selectedSkill);
		}
	});

	const status = currentStatus(modal, busy, notice, searching);
	const totalSkills = skills?.length ?? 0;
	const visibleStart = currentWindow === undefined || currentWindow.rows.length === 0
		? 0
		: currentWindow.start + 1;
	const visibleEnd = currentWindow?.end ?? 0;
	const filteredTotal = filteredSkills?.length ?? 0;
	const hasRowsAbove = currentWindow !== undefined && currentWindow.start > 0;
	const hasRowsBelow = currentWindow !== undefined && currentWindow.end < filteredTotal;

	if (terminalLayout.kind === 'too-small') {
		return (
			<Box flexDirection="column">
				<Text bold color="cyan">AMC — Agent Management CLI</Text>
				<Text color="yellow" wrap="truncate-end">
					Terminal too small: {dimensions.columns}×{dimensions.rows}. Resize to at least {terminalLayout.minimumColumns}×{terminalLayout.minimumRows}.
				</Text>
				<Text dimColor>q quit</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Box>
				<Text bold color="cyan" wrap="truncate-end">
					AMC — Agent Management CLI  ·  {totalSkills} Skills  ·  {diagnosticCount} warnings
				</Text>
			</Box>
			<Box>
				<Box flexGrow={1}>
					<Text wrap="truncate-end">Search: {query.length === 0 ? '—' : query}{searching ? '█' : ''}</Text>
				</Box>
				<Text>Scope: {scopeLabel(scope)}</Text>
			</Box>
			{helpOpen ? <HelpPanel/> : (
				<Box flexDirection="column">
					<Box>
						<Box width={terminalLayout.skillWidth + 2}>
							<Text bold inverse={scope === 'all'} wrap="truncate-end">  Skill</Text>
						</Box>
						<Box width={terminalLayout.targetWidth}><Text bold inverse={scope === 'claude'}>{terminalLayout.compact ? 'C' : 'Claude'}</Text></Box>
						<Box width={terminalLayout.targetWidth}><Text bold inverse={scope === 'pi'}>{terminalLayout.compact ? 'P' : 'Pi'}</Text></Box>
						<Box width={terminalLayout.targetWidth}><Text bold inverse={scope === 'codex'}>{terminalLayout.compact ? 'X' : 'Codex'}</Text></Box>
					</Box>
					{skills === undefined ? <Text>Loading Skills…</Text> : filteredSkills?.length === 0 ? (
						<Text>{query.length === 0 ? 'No Skills found.' : 'No Skills match the current search.'}</Text>
					) : currentWindow?.rows.map(skill => (
						<SkillRow
							key={skill.name}
							skill={skill}
							selected={skill.name === selectedSkill?.name}
							scope={scope}
							terminalLayout={terminalLayout}
						/>
					))}
					<Box>
						<Box flexGrow={1}><Text dimColor>{hasRowsAbove ? '↑ more' : ''}{hasRowsAbove && hasRowsBelow ? '  ' : ''}{hasRowsBelow ? '↓ more' : ''}</Text></Box>
						<Text dimColor>{visibleStart}–{visibleEnd} / {filteredTotal}</Text>
					</Box>
				</Box>
			)}
			<Box>
				<Text color={noticeColor(status.kind)} wrap="truncate-end">{status.text}</Text>
			</Box>
			<Box><Text dimColor wrap="truncate-end">● enabled  ○ disabled  ◇ unmanaged  ! conflict</Text></Box>
			<Box>
				<Text dimColor wrap="truncate-end">↑↓ move  ←→ scope  Space toggle  / search  ? help  q quit</Text>
			</Box>
		</Box>
	);
}

export async function runTui(layout: Layout): Promise<void> {
	const instance = render(<App layout={layout}/>, {alternateScreen: true});
	await instance.waitUntilExit();
}

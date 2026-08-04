import {useCallback, useEffect, useMemo, useState} from 'react';
import {Box, render, Text, useApp, useInput, useWindowSize, type TextProps} from 'ink';
import {
	AmcError,
	executeMigration,
	listSkills,
	planMigration,
	readSkillDetails,
	setSkillEnabled,
	targets,
	type Layout,
	type MigrationPlan,
	type Skill,
	type SkillDetails,
	type Target,
	type TargetState,
} from '../core/index.js';
import {
	themePalettes,
	type TerminalPresentation,
	type ThemePalette,
} from '../presentation/theme.js';
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
	presentation: TerminalPresentation;
	windowSize?: Readonly<{columns: number; rows: number}>;
}>;

type Notice = Readonly<{
	kind: 'info' | 'success' | 'error';
	text: string;
}>;

type Modal =
	| Readonly<{kind: 'source'; plan: MigrationPlan}>
	| Readonly<{kind: 'confirm'; plan: MigrationPlan; source: Target | undefined}>;

function ThemedText({color, ...props}: Readonly<Omit<TextProps, 'color'> & {
	color: string | undefined;
}>): React.JSX.Element {
	return color === undefined ? <Text {...props}/> : <Text {...props} color={color}/>;
}

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

function stateSymbol(state: TargetState): string {
	switch (state) {
		case 'enabled':
			return '●';
		case 'disabled':
			return '○';
		case 'unmanaged':
			return '◇';
		case 'conflict':
			return '!';
	}
}

function stateColor(state: TargetState, palette: ThemePalette): string | undefined {
	switch (state) {
		case 'enabled':
			return palette.enabled;
		case 'disabled':
			return palette.muted;
		case 'unmanaged':
			return palette.warning;
		case 'conflict':
			return palette.error;
	}
}

function StateMark({
	state,
	focused,
	presentation,
}: Readonly<{
	state: TargetState;
	focused: boolean;
	presentation: TerminalPresentation;
}>): React.JSX.Element {
	const palette = themePalettes[presentation.theme];
	const symbol = stateSymbol(state);
	if (!focused) {
		return <ThemedText color={stateColor(state, palette)}>{symbol}</ThemedText>;
	}
	return (
		<ThemedText bold underline color={stateColor(state, palette)}>
			{state === 'enabled' ? '◉' : symbol}
		</ThemedText>
	);
}

function TableBorder({
	terminalLayout,
	position,
	palette,
}: Readonly<{
	terminalLayout: Extract<TerminalLayout, {kind: 'ready'}>;
	position: 'top' | 'middle' | 'bottom';
	palette: ThemePalette;
}>): React.JSX.Element {
	const [left, separator, right] = position === 'top'
		? ['┌', '┬', '┐']
		: position === 'middle'
			? ['├', '┼', '┤']
			: ['└', '┴', '┘'];
	const widths = [
		terminalLayout.skillWidth,
		terminalLayout.targetWidth,
		terminalLayout.targetWidth,
		terminalLayout.targetWidth,
	];
	return (
		<ThemedText color={palette.border} dimColor={palette.border === undefined}>
			{left}{widths.map(width => '─'.repeat(width + 2)).join(separator)}{right}
		</ThemedText>
	);
}

function TableHeader({
	scope,
	terminalLayout,
	palette,
}: Readonly<{
	scope: ActionScope;
	terminalLayout: Extract<TerminalLayout, {kind: 'ready'}>;
	palette: ThemePalette;
}>): React.JSX.Element {
	return (
		<Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}>│ </ThemedText>
			<Box width={terminalLayout.skillWidth}>
				<ThemedText bold color={scope === 'all' ? palette.accent : undefined} underline={scope === 'all'} wrap="truncate-end">
					{'  Skill'.padEnd(terminalLayout.skillWidth)}
				</ThemedText>
			</Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │ </ThemedText>
			<Box justifyContent="center" width={terminalLayout.targetWidth}>
				<ThemedText bold color={scope === 'claude' ? palette.accent : undefined} underline={scope === 'claude'}>{terminalLayout.compact ? 'C' : 'Claude'}</ThemedText>
			</Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │ </ThemedText>
			<Box justifyContent="center" width={terminalLayout.targetWidth}>
				<ThemedText bold color={scope === 'pi' ? palette.accent : undefined} underline={scope === 'pi'}>{terminalLayout.compact ? 'P' : 'Pi'}</ThemedText>
			</Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │ </ThemedText>
			<Box justifyContent="center" width={terminalLayout.targetWidth}>
				<ThemedText bold color={scope === 'codex' ? palette.accent : undefined} underline={scope === 'codex'}>{terminalLayout.compact ? 'X' : 'Codex'}</ThemedText>
			</Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │</ThemedText>
		</Box>
	);
}

function TableMessageRow({
	message,
	terminalLayout,
	palette,
}: Readonly<{
	message: string;
	terminalLayout: Extract<TerminalLayout, {kind: 'ready'}>;
	palette: ThemePalette;
}>): React.JSX.Element {
	const width = terminalLayout.skillWidth + (terminalLayout.targetWidth * 3) + 9;
	return (
		<Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}>│ </ThemedText>
			<Box width={width}><Text dimColor wrap="truncate-end">{message.padEnd(width)}</Text></Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │</ThemedText>
		</Box>
	);
}

function SkillRow({
	skill,
	selected,
	scope,
	terminalLayout,
	presentation,
}: Readonly<{
	skill: Skill;
	selected: boolean;
	scope: ActionScope;
	terminalLayout: Extract<TerminalLayout, {kind: 'ready'}>;
	presentation: TerminalPresentation;
}>): React.JSX.Element {
	const palette = themePalettes[presentation.theme];
	return (
		<Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}>│ </ThemedText>
			<Box width={terminalLayout.skillWidth}>
				<ThemedText bold={selected} color={selected ? palette.accent : undefined} wrap="truncate-end">
					{`${selected ? '› ' : '  '}${skill.name}`.padEnd(terminalLayout.skillWidth)}
				</ThemedText>
			</Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │ </ThemedText>
			<Box justifyContent="center" width={terminalLayout.targetWidth}><StateMark state={skill.states.claude} focused={selected && scope === 'claude'} presentation={presentation}/></Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │ </ThemedText>
			<Box justifyContent="center" width={terminalLayout.targetWidth}><StateMark state={skill.states.pi} focused={selected && scope === 'pi'} presentation={presentation}/></Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │ </ThemedText>
			<Box justifyContent="center" width={terminalLayout.targetWidth}><StateMark state={skill.states.codex} focused={selected && scope === 'codex'} presentation={presentation}/></Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │</ThemedText>
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

function noticeColor(kind: Notice['kind'], palette: ThemePalette): string | undefined {
	switch (kind) {
		case 'info':
			return palette.warning;
		case 'success':
			return palette.enabled;
		case 'error':
			return palette.error;
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

export function App({layout, presentation, windowSize}: AppProps): React.JSX.Element {
	const {exit} = useApp();
	const detectedWindowSize = useWindowSize();
	const dimensions = windowSize ?? detectedWindowSize;
	const palette = themePalettes[presentation.theme];
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
	const [details, setDetails] = useState<SkillDetails | null>();
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

	useEffect(() => {
		if (selectedSkill === undefined) {
			setDetails(null);
			return;
		}
		let active = true;
		setDetails(undefined);
		void readSkillDetails(layout, selectedSkill.name, scope === 'all' ? undefined : scope)
			.then(result => {
				if (active) {
					setDetails(result);
				}
			})
			.catch(() => {
				if (active) {
					setDetails(null);
				}
			});
		return () => {
			active = false;
		};
	}, [layout, scope, selectedSkill]);

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
				<ThemedText bold color={palette.accent}>AMC — Agent Management CLI</ThemedText>
				<ThemedText color={palette.warning} wrap="truncate-end">
					Terminal too small: {dimensions.columns}×{dimensions.rows}. Resize to at least {terminalLayout.minimumColumns}×{terminalLayout.minimumRows}.
				</ThemedText>
				<Text dimColor>q quit</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Box>
				<ThemedText bold color={palette.accent}>AMC</ThemedText>
				<Text bold>  {totalSkills} Skills</Text>
				<ThemedText color={palette.muted}>  ·  {diagnosticCount} warnings</ThemedText>
			</Box>
			<Box>
				<Box flexGrow={1}>
					<Text wrap="truncate-end">Search: </Text>
					<ThemedText bold={searching} color={query.length === 0 ? undefined : palette.warning} wrap="truncate-end">
						{query.length === 0 ? '—' : query}{searching ? '█' : ''}
					</ThemedText>
				</Box>
				<ThemedText color={palette.muted}>Scope: </ThemedText><ThemedText bold underline color={palette.accent}>{scopeLabel(scope)}</ThemedText>
			</Box>
			{helpOpen ? <HelpPanel/> : (
				<Box flexDirection="column">
					<TableBorder position="top" terminalLayout={terminalLayout} palette={palette}/>
					<TableHeader scope={scope} terminalLayout={terminalLayout} palette={palette}/>
					<TableBorder position="middle" terminalLayout={terminalLayout} palette={palette}/>
					{skills === undefined ? <TableMessageRow message="Loading Skills…" terminalLayout={terminalLayout} palette={palette}/> : filteredSkills?.length === 0 ? (
						<TableMessageRow
							message={query.length === 0 ? 'No Skills found.' : 'No Skills match the current search.'}
							terminalLayout={terminalLayout}
							palette={palette}
						/>
					) : currentWindow?.rows.map(skill => (
						<SkillRow
							key={skill.name}
							skill={skill}
							selected={skill.name === selectedSkill?.name}
							scope={scope}
							terminalLayout={terminalLayout}
							presentation={presentation}
						/>
					))}
					<TableBorder position="bottom" terminalLayout={terminalLayout} palette={palette}/>
					{terminalLayout.showDetails && selectedSkill !== undefined && (
						<Box flexDirection="column" width={dimensions.columns}>
							<ThemedText bold color={palette.accent}>Description</ThemedText>
							<Box height={2} overflowY="hidden" width={dimensions.columns}>
								<Text wrap="wrap">{details === null ? 'Unavailable.' : details?.name === selectedSkill.name ? details.description : 'Loading…'}</Text>
							</Box>
							<Box width={dimensions.columns}>
								<ThemedText color={palette.muted}>Source: </ThemedText>
								<Box flexGrow={1}><ThemedText color={palette.muted} wrap="truncate-end">{details === null ? 'Unavailable.' : details?.name === selectedSkill.name ? details.sourcePath : 'Loading…'}</ThemedText></Box>
							</Box>
						</Box>
					)}
					<Box>
						<Box flexGrow={1}><ThemedText color={palette.muted}>{visibleStart}–{visibleEnd} / {filteredTotal}{hasRowsAbove ? '  ↑ more' : ''}{hasRowsBelow ? '  ↓ more' : ''}</ThemedText></Box>
						<ThemedText color={palette.muted}>↑↓ move  ←→ scope  / search  ? help</ThemedText>
					</Box>
				</Box>
			)}
			<Box>
				<ThemedText color={noticeColor(status.kind, palette)} wrap="truncate-end">{status.text}</ThemedText>
			</Box>
			{terminalLayout.showLegend && (
				<Box>
					<ThemedText color={palette.enabled}>● enabled</ThemedText><ThemedText color={palette.muted}>  ○ disabled  </ThemedText><ThemedText color={palette.warning}>◇ unmanaged</ThemedText><ThemedText color={palette.error}>  ! conflict</ThemedText>
				</Box>
			)}
		</Box>
	);
}

export async function runTui(layout: Layout, presentation: TerminalPresentation): Promise<void> {
	const instance = render(<App layout={layout} presentation={presentation}/>, {alternateScreen: true});
	await instance.waitUntilExit();
}

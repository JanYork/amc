import {Box, Text, type TextProps} from 'ink';
import {AmcError, type MigrationPlan, type Skill, type Target, type TargetState} from '../core/index.js';
import {themePalettes, type TerminalPresentation, type ThemePalette} from '../presentation/theme.js';
import type {ActionScope, TerminalLayout} from './view.js';

export type Notice = Readonly<{
	kind: 'info' | 'success' | 'error';
	text: string;
}>;

export type Modal =
	| Readonly<{kind: 'source'; plan: MigrationPlan}>
	| Readonly<{kind: 'confirm'; plan: MigrationPlan; source: Target | undefined}>;

export function ThemedText({color, ...props}: Readonly<Omit<TextProps, 'color'> & {
	color: string | undefined;
}>): React.JSX.Element {
	return color === undefined ? <Text {...props}/> : <Text {...props} color={color}/>;
}

export function errorText(error: unknown): string {
	if (error instanceof AmcError) {
		return `${error.code}: ${error.message}`;
	}
	return error instanceof Error ? error.message : 'Unexpected AMC failure.';
}

export function targetFromInput(input: string): Target | undefined {
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
		case 'shared':
			return '◆';
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
		case 'shared':
			return palette.warning;
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

export function TableBorder({
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

export function TableHeader({
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

export function TableMessageRow({
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

export function SkillRow({
	skill,
	selected,
	scope,
	terminalLayout,
	presentation,
	updateState,
}: Readonly<{
	skill: Skill;
	selected: boolean;
	scope: ActionScope;
	terminalLayout: Extract<TerminalLayout, {kind: 'ready'}>;
	presentation: TerminalPresentation;
	updateState: 'current' | 'update' | 'drift' | 'untracked' | 'error' | undefined;
}>): React.JSX.Element {
	const palette = themePalettes[presentation.theme];
	const updateMark = updateState === 'current' ? ' ✓'
		: updateState === 'update' ? ' ↑'
			: updateState === 'drift' ? ' ~'
				: updateState === 'untracked' ? ' —'
					: updateState === 'error' ? ' ?' : '';
	return (
		<Box>
			<ThemedText color={palette.border} dimColor={palette.border === undefined}>│ </ThemedText>
			<Box width={terminalLayout.skillWidth}>
				<ThemedText bold={selected} color={selected ? palette.accent : undefined} wrap="truncate-end">
					{`${selected ? '› ' : '  '}${skill.name}${updateMark}`.padEnd(terminalLayout.skillWidth)}
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

export function scopeLabel(scope: ActionScope): string {
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

export function noticeColor(kind: Notice['kind'], palette: ThemePalette): string | undefined {
	switch (kind) {
		case 'info':
			return palette.warning;
		case 'success':
			return palette.enabled;
		case 'error':
			return palette.error;
	}
}

export function currentStatus(
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

export function HelpPanel(): React.JSX.Element {
	return (
		<Box flexDirection="column">
			<Text bold>Keyboard</Text>
			<Text wrap="truncate-end">↑/↓ or j/k move · Page Up/Down page · Home/End jump</Text>
			<Text wrap="truncate-end">←/→ choose scope · Space toggle · 1/2/3 direct target</Text>
			<Text wrap="truncate-end">/ search · m migrate · c check · C check all · u upgrade · d permanent delete</Text>
			<Text wrap="truncate-end">Tab sections · r refresh · Esc cancel/clear</Text>
			<Text wrap="truncate-end">Updates: ✓ current · ↑ update · ~ drift · — untracked · ? error</Text>
			<Text wrap="truncate-end">? close help · q quit</Text>
		</Box>
	);
}


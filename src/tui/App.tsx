import {useCallback, useEffect, useState} from 'react';
import {Box, render, Text, useApp, useInput} from 'ink';
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

export type AppProps = Readonly<{
	layout: Layout;
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

function StateMark({state}: Readonly<{state: TargetState}>): React.JSX.Element {
	switch (state) {
		case 'enabled':
			return <Text color="green">●</Text>;
		case 'disabled':
			return <Text dimColor>○</Text>;
		case 'unmanaged':
			return <Text color="yellow">?</Text>;
		case 'conflict':
			return <Text color="red">!</Text>;
	}
}

function SkillRow({skill, selected}: Readonly<{skill: Skill; selected: boolean}>): React.JSX.Element {
	return (
		<Box>
			<Box width={26}>
				{selected
					? <Text color="cyan">› {skill.name}</Text>
					: <Text>  {skill.name}</Text>}
			</Box>
			<Box width={10}><StateMark state={skill.states.claude}/></Box>
			<Box width={10}><StateMark state={skill.states.pi}/></Box>
			<Box width={10}><StateMark state={skill.states.codex}/></Box>
		</Box>
	);
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

export function App({layout}: AppProps): React.JSX.Element {
	const {exit} = useApp();
	const [skills, setSkills] = useState<ReadonlyArray<Skill> | undefined>();
	const [diagnosticCount, setDiagnosticCount] = useState(0);
	const [selected, setSelected] = useState(0);
	const [notice, setNotice] = useState<Notice | undefined>();
	const [modal, setModal] = useState<Modal | undefined>();
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const result = await listSkills(layout);
			setSkills(result.skills);
			setDiagnosticCount(result.diagnostics.length);
			setSelected(current => Math.min(current, Math.max(0, result.skills.length - 1)));
		} catch (error: unknown) {
			setSkills([]);
			setNotice({kind: 'error', text: errorText(error)});
		}
	}, [layout]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

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
		if (input === 'q') {
			exit();
			return;
		}
		if (skills === undefined || skills.length === 0) {
			if (input === 'r') {
				void refresh();
			}
			return;
		}
		if (key.downArrow || input === 'j') {
			setSelected(current => Math.min(skills.length - 1, current + 1));
			return;
		}
		if (key.upArrow || input === 'k') {
			setSelected(current => Math.max(0, current - 1));
			return;
		}
		if (input === 'r') {
			setNotice({kind: 'info', text: 'Refreshed.'});
			void refresh();
			return;
		}

		const skill = skills[selected];
		if (skill === undefined) {
			return;
		}
		if (input === ' ') {
			const allEnabled = targets.every(target => skill.states[target] === 'enabled');
			void toggle(skill, !allEnabled);
			return;
		}
		const target = targetFromInput(input);
		if (target !== undefined) {
			void toggle(skill, skill.states[target] !== 'enabled', target);
			return;
		}
		if (input === 'm') {
			void beginMigration(skill);
		}
	});

	return (
		<Box flexDirection="column">
			<Box marginBottom={1}><Text bold color="cyan">AMC — Agent Management CLI</Text></Box>
			{skills === undefined ? <Text>Loading Skills…</Text> : skills.length === 0 ? (
				<Text>No Skills found.</Text>
			) : (
				<Box flexDirection="column">
					<Box>
						<Box width={26}><Text bold>  Skill</Text></Box>
						<Box width={10}><Text bold>Claude</Text></Box>
						<Box width={10}><Text bold>Pi</Text></Box>
						<Box width={10}><Text bold>Codex</Text></Box>
					</Box>
					{skills.map((skill, index) => (
						<SkillRow key={skill.name} skill={skill} selected={index === selected}/>
					))}
				</Box>
			)}
			<Box marginTop={1} flexDirection="column">
				{modal?.kind === 'source' ? (
					<Text color="yellow">Choose source: 1 Claude  2 Pi  3 Codex  Esc cancel</Text>
				) : undefined}
				{modal?.kind === 'confirm' ? (
					<Text color="yellow">
						Migrate {modal.plan.name}?{modal.source === undefined ? '' : ` Source: ${modal.source}.`} y confirm / n cancel
					</Text>
				) : undefined}
				{busy ? <Text color="yellow">Working…</Text> : undefined}
				{notice === undefined ? undefined : <Text color={noticeColor(notice.kind)}>{notice.text}</Text>}
				{diagnosticCount > 0 ? <Text color="yellow">Warnings: {diagnosticCount}</Text> : undefined}
			</Box>
			<Box marginTop={1}>
				<Text dimColor>↑/↓ move  Space all  1 Claude  2 Pi  3 Codex  m migrate  r refresh  q quit</Text>
			</Box>
		</Box>
	);
}

export async function runTui(layout: Layout): Promise<void> {
	const instance = render(<App layout={layout}/>, {alternateScreen: true});
	await instance.waitUntilExit();
}

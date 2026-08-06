import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput, useWindowSize} from 'ink';
import {canRepairSkillReconciliation, executeMigration, executeReconciliation, executeSkillReconciliation, listSkills, planMigration, planReconciliation, planSkillReconciliation, readSkillDetails, recoverIncompleteReconciliations, setSkillEnabled, targets, type Layout, type MigrationPlan, type Skill, type SkillDetails, type ReconcileChoice, type SkillReconcilePlan, type Target} from '../core/index.js';
import {checkAppliedSkillUpdates, permanentlyDeleteSkill, planPermanentDelete, upgradeMarketplaceSkill, type MarketplaceRuntime, type PermanentDeletePlan, type SkillUpdateState} from '../core/marketplace.js';
import {themePalettes, type TerminalPresentation} from '../presentation/theme.js';
import {filterSkills, layoutForTerminal, moveScope, moveSelection, visibleWindow, type ActionScope, type SelectionMovement} from './view.js';
import {currentStatus, errorText, HelpPanel, noticeColor, scopeLabel, SkillRow, TableBorder, TableHeader, TableMessageRow, targetFromInput, ThemedText, type Modal, type Notice} from './components.js';

export type AppProps = Readonly<{
	layout: Layout;
	presentation: TerminalPresentation;
	windowSize?: Readonly<{columns: number; rows: number}>;
	marketplace?: MarketplaceRuntime | undefined;
}>;

type DeleteFlow =
	| Readonly<{kind: 'warning'; plan: PermanentDeletePlan}>
	| Readonly<{kind: 'name'; plan: PermanentDeletePlan; value: string}>;

type ReconcileFlow =
	| Readonly<{kind: 'source'; plan: SkillReconcilePlan; choices: ReadonlyArray<ReconcileChoice>}>
	| Readonly<{kind: 'confirm'; plan: SkillReconcilePlan; source: ReconcileChoice}>;

function reconcileChoices(plan: SkillReconcilePlan): ReadonlyArray<ReconcileChoice> {
	const sources = plan.sources
		.filter(source => source.kind === 'directory')
		.map(source => source.source);
	return plan.canonical.state === 'valid' ? [...sources, 'canonical'] : sources;
}

function reconcileChoiceFromInput(input: string, choices: ReadonlyArray<ReconcileChoice>): ReconcileChoice | undefined {
	if (!/^[1-9]$/u.test(input)) return undefined;
	return choices[Number(input) - 1];
}

function reconcileChoicePrompt(choices: ReadonlyArray<ReconcileChoice>): string {
	return `Choose reconcile source: ${choices.map((choice, index) => `${index + 1} ${choice}`).join('  ')}  Esc cancel`;
}

function updateStateNotice(state: SkillUpdateState): Notice {
	switch (state) {
		case 'current': return {kind: 'success', text: 'Current: installed content matches the remote Skill.'};
		case 'update': return {kind: 'info', text: 'Update available: remote Skill content has changed. Press u to upgrade.'};
		case 'drift': return {kind: 'error', text: 'Local drift: installed content was modified; upgrade is blocked.'};
		case 'untracked': return {kind: 'info', text: 'Untracked: no Marketplace provenance; remote updates cannot be checked.'};
		case 'error': return {kind: 'error', text: 'Update check failed for this Skill.'};
	}
}

export function App({layout, presentation, windowSize, marketplace}: AppProps): React.JSX.Element {
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
	const [deleteFlow, setDeleteFlow] = useState<DeleteFlow | undefined>();
	const [reconcileFlow, setReconcileFlow] = useState<ReconcileFlow | undefined>();
	const [updateStates, setUpdateStates] = useState<ReadonlyMap<string, SkillUpdateState>>(new Map());
	const startupStarted = useRef(false);
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
		if (startupStarted.current) return;
		startupStarted.current = true;
		void (async (): Promise<void> => {
			try {
				const recovery = await recoverIncompleteReconciliations(layout);
				if (recovery.failures.length > 0) throw new Error(`Reconciliation recovery blocked at: ${recovery.failures.join(', ')}`);
				const result = await executeReconciliation(layout, await planReconciliation(layout));
				await refresh();
				if (result.failure !== undefined) {
					setNotice({kind: 'error', text: `${result.failure.code}: ${result.failure.message}`});
					return;
				}
				if (recovery.recovered.length > 0 || result.reconciled.length > 0 || result.conflicts.length > 0 || result.blocked.length > 0) {
					setNotice({
						kind: result.conflicts.length > 0 || result.blocked.length > 0 ? 'info' : 'success',
						text: `Reconciled ${result.reconciled.length} Skill${result.reconciled.length === 1 ? '' : 's'}; ${recovery.recovered.length} recovered; ${result.conflicts.length} conflicts; ${result.blocked.length} blocked.`, 
					});
				}
			} catch (error: unknown) {
				setSkills([]);
				setNotice({kind: 'error', text: errorText(error)});
			}
		})();
	}, [layout, refresh]);

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
			const reconciliation = await planSkillReconciliation(layout, skill.name);
			if (reconciliation.sources.some(source => source.source === 'agents' || source.source === 'agent')) {
				setBusy(false);
				if (reconciliation.status === 'blocked') {
					if (canRepairSkillReconciliation(reconciliation)) {
						setReconcileFlow({kind: 'confirm', plan: reconciliation, source: 'canonical'});
						setNotice({kind: 'info', text: `Repair ${skill.name}? Keep canonical and archive invalid sources. y confirm / n cancel`});
						return;
					}
					const blocker = reconciliation.blockers[0];
					setNotice({kind: 'error', text: blocker === undefined ? 'Reconciliation is blocked.' : `${blocker.message} ${blocker.path}`});
					return;
				}
				if (reconciliation.status === 'conflict') {
					const choices = reconcileChoices(reconciliation);
					if (choices.length === 0) {
						setNotice({kind: 'error', text: 'Reconciliation has no selectable directory or canonical source.'});
						return;
					}
					setReconcileFlow({kind: 'source', plan: reconciliation, choices});
					setNotice({kind: 'info', text: reconcileChoicePrompt(choices)});
					return;
				}
				if (reconciliation.status === 'ready' && reconciliation.selectedSource !== undefined) {
					setReconcileFlow({kind: 'confirm', plan: reconciliation, source: reconciliation.selectedSource});
					setNotice({kind: 'info', text: `Reconcile ${skill.name}? Source: ${reconciliation.selectedSource}. y confirm / n cancel`});
					return;
				}
				setNotice({kind: 'info', text: `${skill.name} is already managed.`});
				return;
			}
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

	const reconcileSelected = useCallback(async (flow: Extract<ReconcileFlow, {kind: 'confirm'}>): Promise<void> => {
		setReconcileFlow(undefined);
		setBusy(true);
		try {
			const result = await executeSkillReconciliation(layout, flow.plan, flow.source);
			await refresh();
			setNotice({kind: 'success', text: `Reconciled ${result.name}: ${result.linkedTargets.join(', ') || 'managed'}`});
		} catch (error: unknown) {
			setNotice({kind: 'error', text: errorText(error)});
		} finally {
			setBusy(false);
		}
	}, [layout, refresh]);

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

	const upgrade = useCallback(async (skill: Skill): Promise<void> => {
		if (marketplace === undefined) {
			setNotice({kind: 'error', text: 'Marketplace runtime is unavailable.'});
			return;
		}
		setBusy(true);
		try {
			const result = await upgradeMarketplaceSkill(layout, marketplace, skill.name);
			await refresh();
			setNotice({kind: 'success', text: `Upgrade ${skill.name}: ${result.state}`});
		} catch (error: unknown) {
			setNotice({kind: 'error', text: errorText(error)});
		} finally {
			setBusy(false);
		}
	}, [layout, marketplace, refresh]);

	const checkUpdates = useCallback(async (name?: string): Promise<void> => {
		if (marketplace === undefined) {
			setNotice({kind: 'error', text: 'Marketplace runtime is unavailable.'});
			return;
		}
		setBusy(true);
		try {
			const statuses = await checkAppliedSkillUpdates(layout, marketplace, name);
			setUpdateStates(current => {
				const next = new Map(current);
				for (const item of statuses) next.set(item.name, item.state);
				return next;
			});
			setNotice(name !== undefined && statuses[0] !== undefined
				? updateStateNotice(statuses[0].state)
				: {kind: 'success', text: `Checked ${statuses.length} applied Skills: ${statuses.filter(item => item.state === 'update').length} updates.`});
		} catch (error: unknown) {
			setNotice({kind: 'error', text: errorText(error)});
		} finally {
			setBusy(false);
		}
	}, [layout, marketplace]);

	const beginDelete = useCallback(async (skill: Skill): Promise<void> => {
		setBusy(true);
		try {
			setDeleteFlow({kind: 'warning', plan: await planPermanentDelete(layout, skill.name)});
			setNotice(undefined);
		} catch (error: unknown) {
			setNotice({kind: 'error', text: errorText(error)});
		} finally {
			setBusy(false);
		}
	}, [layout]);

	const confirmDelete = useCallback(async (flow: Extract<DeleteFlow, {kind: 'name'}>): Promise<void> => {
		if (flow.value !== flow.plan.name) {
			setNotice({kind: 'error', text: 'Permanent delete confirmation name does not match.'});
			return;
		}
		setDeleteFlow(undefined);
		setBusy(true);
		try {
			await permanentlyDeleteSkill(layout, flow.plan, {challenge: flow.plan.challenge, name: flow.value});
			await refresh();
			setNotice({kind: 'success', text: `Permanently deleted ${flow.plan.name}; it cannot be restored.`});
		} catch (error: unknown) {
			setNotice({kind: 'error', text: errorText(error)});
		} finally {
			setBusy(false);
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
		if (key.tab || input === '\t') {
			return;
		}
		if (busy) {
			return;
		}
		if (deleteFlow?.kind === 'warning') {
			if (input === 'y') setDeleteFlow({kind: 'name', plan: deleteFlow.plan, value: ''});
			else if (input === 'n' || key.escape) setDeleteFlow(undefined);
			return;
		}
		if (deleteFlow?.kind === 'name') {
			if (key.escape) {
				setDeleteFlow(undefined);
				return;
			}
			if (key.return) {
				void confirmDelete(deleteFlow);
				return;
			}
			if (key.backspace || key.delete) {
				setDeleteFlow({...deleteFlow, value: Array.from(deleteFlow.value).slice(0, -1).join('')});
				return;
			}
			if (input.length > 0 && !key.ctrl && !key.meta) setDeleteFlow({...deleteFlow, value: `${deleteFlow.value}${input}`});
			return;
		}
		if (reconcileFlow?.kind === 'source') {
			if (input === 'n' || key.escape) {
				setReconcileFlow(undefined);
				setNotice({kind: 'info', text: 'Reconciliation cancelled.'});
				return;
			}
			const source = reconcileChoiceFromInput(input, reconcileFlow.choices);
			if (source !== undefined) {
				setReconcileFlow({kind: 'confirm', plan: reconcileFlow.plan, source});
				setNotice({kind: 'info', text: `Reconcile ${reconcileFlow.plan.name}? Source: ${source}. y confirm / n cancel`});
			}
			return;
		}
		if (reconcileFlow?.kind === 'confirm') {
			if (input === 'y') {
				void reconcileSelected(reconcileFlow);
			} else if (input === 'n' || key.escape) {
				setReconcileFlow(undefined);
				setNotice({kind: 'info', text: 'Reconciliation cancelled.'});
			}
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
			return;
		}
		if (input === 'c') {
			void checkUpdates(selectedSkill.name);
			return;
		}
		if (input === 'C') {
			void checkUpdates();
			return;
		}
		if (input === 'u') {
			void upgrade(selectedSkill);
			return;
		}
		if (input === 'd') {
			void beginDelete(selectedSkill);
		}
	});

	const selectedUpdateState = selectedSkill === undefined ? undefined : updateStates.get(selectedSkill.name);
	const status = currentStatus(modal, busy, notice ?? (selectedUpdateState === undefined ? undefined : updateStateNotice(selectedUpdateState)), searching);
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
							updateState={updateStates.get(skill.name)}
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
			{deleteFlow !== undefined && (
				<Box flexDirection="column">
					<ThemedText bold color={palette.error}>{deleteFlow.kind === 'warning'
						? `PERMANENTLY delete ${deleteFlow.plan.name}? Press y to continue or n to cancel.`
						: `Type ${deleteFlow.plan.name} to confirm: ${deleteFlow.value}█`}</ThemedText>
					<ThemedText color={palette.warning}>This removes canonical content, AMC-owned links, and AMC recovery copies.</ThemedText>
				</Box>
			)}
			<Box>
				<ThemedText color={noticeColor(status.kind, palette)} wrap="truncate-end">{status.text}</ThemedText>
			</Box>
			{terminalLayout.showLegend && (
				<Box>
					<ThemedText color={palette.enabled}>● enabled</ThemedText><ThemedText color={palette.muted}>  ○ disabled  </ThemedText><ThemedText color={palette.warning}>◆ shared  ◇ unmanaged</ThemedText><ThemedText color={palette.error}>  ! conflict</ThemedText>
					{dimensions.columns >= 110 && <><ThemedText color={palette.muted}>   ✓ current  </ThemedText><ThemedText color={palette.warning}>↑ update  ~ drift  — untracked</ThemedText><ThemedText color={palette.error}>  ? error</ThemedText></>}
				</Box>
			)}
		</Box>
	);
}


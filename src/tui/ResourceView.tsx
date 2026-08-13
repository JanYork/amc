import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {editHook, readHookPreview, restoreHookEdit, scanMcpServers, scanHooks, scanPlugins, setHookEnabled, setMcpServerEnabled, setPluginEnabled, type HookEditRecovery, type HookEditResult, type HookPreview, type HookResource, type McpServerResource, type PluginResource, type ResourceContext, type ResourceRuntime} from '../core/resources.js';
import {themePalettes, type TerminalPresentation} from '../presentation/theme.js';
import {errorText, noticeColor, ThemedText, type Notice} from './components.js';

export type Section = 'skills' | 'hooks' | 'plugins' | 'mcp';
type ResourceItem = HookResource | PluginResource | McpServerResource;

function itemSearch(item: ResourceItem): string {
	return 'event' in item
		? `${item.provider}\n${item.scope}\n${item.event}\n${item.type}\n${item.sourcePath}`
		: 'transport' in item
			? `${item.provider}\n${item.name}\n${item.scope}\n${item.transport}\n${item.state}`
			: `${item.provider}\n${item.name}\n${item.state}\n${item.capability}`;
}

function resourceCell(value: string, width: number): string {
	const characters = Array.from(value);
	const fitted = characters.length > width
		? width <= 1 ? '…' : `${characters.slice(0, width - 1).join('')}…`
		: value;
	return fitted.padEnd(width);
}

function pluginInteractionSummary(plugin: PluginResource): string {
	return plugin.provider === 'codex'
		? 'Codex: run `codex`, then enter `/plugins` and toggle with Space.'
		: 'Pi: run `pi config`, then change the package resource state.';
}

function previewRows(preview: HookPreview, offset: number, count: number): ReadonlyArray<Readonly<{number: number; text: string}>> {
	return preview.lines.slice(offset, offset + count).map((text, index) => ({number: offset + index + 1, text}));
}

export function ResourceView({
	section,
	resources,
	presentation,
	windowSize,
}: Readonly<{
	section: Exclude<Section, 'skills'>;
	resources: Readonly<{context: ResourceContext; runtime: ResourceRuntime}>;
	presentation: TerminalPresentation;
	windowSize: Readonly<{columns: number; rows: number}>;
}>): React.JSX.Element {
	const {exit, suspendTerminal} = useApp();
	const palette = themePalettes[presentation.theme];
	const [items, setItems] = useState<ReadonlyArray<ResourceItem>>([]);
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [query, setQuery] = useState('');
	const [searching, setSearching] = useState(false);
	const [notice, setNotice] = useState<Notice>({kind: 'info', text: 'Loading…'});
	const [busy, setBusy] = useState(false);
	const [preview, setPreview] = useState<HookPreview | undefined>();
	const [previewOffset, setPreviewOffset] = useState(0);
	const [fullPreview, setFullPreview] = useState(false);
	const [recovery, setRecovery] = useState<HookEditRecovery | undefined>();
	const refresh = useCallback(async (preferredSourcePath?: string): Promise<void> => {
		try {
			const result = section === 'hooks'
				? await scanHooks(resources.context, resources.runtime)
				: section === 'plugins'
					? await scanPlugins(resources.context, resources.runtime)
					: await scanMcpServers(resources.context, resources.runtime);
			const rows: ReadonlyArray<ResourceItem> = 'hooks' in result ? result.hooks : 'plugins' in result ? result.plugins : result.servers;
			setItems(rows);
			setSelectedId(current => {
				const preferred = rows.find(item => 'sourcePath' in item && item.sourcePath === preferredSourcePath);
				if (preferred !== undefined) return preferred.id;
				if (rows.some(item => item.id === current)) return current;
				return rows[0]?.id;
			});
			setNotice({kind: result.diagnostics.length === 0 ? 'info' : 'error', text: `${result.diagnostics.length} warnings`});
		} catch (error: unknown) {
			setItems([]);
			setNotice({kind: 'error', text: errorText(error)});
		}
	}, [resources, section]);

	useEffect(() => {
		setItems([]);
		setSelectedId(undefined);
		void refresh();
	}, [refresh]);

	const filtered = useMemo(() => {
		const normalized = query.toLowerCase();
		return normalized.length === 0 ? items : items.filter(item => itemSearch(item).toLowerCase().includes(normalized));
	}, [items, query]);
	const selectedIndex = Math.max(0, filtered.findIndex(item => item.id === selectedId));
	const selected = filtered[selectedIndex];
	const selectedRef = useRef(selected);
	selectedRef.current = selected;

	useEffect(() => {
		let active = true;
		if (section !== 'hooks' || selected === undefined || !('event' in selected)) {
			setPreview(undefined);
			return () => { active = false; };
		}
		setPreview(undefined);
		void readHookPreview(resources.context, resources.runtime, selected.id).then(result => {
			if (active) {
				setPreview(result);
				setPreviewOffset(current => Math.min(current, Math.max(0, result.lines.length - 1)));
			}
		}).catch((error: unknown) => {
			if (active) setNotice({kind: 'error', text: errorText(error)});
		});
		return () => { active = false; };
	}, [resources, section, selected]);

	const movePreview = useCallback((next: number): void => {
		setPreviewOffset(Math.max(0, Math.min(Math.max(0, (preview?.lines.length ?? 1) - 1), next)));
	}, [preview]);

	useInput((input, key) => {
		if (key.tab || input === '\t' || busy) {
			return;
		}
		if (searching) {
			if (key.escape) {
				setSearching(false);
				setQuery('');
			} else if (key.return) {
				setSearching(false);
			} else if (key.backspace || key.delete) {
				setQuery(current => Array.from(current).slice(0, -1).join(''));
			} else if (input.length > 0 && !key.ctrl && !key.meta) {
				setQuery(current => `${current}${input}`);
			}
			return;
		}
		if (fullPreview) {
			if (key.escape || input === 'p') setFullPreview(false);
			else if (key.downArrow || input === 'j') movePreview(previewOffset + 1);
			else if (key.upArrow || input === 'k') movePreview(previewOffset - 1);
			else if (key.pageDown) movePreview(previewOffset + Math.max(1, windowSize.rows - 4));
			else if (key.pageUp) movePreview(previewOffset - Math.max(1, windowSize.rows - 4));
			else if (input === 'g') movePreview(0);
			else if (input === 'G') movePreview(Math.max(0, (preview?.lines.length ?? 1) - 1));
			return;
		}
		if (input === '/') {
			setSearching(true);
			return;
		}
		if (input === 'q') {
			exit();
			return;
		}
		if (input === 'r') {
			void refresh();
			return;
		}
		if (section === 'hooks' && input === 'p' && preview !== undefined) {
			setFullPreview(true);
			return;
		}
		if (section === 'hooks' && input === 'u' && recovery !== undefined) {
			setBusy(true);
			void restoreHookEdit(recovery).then(async () => {
				setRecovery(undefined);
				await refresh(recovery.sourcePath);
				setNotice({kind: 'success', text: 'Restored the pre-edit Hook source.'});
			}).catch((error: unknown) => setNotice({kind: 'error', text: errorText(error)})).finally(() => setBusy(false));
			return;
		}
		if ((key.downArrow || input === 'j') && filtered.length > 0) {
			setSelectedId(filtered[Math.min(filtered.length - 1, selectedIndex + 1)]?.id);
			return;
		}
		if ((key.upArrow || input === 'k') && filtered.length > 0) {
			setSelectedId(filtered[Math.max(0, selectedIndex - 1)]?.id);
			return;
		}
		if (section === 'hooks' && input === 'e' && selectedRef.current !== undefined) {
			const activeHook = selectedRef.current;
			if (!('event' in activeHook) || activeHook.capability !== 'config-edit') {
				setNotice({kind: 'error', text: 'This Hook source is provider-owned and read-only.'});
				return;
			}
			const hookId = activeHook.id;
			const sourcePath = activeHook.sourcePath;
			setBusy(true);
			void (async (): Promise<void> => {
				let result: HookEditResult | undefined;
				try {
					await suspendTerminal(async () => {
						result = await editHook(resources.context, resources.runtime, hookId);
					});
					if (result === undefined) throw new Error('Hook editor returned no result.');
					await refresh(sourcePath);
					if (result.state === 'invalid') {
						setRecovery(result.recovery);
						setNotice({kind: 'error', text: `${result.diagnostic.message} · u restore backup`});
					} else {
						setRecovery(undefined);
						setNotice({kind: 'success', text: 'Saved Hook source.'});
					}
				} catch (error: unknown) {
					setNotice({kind: 'error', text: errorText(error)});
				} finally {
					setBusy(false);
				}
			})();
			return;
		}
		if (section === 'hooks' && input === ' ' && selected !== undefined && 'event' in selected) {
			setBusy(true);
			void setHookEnabled(resources.context, resources.runtime, selected.id, selected.state !== 'enabled')
				.then(hook => {
					setNotice({kind: 'success', text: `${hook.id}: ${hook.state}`});
					return refresh();
				})
				.catch((error: unknown) => {
					setNotice({kind: 'error', text: errorText(error)});
				})
				.finally(() => {
					setBusy(false);
				});
			return;
		}
		if (section === 'plugins' && input === ' ' && selected !== undefined && !('event' in selected)) {
			if ('transport' in selected) {
				return;
			}
			if (selected.capability === 'native-interactive' || selected.capability === 'unsupported') {
				setNotice({kind: 'info', text: pluginInteractionSummary(selected)});
				return;
			}
			setBusy(true);
			void setPluginEnabled(resources.context, resources.runtime, selected.id, selected.state !== 'enabled')
				.then(plugin => {
					setNotice({kind: 'success', text: `${plugin.id}: ${plugin.state}`});
					return refresh();
				})
				.catch((error: unknown) => {
					setNotice({kind: 'error', text: errorText(error)});
				})
				.finally(() => {
					setBusy(false);
				});
			return;
		}
		if (section === 'mcp' && input === ' ' && selected !== undefined && 'transport' in selected) {
			setBusy(true);
			void setMcpServerEnabled(resources.context, resources.runtime, selected.id, selected.state !== 'enabled')
				.then(server => {
					setNotice({kind: 'success', text: `${server.id}: ${server.state}`});
					return refresh();
				})
				.catch((error: unknown) => {
					setNotice({kind: 'error', text: errorText(error)});
				})
				.finally(() => {
					setBusy(false);
				});
		}
	});
	if (windowSize.columns < 44 || windowSize.rows < 9) {
		return (
			<Box flexDirection="column">
				<ThemedText color={palette.warning}>Terminal too small: {windowSize.columns}×{windowSize.rows + 1}. Resize to at least 44×10.</ThemedText>
				<Text dimColor>q quit</Text>
			</Box>
		);
	}
	if (fullPreview && preview !== undefined) {
		const count = Math.max(1, windowSize.rows - 3);
		const rows = previewRows(preview, previewOffset, count);
		return (
			<Box flexDirection="column">
				<Text bold>Full preview · {preview.sourcePath} · {rows[0]?.number ?? 0}–{rows.at(-1)?.number ?? 0}/{preview.lines.length}{preview.truncated ? '+' : ''}</Text>
				{rows.map(row => <Text key={row.number} wrap="truncate-end">{String(row.number).padStart(4)}  {row.text}</Text>)}
				<ThemedText color={palette.muted}>j/k scroll  PgUp/PgDn page  g/G ends  Esc back</ThemedText>
			</Box>
		);
	}

	const nameWidth = Math.max(12, windowSize.columns - 49);
	const line = '─'.repeat(Math.max(1, windowSize.columns));
	const hookPreviewRows = section === 'hooks' ? Math.min(5, Math.max(2, Math.floor((windowSize.rows - 9) / 2))) : 0;
	const listRows = Math.min(20, Math.max(1, windowSize.rows - 9 - hookPreviewRows));
	const listStart = Math.min(Math.max(0, filtered.length - listRows), Math.max(0, selectedIndex - Math.floor(listRows / 2)));
	const listShown = filtered.slice(listStart, listStart + listRows);
	const inlinePreview = preview === undefined ? [] : previewRows(preview, previewOffset, hookPreviewRows);
	return (
		<Box flexDirection="column">
			<Box><Text>Search: </Text><ThemedText color={query.length === 0 ? palette.muted : palette.warning}>{query.length === 0 ? '—' : query}{searching ? '█' : ''}</ThemedText></Box>
			<ThemedText color={palette.border}>{line}</ThemedText>
			{section === 'plugins'
				? <Text bold>{resourceCell('  Plugin', nameWidth)} │ Provider │ State     │ Management</Text>
				: section === 'mcp'
					? <Text bold>{resourceCell('  MCP Server', nameWidth)} │ Provider │ Scope   │ Transport │ State</Text>
					: <Text bold>{resourceCell('  Event', nameWidth)} │ Provider │ Scope   │ Type      │ State    │ ID</Text>}
			<ThemedText color={palette.border}>{line}</ThemedText>
			{listShown.length === 0 ? <Text dimColor>No {section} found.</Text> : listShown.map(item => {
				const active = item.id === selected?.id;
				if ('event' in item) {
					return <ThemedText key={item.id} bold={active} color={active ? palette.accent : item.state === 'enabled' ? palette.enabled : undefined} wrap="truncate-end">{resourceCell(`${active ? '› ' : '  '}${item.event}`, nameWidth)} │ {item.provider.padEnd(8)} │ {item.scope.padEnd(7)} │ {resourceCell(item.type, 9)} │ {item.state.padEnd(8)} │ {item.id}</ThemedText>;
				}
				if ('transport' in item) {
					return <ThemedText key={item.id} bold={active} color={active ? palette.accent : item.state === 'enabled' ? palette.enabled : undefined} wrap="truncate-end">{resourceCell(`${active ? '› ' : '  '}${item.name}`, nameWidth)} │ {item.provider.padEnd(8)} │ {item.scope.padEnd(7)} │ {item.transport.padEnd(9)} │ {item.state}</ThemedText>;
				}
				return <ThemedText key={item.id} bold={active} color={active ? palette.accent : item.state === 'enabled' ? palette.enabled : undefined} wrap="truncate-end">{resourceCell(`${active ? '› ' : '  '}${item.name}`, nameWidth)} │ {item.provider.padEnd(8)} │ {item.state.padEnd(9)} │ {item.capability}</ThemedText>;
			})}
			<ThemedText color={palette.border}>{line}</ThemedText>
			{section === 'hooks' && selected !== undefined && 'event' in selected && <>
				<Text bold>Preview · {selected.sourcePath} · {inlinePreview[0]?.number ?? 0}–{inlinePreview.at(-1)?.number ?? 0}/{preview?.lines.length ?? 0}{preview?.truncated === true ? '+' : ''}</Text>
				{preview === undefined
					? <Text dimColor>Loading preview…</Text>
					: inlinePreview.map(row => <Text key={row.number} wrap="truncate-end">{String(row.number).padStart(4)}  {row.text}</Text>)}
			</>}
			{selected !== undefined && ('event' in selected
				? undefined
				: 'transport' in selected
					? <Text wrap="truncate-end"><ThemedText color={palette.muted}>Source: </ThemedText>{selected.sourcePath} · Space toggles</Text>
					: <Text wrap="truncate-end"><ThemedText color={palette.muted}>Details: </ThemedText>version {selected.version ?? 'unknown'} · scope {selected.scope ?? 'unknown'} · {selected.capability === 'native-interactive' || selected.capability === 'unsupported' ? pluginInteractionSummary(selected) : 'Space toggles'}</Text>)}
			<Box><Box flexGrow={1}><ThemedText color={palette.muted}>{filtered.length === 0 ? 0 : listStart + 1}–{Math.min(filtered.length, listStart + listRows)} / {filtered.length}</ThemedText></Box><ThemedText color={palette.muted}>↑↓ move  / search  {section === 'hooks' ? 'p preview  Space toggle  e edit' : 'Space toggle'}  r refresh</ThemedText></Box>
			<ThemedText color={noticeColor(notice.kind, palette)} wrap="truncate-end">{busy ? 'Working…' : notice.text}</ThemedText>
		</Box>
	);
}

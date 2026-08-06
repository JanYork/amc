import {useCallback, useEffect, useMemo, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {scanMcpServers, scanHooks, scanPlugins, setHookEnabled, setMcpServerEnabled, setPluginEnabled, type HookResource, type McpServerResource, type PluginResource, type ResourceContext, type ResourceRuntime} from '../core/resources.js';
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

export function ResourceView({
	section,
	resources,
	presentation,
	windowSize,
	onHookEdit,
}: Readonly<{
	section: Exclude<Section, 'skills'>;
	resources: Readonly<{context: ResourceContext; runtime: ResourceRuntime}>;
	presentation: TerminalPresentation;
	windowSize: Readonly<{columns: number; rows: number}>;
	onHookEdit: (id: string) => void;
}>): React.JSX.Element {
	const {exit} = useApp();
	const palette = themePalettes[presentation.theme];
	const [items, setItems] = useState<ReadonlyArray<ResourceItem>>([]);
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [query, setQuery] = useState('');
	const [searching, setSearching] = useState(false);
	const [notice, setNotice] = useState<Notice>({kind: 'info', text: 'Loading…'});
	const [busy, setBusy] = useState(false);
	const refresh = useCallback(async (): Promise<void> => {
		try {
			const result = section === 'hooks'
				? await scanHooks(resources.context, resources.runtime)
				: section === 'plugins'
					? await scanPlugins(resources.context, resources.runtime)
					: await scanMcpServers(resources.context, resources.runtime);
			const rows: ReadonlyArray<ResourceItem> = 'hooks' in result ? result.hooks : 'plugins' in result ? result.plugins : result.servers;
			setItems(rows);
			setSelectedId(current => {
				return rows.some(item => item.id === current) ? current : rows[0]?.id;
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
		setNotice({kind: 'info', text: 'Loading…'});
		void refresh();
	}, [refresh]);

	const filtered = useMemo(() => {
		const normalized = query.toLowerCase();
		return normalized.length === 0 ? items : items.filter(item => itemSearch(item).toLowerCase().includes(normalized));
	}, [items, query]);
	const selectedIndex = Math.max(0, filtered.findIndex(item => item.id === selectedId));
	const visibleRows = Math.min(20, Math.max(1, windowSize.rows - 9));
	const start = Math.min(
		Math.max(0, filtered.length - visibleRows),
		Math.max(0, selectedIndex - Math.floor(visibleRows / 2)),
	);
	const shown = filtered.slice(start, start + visibleRows);
	const selected = filtered[selectedIndex];

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
		if ((key.downArrow || input === 'j') && filtered.length > 0) {
			setSelectedId(filtered[Math.min(filtered.length - 1, selectedIndex + 1)]?.id);
			return;
		}
		if ((key.upArrow || input === 'k') && filtered.length > 0) {
			setSelectedId(filtered[Math.max(0, selectedIndex - 1)]?.id);
			return;
		}
		if (section === 'hooks' && input === 'e' && selected !== undefined) {
			onHookEdit(selected.id);
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

	const nameWidth = Math.max(12, windowSize.columns - 49);
	const line = '─'.repeat(Math.max(1, windowSize.columns));
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
			{shown.length === 0 ? <Text dimColor>No {section} found.</Text> : shown.map(item => {
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
			{selected !== undefined && ('event' in selected
				? <Text wrap="truncate-end"><ThemedText color={palette.muted}>Source: </ThemedText>{selected.sourcePath} · Space toggles</Text>
				: 'transport' in selected
					? <Text wrap="truncate-end"><ThemedText color={palette.muted}>Source: </ThemedText>{selected.sourcePath} · Space toggles</Text>
					: <Text wrap="truncate-end"><ThemedText color={palette.muted}>Details: </ThemedText>version {selected.version ?? 'unknown'} · scope {selected.scope ?? 'unknown'} · {selected.capability === 'native-interactive' || selected.capability === 'unsupported' ? pluginInteractionSummary(selected) : 'Space toggles'}</Text>)}
			<Box><Box flexGrow={1}><ThemedText color={palette.muted}>{filtered.length === 0 ? 0 : start + 1}–{Math.min(filtered.length, start + visibleRows)} / {filtered.length}</ThemedText></Box><ThemedText color={palette.muted}>↑↓ move  / search  {section === 'hooks' ? 'Space toggle  e edit' : 'Space toggle'}  r refresh</ThemedText></Box>
			<ThemedText color={noticeColor(notice.kind, palette)} wrap="truncate-end">{busy ? 'Working…' : notice.text}</ThemedText>
		</Box>
	);
}


import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useInput, useWindowSize} from 'ink';
import {listSkills, type Layout} from '../core/index.js';
import {
	addMarketplaceRepository,
	installMarketplaceSkill,
	listMarketplaceFeatured,
	listMarketplaceRepositories,
	refreshMarketplaceRepository,
	removeMarketplaceRepository,
	resolveMarketplaceItem,
	searchMarketplace,
	setMarketplaceRepositoryEnabled,
	type MarketplaceItem,
	type MarketplaceRepository,
	type MarketplaceRuntime,
} from '../core/marketplace.js';
import {themePalettes, type TerminalPresentation, type ThemePalette} from '../presentation/theme.js';
import {errorText, ThemedText} from './components.js';

export type MarketplaceViewProps = Readonly<{
	layout: Layout;
	runtime: MarketplaceRuntime;
	presentation: TerminalPresentation;
	windowSize?: Readonly<{columns: number; rows: number}>;
}>;

type Column = Readonly<{label: string; width: number; align: 'start' | 'end'}>;
type DetailState = Readonly<{kind: 'idle' | 'loading'}> | Readonly<{kind: 'error'; message: string}>;

function fit(value: string, width: number, align: Column['align'] = 'start'): string {
	const characters = Array.from(value);
	const fitted = characters.length <= width ? value : `${characters.slice(0, Math.max(0, width - 1)).join('')}…`;
	return align === 'end' ? fitted.padStart(width) : fitted.padEnd(width);
}

function columnsFor(width: number): ReadonlyArray<Column> {
	if (width >= 100) {
		return [
			{label: 'Skill', width: 24, align: 'start'},
			{label: 'Source', width: width - 68, align: 'start'},
			{label: 'Origin', width: 9, align: 'start'},
			{label: 'Installs', width: 10, align: 'end'},
			{label: 'Installed', width: 9, align: 'start'},
		];
	}
	if (width >= 64) {
		return [
			{label: 'Skill', width: 18, align: 'start'},
			{label: 'Source', width: width - 50, align: 'start'},
			{label: 'Installs', width: 10, align: 'end'},
			{label: 'Installed', width: 9, align: 'start'},
		];
	}
	const contentWidth = Math.max(30, width) - 10;
	const skillWidth = Math.max(10, Math.floor(contentWidth * 0.4));
	return [
		{label: 'Skill', width: skillWidth, align: 'start'},
		{label: 'Source', width: Math.max(10, contentWidth - skillWidth - 9), align: 'start'},
		{label: 'Installed', width: 9, align: 'start'},
	];
}

function border(columns: ReadonlyArray<Column>, position: 'top' | 'middle' | 'bottom'): string {
	const [left, separator, right] = position === 'top'
		? ['┌', '┬', '┐']
		: position === 'middle'
			? ['├', '┼', '┤']
			: ['└', '┴', '┘'];
	return `${left}${columns.map(column => '─'.repeat(column.width + 2)).join(separator)}${right}`;
}

function tableRow(columns: ReadonlyArray<Column>, values: Readonly<Record<string, string>>): string {
	return `│ ${columns.map(column => fit(values[column.label] ?? '', column.width, column.align)).join(' │ ')} │`;
}

function ThemedMarketplaceRow({
	columns,
	values,
	palette,
	header = false,
	selected = false,
}: Readonly<{
	columns: ReadonlyArray<Column>;
	values: Readonly<Record<string, string>>;
	palette: ThemePalette;
	header?: boolean;
	selected?: boolean;
}>): React.JSX.Element {
	return (
		<Text>
			{columns.map((column, index) => {
				const skill = column.label === 'Skill';
				const installed = column.label === 'Installed';
				const value = values[column.label] ?? '';
				const color = header && skill || selected && skill
					? palette.accent
					: installed ? value.startsWith('●') ? palette.enabled : palette.muted : undefined;
				return (
					<Text key={column.label}>
						<ThemedText color={palette.border} dimColor={palette.border === undefined}>{index === 0 ? '│ ' : ' │ '}</ThemedText>
						<ThemedText bold={header || selected && skill} underline={header && skill} color={color}>
							{fit(value, column.width, column.align)}
						</ThemedText>
					</Text>
				);
			})}
			<ThemedText color={palette.border} dimColor={palette.border === undefined}> │</ThemedText>
		</Text>
	);
}

function itemKey(item: MarketplaceItem): string {
	return `${item.source}:${item.relativePath ?? item.name}`;
}

function origin(item: MarketplaceItem): string {
	return item.freshness === 'cached' ? 'GitHub' : 'skills.sh';
}

function resultLabel(count: number): string {
	return `${count} ${count === 1 ? 'result' : 'results'}`;
}

export function MarketplaceView({layout, runtime, presentation, windowSize}: MarketplaceViewProps): React.JSX.Element {
	const palette = themePalettes[presentation.theme];
	const detectedWindowSize = useWindowSize();
	const dimensions = windowSize ?? detectedWindowSize;
	const [query, setQuery] = useState('');
	const [inputMode, setInputMode] = useState<'idle' | 'search' | 'repo'>('idle');
	const [items, setItems] = useState<ReadonlyArray<MarketplaceItem>>([]);
	const [repositories, setRepositories] = useState<ReadonlyArray<MarketplaceRepository>>([]);
	const [installedNames, setInstalledNames] = useState<ReadonlySet<string>>(new Set());
	const [repositoryMode, setRepositoryMode] = useState(false);
	const [selected, setSelected] = useState(0);
	const [busy, setBusy] = useState(false);
	const [featuredLoading, setFeaturedLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [catalogMode, setCatalogMode] = useState<'featured' | 'search'>('featured');
	const [featuredPage, setFeaturedPage] = useState(-1);
	const [featuredTotal, setFeaturedTotal] = useState(0);
	const [featuredHasMore, setFeaturedHasMore] = useState(false);
	const [detailState, setDetailState] = useState<DetailState>({kind: 'idle'});
	const catalogRequest = useRef(0);
	const [notice, setNotice] = useState('Press / to search or a to add a public GitHub Skill repository.');
	const selectedItem = repositoryMode ? undefined : items[selected];
	const marketplaceColumns = useMemo(() => columnsFor(dimensions.columns), [dimensions.columns]);
	const visibleRows = Math.max(1, dimensions.rows - 12);
	const rowCount = repositoryMode ? repositories.length : items.length;
	const windowStart = Math.min(
		Math.max(0, selected - Math.floor(visibleRows / 2)),
		Math.max(0, rowCount - visibleRows),
	);
	const windowEnd = Math.min(rowCount, windowStart + visibleRows);

	useEffect(() => {
		let active = true;
		void listSkills(layout).then(result => {
			if (active) setInstalledNames(new Set(result.skills.filter(skill => skill.canonical).map(skill => skill.name)));
		}).catch(() => undefined);
		return () => {
			active = false;
		};
	}, [layout]);

	useEffect(() => {
		const request = ++catalogRequest.current;
		setFeaturedLoading(true);
		void listMarketplaceFeatured(runtime).then(result => {
			if (catalogRequest.current !== request) return;
			setItems(result.items);
			setSelected(0);
			setCatalogMode('featured');
			setFeaturedPage(result.page);
			setFeaturedTotal(result.total);
			setFeaturedHasMore(result.hasMore);
			setNotice(`Loaded ${result.items.length} of ${result.total} popular Skills.`);
		}).catch((error: unknown) => {
			if (catalogRequest.current === request) setNotice(`Popular Skills unavailable: ${errorText(error)}`);
		}).finally(() => {
			if (catalogRequest.current === request) setFeaturedLoading(false);
		});
		return () => {
			if (catalogRequest.current === request) catalogRequest.current += 1;
		};
	}, [runtime]);

	useEffect(() => {
		if (catalogMode !== 'featured' || !featuredHasMore || loadingMore || selected < items.length - 5) return;
		const request = catalogRequest.current;
		const nextPage = featuredPage + 1;
		setLoadingMore(true);
		void listMarketplaceFeatured(runtime, nextPage).then(result => {
			if (catalogRequest.current !== request) return;
			setItems(current => {
				const keys = new Set(current.map(itemKey));
				return [...current, ...result.items.filter(item => !keys.has(itemKey(item)))];
			});
			setFeaturedPage(result.page);
			setFeaturedTotal(result.total);
			setFeaturedHasMore(result.hasMore);
			setNotice(`Loaded ${Math.min(result.total, items.length + result.items.length)} of ${result.total} popular Skills.`);
		}).catch((error: unknown) => {
			if (catalogRequest.current === request) setNotice(`Could not load more popular Skills: ${errorText(error)}`);
		}).finally(() => {
			if (catalogRequest.current === request) setLoadingMore(false);
		});
	}, [catalogMode, featuredHasMore, featuredPage, items.length, loadingMore, runtime, selected]);

	useEffect(() => {
		if (selectedItem === undefined || selectedItem.description !== undefined) {
			setDetailState({kind: 'idle'});
			return;
		}
		let active = true;
		setDetailState({kind: 'loading'});
		void resolveMarketplaceItem(runtime, selectedItem).then(resolved => {
			if (!active) return;
			setItems(current => current.map(item => itemKey(item) === itemKey(selectedItem) ? resolved : item));
			setDetailState({kind: 'idle'});
		}).catch((error: unknown) => {
			if (active) setDetailState({kind: 'error', message: errorText(error)});
		});
		return () => {
			active = false;
		};
	}, [runtime, selectedItem]);

	const loadRepositories = useCallback(async (): Promise<void> => {
		setRepositories(await listMarketplaceRepositories(layout));
	}, [layout]);

	const runSearch = useCallback(async (): Promise<void> => {
		if (query.trim().length === 0) return;
		const request = ++catalogRequest.current;
		setFeaturedLoading(false);
		setLoadingMore(false);
		setCatalogMode('search');
		setFeaturedHasMore(false);
		setBusy(true);
		try {
			const result = await searchMarketplace(layout, runtime, query);
			if (catalogRequest.current !== request) return;
			setItems(result.items);
			setSelected(0);
			setNotice(result.diagnostics.length === 0 ? `${result.items.length} results.` : result.diagnostics.join(' · '));
		} catch (error: unknown) {
			if (catalogRequest.current === request) setNotice(errorText(error));
		} finally {
			if (catalogRequest.current === request) setBusy(false);
		}
	}, [layout, query, runtime]);

	const addRepository = useCallback(async (): Promise<void> => {
		if (query.trim().length === 0) return;
		setBusy(true);
		try {
			const repository = await addMarketplaceRepository(layout, runtime, {source: query});
			setNotice(`Added ${repository.scan.repository.owner}/${repository.scan.repository.repository}: ${repository.scan.skills.length} Skills.`);
			setQuery('');
			await loadRepositories();
		} catch (error: unknown) {
			setNotice(errorText(error));
		} finally {
			setBusy(false);
		}
	}, [layout, loadRepositories, query, runtime]);

	const selectedRepositorySource = useCallback((): string | undefined => {
		const repository = repositories[selected];
		return repository === undefined ? undefined : `${repository.scan.repository.owner}/${repository.scan.repository.repository}`;
	}, [repositories, selected]);

	const toggleRepository = useCallback(async (): Promise<void> => {
		const source = selectedRepositorySource();
		const repository = repositories[selected];
		if (source === undefined || repository === undefined) return;
		setBusy(true);
		try {
			const enabled = !repository.enabled;
			await setMarketplaceRepositoryEnabled(layout, source, enabled);
			await loadRepositories();
			setNotice(`${enabled ? 'Enabled' : 'Disabled'} ${source}.`);
		} catch (error: unknown) {
			setNotice(errorText(error));
		} finally {
			setBusy(false);
		}
	}, [layout, loadRepositories, repositories, selected, selectedRepositorySource]);

	const refreshRepository = useCallback(async (): Promise<void> => {
		const source = selectedRepositorySource();
		if (source === undefined) return;
		setBusy(true);
		try {
			await refreshMarketplaceRepository(layout, runtime, source);
			await loadRepositories();
			setNotice(`Refreshed ${source}.`);
		} catch (error: unknown) {
			setNotice(errorText(error));
		} finally {
			setBusy(false);
		}
	}, [layout, loadRepositories, runtime, selectedRepositorySource]);

	const removeRepository = useCallback(async (): Promise<void> => {
		const source = selectedRepositorySource();
		if (source === undefined) return;
		setBusy(true);
		try {
			await removeMarketplaceRepository(layout, source);
			await loadRepositories();
			setSelected(0);
			setNotice(`Removed ${source}. Installed Skills were not changed.`);
		} catch (error: unknown) {
			setNotice(errorText(error));
		} finally {
			setBusy(false);
		}
	}, [layout, loadRepositories, selectedRepositorySource]);

	const install = useCallback(async (): Promise<void> => {
		const item = items[selected];
		if (item === undefined) return;
		setBusy(true);
		try {
			const result = await installMarketplaceSkill(layout, runtime, item.branch === undefined
				? {source: item.source, skill: item.name}
				: {source: item.source, skill: item.name, branch: item.branch});
			setInstalledNames(current => new Set(current).add(item.name));
			setNotice(`${result.state === 'installed' ? 'Installed' : 'Already installed'} ${item.name}. Providers remain disabled.`);
		} catch (error: unknown) {
			setNotice(errorText(error));
		} finally {
			setBusy(false);
		}
	}, [items, layout, runtime, selected]);

	useInput((input, key) => {
		if (busy) return;
		if (inputMode !== 'idle') {
			if (key.escape) {
				setInputMode('idle');
				setQuery('');
				return;
			}
			if (key.return) {
				const mode = inputMode;
				setInputMode('idle');
				if (mode === 'search') void runSearch();
				else void addRepository();
				return;
			}
			if (key.backspace || key.delete) {
				setQuery(current => Array.from(current).slice(0, -1).join(''));
				return;
			}
			if (input.length > 0 && !key.ctrl && !key.meta) setQuery(current => `${current}${input}`);
			return;
		}
		if (input === 'l') {
			setRepositoryMode(current => !current);
			setSelected(0);
			void loadRepositories();
			return;
		}
		if (input === '/') {
			setQuery('');
			setInputMode('search');
			return;
		}
		if (input === 'a') {
			setQuery('');
			setInputMode('repo');
			return;
		}
		const count = repositoryMode ? repositories.length : items.length;
		if (key.downArrow || input === 'j') setSelected(current => Math.min(Math.max(0, count - 1), current + 1));
		if (key.upArrow || input === 'k') setSelected(current => Math.max(0, current - 1));
		if (repositoryMode && input === ' ') void toggleRepository();
		if (repositoryMode && input === 'r') void refreshRepository();
		if (repositoryMode && input === 'x') void removeRepository();
		if (!repositoryMode && input === 'i') void install();
	});

	const description = selectedItem?.description
		?? (detailState.kind === 'loading'
			? 'Loading description…'
			: detailState.kind === 'error'
				? `Description unavailable: ${detailState.message}`
				: 'Select a marketplace result to inspect it.');

	return (
		<Box flexDirection="column">
			<Box>
				<ThemedText bold color={palette.accent}>{repositoryMode ? 'Repositories' : 'Marketplace'}</ThemedText>
				{!repositoryMode && <ThemedText color={palette.muted}> · {catalogMode === 'featured' ? `${items.length} loaded / ${featuredTotal}` : resultLabel(items.length)}</ThemedText>}
				<Text>  </Text>
				<ThemedText color={palette.muted}>skills.sh + validated GitHub repositories</ThemedText>
			</Box>
			<Text>{inputMode === 'repo' ? 'Repository: ' : 'Search: '}{inputMode === 'idle' ? query || '—' : `${query}█`}</Text>
			{repositoryMode
				? repositories.length === 0
					? <ThemedText color={palette.muted}>No configured repositories.</ThemedText>
					: repositories.slice(windowStart, windowEnd).map((repository, offset) => {
						const index = windowStart + offset;
						const source = `${repository.scan.repository.owner}/${repository.scan.repository.repository}`;
						return (
							<ThemedText key={source} bold={index === selected} color={index === selected ? palette.accent : repository.enabled ? palette.enabled : palette.muted}>
								{index === selected ? '›' : ' '} {source}  {repository.scan.repository.branch}  {repository.scan.skills.length} Skills  {repository.enabled ? 'enabled' : 'disabled'}
							</ThemedText>
						);
					})
				: <>
					<ThemedText color={palette.border} dimColor={palette.border === undefined}>{border(marketplaceColumns, 'top')}</ThemedText>
					<ThemedMarketplaceRow columns={marketplaceColumns} values={Object.fromEntries(marketplaceColumns.map(column => [column.label, column.label]))} palette={palette} header/>
					<ThemedText color={palette.border} dimColor={palette.border === undefined}>{border(marketplaceColumns, 'middle')}</ThemedText>
					{items.length === 0
						? <Text>{tableRow(marketplaceColumns, {Skill: featuredLoading ? 'Loading popular Skills…' : 'No marketplace results.'})}</Text>
						: items.slice(windowStart, windowEnd).map((item, offset) => {
							const index = windowStart + offset;
							return (
								<ThemedMarketplaceRow
									key={itemKey(item)}
									columns={marketplaceColumns}
									values={{
										Skill: `${index === selected ? '› ' : '  '}${item.name}`,
										Source: item.source,
										Origin: origin(item),
										Installs: (item.installs ?? 0).toLocaleString('en-US'),
										Installed: installedNames.has(item.name) ? '● Yes' : '○ No',
									}}
									palette={palette}
									selected={index === selected}
								/>
							);
						})}
					<ThemedText color={palette.border} dimColor={palette.border === undefined}>{border(marketplaceColumns, 'bottom')}</ThemedText>
					<ThemedText bold color={palette.accent}>Description</ThemedText>
					<Text wrap="wrap">{description}</Text>
					{selectedItem !== undefined && <ThemedText color={palette.muted}>Source: {selectedItem.source}</ThemedText>}
					{selectedItem !== undefined && <ThemedText color={palette.muted}>Path: {selectedItem.relativePath ?? 'resolving…'} · Branch: {selectedItem.branch ?? 'resolving…'} · {selectedItem.freshness === 'live' ? 'Live' : 'Cached'}</ThemedText>}
				</>}
			<ThemedText color={palette.muted}>
				{rowCount === 0 ? '0' : `${windowStart + 1}–${windowEnd} / ${rowCount}`}  {repositoryMode ? 'l results  a add  Space toggle  r refresh  x remove' : 'l repositories  / search  a add  i install'}  ↑↓ move
			</ThemedText>
			<ThemedText color={busy || featuredLoading || loadingMore ? palette.warning : palette.muted}>{busy ? 'Working…' : featuredLoading ? 'Loading popular skills.sh Skills…' : loadingMore ? 'Loading more popular Skills…' : notice}</ThemedText>
		</Box>
	);
}

import {useCallback, useState} from 'react';
import {Box, render, Text, useApp, useInput, useWindowSize} from 'ink';
import type {Layout} from '../core/index.js';
import type {MarketplaceRuntime} from '../core/marketplace.js';
import {editHook, type ResourceContext, type ResourceRuntime} from '../core/resources.js';
import {themePalettes, type TerminalPresentation} from '../presentation/theme.js';
import {ThemedText} from './components.js';
import {App, type AppProps} from './SkillsView.js';
import {MarketplaceView} from './MarketplaceView.js';
import {ResourceView, type Section} from './ResourceView.js';

export {App} from './SkillsView.js';
export type {AppProps} from './SkillsView.js';

type ManagedSection = Section | 'marketplace';

export type ManagedAppProps = AppProps & Readonly<{
	resources: Readonly<{context: ResourceContext; runtime: ResourceRuntime; marketplace?: MarketplaceRuntime}>;
	onHookEdit: (id: string) => void;
}>;


export function ManagedApp({layout, presentation, resources, windowSize, onHookEdit}: ManagedAppProps): React.JSX.Element {
	const {exit} = useApp();
	const detectedWindowSize = useWindowSize();
	const dimensions = windowSize ?? detectedWindowSize;
	const palette = themePalettes[presentation.theme];
	const [section, setSection] = useState<ManagedSection>('skills');
	useInput((input, key) => {
		if (key.tab || input === '\t') {
			setSection(current => current === 'skills' ? 'marketplace' : current === 'marketplace' ? 'hooks' : current === 'hooks' ? 'plugins' : current === 'plugins' ? 'mcp' : 'skills');
		}
	});
	const edit = useCallback((id: string): void => {
		onHookEdit(id);
		exit();
	}, [exit, onHookEdit]);
	return (
		<Box flexDirection="column">
		<Box><ThemedText bold color={section === 'skills' ? palette.accent : palette.muted}>Skills</ThemedText><Text>  </Text><ThemedText bold color={section === 'marketplace' ? palette.accent : palette.muted}>Marketplace</ThemedText><Text>  </Text><ThemedText bold color={section === 'hooks' ? palette.accent : palette.muted}>Hooks</ThemedText><Text>  </Text><ThemedText bold color={section === 'plugins' ? palette.accent : palette.muted}>Plugins</ThemedText><Text>  </Text><ThemedText bold color={section === 'mcp' ? palette.accent : palette.muted}>MCP</ThemedText><ThemedText color={palette.muted}>  ·  Tab switch</ThemedText></Box>
		{section === 'skills'
			? <App layout={layout} marketplace={resources.marketplace} presentation={presentation} windowSize={{columns: dimensions.columns, rows: Math.max(1, dimensions.rows - 1)}}/>
			: section === 'marketplace'
				? resources.marketplace === undefined
					? <ThemedText color={palette.error}>Marketplace runtime is unavailable.</ThemedText>
					: <MarketplaceView layout={layout} runtime={resources.marketplace} presentation={presentation}/>
				: <ResourceView key={section} section={section} resources={resources} presentation={presentation} windowSize={{columns: dimensions.columns, rows: Math.max(1, dimensions.rows - 1)}} onHookEdit={edit}/>}
		</Box>
	);
}

export async function runTui(
	layout: Layout,
	presentation: TerminalPresentation,
	resources: ManagedAppProps['resources'],
): Promise<void> {
	let hookId: string | undefined;
	const instance = render(
		<ManagedApp layout={layout} presentation={presentation} resources={resources} onHookEdit={id => {
			hookId = id;
		}}/>,
		{alternateScreen: true},
	);
	await instance.waitUntilExit();
	if (hookId !== undefined) {
		await editHook(resources.context, resources.runtime, hookId);
	}
}

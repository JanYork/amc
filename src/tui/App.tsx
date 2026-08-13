import {useState} from 'react';
import {Box, render, Text, useInput, useWindowSize} from 'ink';
import type {Layout} from '../core/index.js';
import type {MarketplaceRuntime} from '../core/marketplace.js';
import type {ResourceContext, ResourceRuntime} from '../core/resources.js';
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
}>;


export function ManagedApp({layout, presentation, resources, windowSize}: ManagedAppProps): React.JSX.Element {
	const detectedWindowSize = useWindowSize();
	const dimensions = windowSize ?? detectedWindowSize;
	const palette = themePalettes[presentation.theme];
	const [section, setSection] = useState<ManagedSection>('skills');
	useInput((input, key) => {
		if (key.tab || input === '\t') {
			setSection(current => current === 'skills' ? 'marketplace' : current === 'marketplace' ? 'hooks' : current === 'hooks' ? 'plugins' : current === 'plugins' ? 'mcp' : 'skills');
		}
	});
	return (
		<Box flexDirection="column">
		<Box><ThemedText bold color={section === 'skills' ? palette.accent : palette.muted}>Skills</ThemedText><Text>  </Text><ThemedText bold color={section === 'marketplace' ? palette.accent : palette.muted}>Marketplace</ThemedText><Text>  </Text><ThemedText bold color={section === 'hooks' ? palette.accent : palette.muted}>Hooks</ThemedText><Text>  </Text><ThemedText bold color={section === 'plugins' ? palette.accent : palette.muted}>Plugins</ThemedText><Text>  </Text><ThemedText bold color={section === 'mcp' ? palette.accent : palette.muted}>MCP</ThemedText><ThemedText color={palette.muted}>  ·  Tab switch</ThemedText></Box>
		{section === 'skills'
			? <App layout={layout} marketplace={resources.marketplace} presentation={presentation} windowSize={{columns: dimensions.columns, rows: Math.max(1, dimensions.rows - 1)}}/>
			: section === 'marketplace'
				? resources.marketplace === undefined
					? <ThemedText color={palette.error}>Marketplace runtime is unavailable.</ThemedText>
					: <MarketplaceView layout={layout} runtime={resources.marketplace} presentation={presentation}/>
				: <ResourceView key={section} section={section} resources={resources} presentation={presentation} windowSize={{columns: dimensions.columns, rows: Math.max(1, dimensions.rows - 1)}}/>}
		</Box>
	);
}

export async function runTui(
	layout: Layout,
	presentation: TerminalPresentation,
	resources: ManagedAppProps['resources'],
): Promise<void> {
	const instance = render(
		<ManagedApp layout={layout} presentation={presentation} resources={resources}/>,
		{alternateScreen: true},
	);
	await instance.waitUntilExit();
}

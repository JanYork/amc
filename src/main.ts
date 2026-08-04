#!/usr/bin/env node
import {homedir} from 'node:os';
import {executeCommand, helpText, parseCommand, UsageError} from './cli/index.js';
import {AmcError, createLayout, type Layout} from './core/index.js';
import {createResourceRuntime} from './runtime.js';
import {
	resolveTerminalPresentation,
	type ColorDepth,
	type TerminalPresentation,
} from './presentation/theme.js';

type TuiModule = Readonly<{
	runTui: (
		layout: Layout,
		presentation: TerminalPresentation,
		resources: Readonly<{context: Readonly<{home: string; cwd: string}>; runtime: ReturnType<typeof createResourceRuntime>}>,
	) => Promise<void>;
}>;

function isTuiModule(value: unknown): value is TuiModule {
	return typeof value === 'object'
		&& value !== null
		&& 'runTui' in value
		&& typeof value.runTui === 'function';
}

async function loadTui(
	layout: Layout,
	presentation: TerminalPresentation,
	resources: Readonly<{context: Readonly<{home: string; cwd: string}>; runtime: ReturnType<typeof createResourceRuntime>}>,
): Promise<void> {
	const modulePath = new URL('./tui/App.js', import.meta.url).href;
	const loaded: unknown = await import(modulePath);
	if (!isTuiModule(loaded)) {
		throw new Error('AMC TUI module is invalid.');
	}
	await loaded.runTui(layout, presentation, resources);
}

async function main(): Promise<void> {
	try {
		const command = parseCommand(process.argv.slice(2));
		const reportedColorDepth = process.stdout.isTTY === true
			? process.stdout.getColorDepth()
			: 1;
		const colorDepth: ColorDepth = reportedColorDepth === 24
			? 24
			: reportedColorDepth === 8 ? 8 : reportedColorDepth === 4 ? 4 : 1;
		const presentation = resolveTerminalPresentation({
			amcTheme: process.env['AMC_THEME'],
			colorFgBg: process.env['COLORFGBG'],
			noColor: process.env['NO_COLOR'] !== undefined,
			isTTY: process.stdout.isTTY === true,
			colorDepth,
		});
		const layout = createLayout(homedir());
		const resources = {
			context: {home: layout.home, cwd: process.cwd()},
			runtime: createResourceRuntime(process.env),
		};
		if (command.kind === 'tui') {
			if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
				throw new Error('AMC TUI requires an interactive terminal.');
			}
			await loadTui(layout, presentation, resources);
			return;
		}

		process.stdout.write(`${await executeCommand(layout, command, {
			isTTY: process.stdout.isTTY === true,
			columns: process.stdout.columns === undefined || process.stdout.columns < 1
				? 80
				: process.stdout.columns,
			presentation,
		}, resources)}\n`);
	} catch (error: unknown) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n\n${helpText}\n`);
			process.exitCode = error.exitCode;
			return;
		}
		if (error instanceof AmcError) {
			process.stderr.write(`${error.code}: ${error.message}\nPath: ${error.path}\n`);
			process.exitCode = 1;
			return;
		}
		process.stderr.write(`${error instanceof Error ? error.message : 'Unexpected AMC failure.'}\n`);
		process.exitCode = 1;
	}
}

await main();

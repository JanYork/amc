import assert from 'node:assert/strict';
import test from 'node:test';
import {
	resolveTerminalPresentation,
	themePalettes,
	type ThemeEnvironment,
} from '../src/presentation/theme.js';

function environment(overrides: Partial<ThemeEnvironment> = {}): ThemeEnvironment {
	return {
		amcTheme: undefined,
		colorFgBg: undefined,
		noColor: false,
		isTTY: true,
		colorDepth: 24,
		...overrides,
	};
}

test('theme resolver rejects an invalid explicit override before fallbacks', () => {
	assert.throws(
		() => resolveTerminalPresentation(environment({
			amcTheme: 'dakr',
			isTTY: false,
			noColor: true,
		})),
		{message: 'AMC_THEME must be dark, light, or mono'},
	);
});

test('theme resolver applies terminal and explicit override precedence', () => {
	assert.equal(resolveTerminalPresentation(environment({isTTY: false})).theme, 'mono');
	assert.equal(resolveTerminalPresentation(environment({noColor: true})).theme, 'mono');
	assert.equal(resolveTerminalPresentation(environment({colorDepth: 1})).theme, 'mono');
	assert.equal(resolveTerminalPresentation(environment({amcTheme: 'light'})).theme, 'light');
	assert.equal(resolveTerminalPresentation(environment({amcTheme: 'dark'})).theme, 'dark');
	assert.equal(resolveTerminalPresentation(environment({amcTheme: 'mono'})).theme, 'mono');
});

test('theme resolver detects known COLORFGBG backgrounds and defaults to dark', () => {
	assert.equal(resolveTerminalPresentation(environment({colorFgBg: '15;0'})).theme, 'dark');
	assert.equal(resolveTerminalPresentation(environment({colorFgBg: '0;8'})).theme, 'dark');
	assert.equal(resolveTerminalPresentation(environment({colorFgBg: '0;7'})).theme, 'light');
	assert.equal(resolveTerminalPresentation(environment({colorFgBg: '0;15'})).theme, 'light');
	assert.equal(resolveTerminalPresentation(environment({colorFgBg: 'invalid'})).theme, 'dark');
	assert.equal(resolveTerminalPresentation(environment({colorFgBg: '0;12'})).theme, 'dark');
});

test('theme resolver preserves supported color depth and exposes approved palettes', () => {
	assert.deepEqual(resolveTerminalPresentation(environment({colorDepth: 8})), {
		theme: 'dark',
		colorDepth: 8,
	});
	assert.equal(themePalettes.dark.accent, '#cc785c');
	assert.equal(themePalettes.light.accent, '#a9583e');
	assert.equal(themePalettes.dark.enabled, '#5db872');
	assert.equal(themePalettes.light.enabled, '#2f7d46');
	assert.equal(themePalettes.mono.accent, undefined);
});

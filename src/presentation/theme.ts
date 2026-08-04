export type ThemeName = 'dark' | 'light' | 'mono';
export type ColorDepth = 1 | 4 | 8 | 24;

export type ThemeEnvironment = Readonly<{
	amcTheme: string | undefined;
	colorFgBg: string | undefined;
	noColor: boolean;
	isTTY: boolean;
	colorDepth: ColorDepth;
}>;

export type TerminalPresentation = Readonly<{
	theme: ThemeName;
	colorDepth: ColorDepth;
}>;

export type ThemePalette = Readonly<{
	accent: string | undefined;
	muted: string | undefined;
	border: string | undefined;
	enabled: string | undefined;
	warning: string | undefined;
	error: string | undefined;
}>;

export const themePalettes: Readonly<Record<ThemeName, ThemePalette>> = {
	dark: {
		accent: '#cc785c',
		muted: '#a09d96',
		border: '#55524e',
		enabled: '#5db872',
		warning: '#e8a55a',
		error: '#e06b6b',
	},
	light: {
		accent: '#a9583e',
		muted: '#6c6a64',
		border: '#aaa69e',
		enabled: '#2f7d46',
		warning: '#926400',
		error: '#b53636',
	},
	mono: {
		accent: undefined,
		muted: undefined,
		border: undefined,
		enabled: undefined,
		warning: undefined,
		error: undefined,
	},
};

function explicitTheme(value: string | undefined): ThemeName | undefined {
	switch (value) {
		case undefined:
			return undefined;
		case 'dark':
		case 'light':
		case 'mono':
			return value;
		default:
			throw new Error('AMC_THEME must be dark, light, or mono');
	}
}

function backgroundTheme(value: string | undefined): ThemeName {
	const background = value?.split(';').at(-1);
	switch (background) {
		case '7':
		case '15':
			return 'light';
		case '0':
		case '8':
		default:
			return 'dark';
	}
}

export function resolveTerminalPresentation(environment: ThemeEnvironment): TerminalPresentation {
	const requestedTheme = explicitTheme(environment.amcTheme);
	const theme = !environment.isTTY || environment.noColor || environment.colorDepth === 1
		? 'mono'
		: requestedTheme ?? backgroundTheme(environment.colorFgBg);
	return {theme, colorDepth: environment.colorDepth};
}

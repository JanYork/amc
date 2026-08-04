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

export type ColorRole = keyof ThemePalette;

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

function basicAnsiCode(role: ColorRole): string {
	switch (role) {
		case 'accent':
		case 'error':
			return '31';
		case 'enabled':
			return '32';
		case 'warning':
			return '33';
		case 'muted':
		case 'border':
			return '90';
	}
}

export function ansiCodeForRole(
	presentation: TerminalPresentation,
	role: ColorRole,
): string | undefined {
	if (presentation.theme === 'mono') {
		return role === 'accent'
			? '1'
			: role === 'muted' || role === 'border' ? '2' : undefined;
	}
	if (presentation.colorDepth !== 24) {
		return basicAnsiCode(role);
	}

	const color = themePalettes[presentation.theme][role];
	if (color === undefined) {
		return undefined;
	}
	const red = Number.parseInt(color.slice(1, 3), 16);
	const green = Number.parseInt(color.slice(3, 5), 16);
	const blue = Number.parseInt(color.slice(5, 7), 16);
	return `38;2;${red};${green};${blue}`;
}

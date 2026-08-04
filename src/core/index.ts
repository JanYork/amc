import {join} from 'node:path';

export type Target = 'claude' | 'pi' | 'codex';

export type AmcPaths = Readonly<{
	root: string;
	skills: string;
	backups: string;
	disabledLinks: string;
	staging: string;
	failed: string;
}>;

export type TargetPaths = Readonly<Record<Target, string>>;

export type Layout = Readonly<{
	home: string;
	amc: AmcPaths;
	targets: TargetPaths;
}>;

export const targets: ReadonlyArray<Target> = ['claude', 'pi', 'codex'];

export function createLayout(home: string): Layout {
	const root = join(home, '.amc');

	return {
		home,
		amc: {
			root,
			skills: join(root, 'skills'),
			backups: join(root, 'backups'),
			disabledLinks: join(root, 'disabled-links'),
			staging: join(root, 'staging'),
			failed: join(root, 'failed'),
		},
		targets: {
			claude: join(home, '.claude', 'skills'),
			pi: join(home, '.pi', 'agent', 'skills'),
			codex: join(home, '.codex', 'skills'),
		},
	};
}

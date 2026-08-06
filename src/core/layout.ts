import {join} from 'node:path';
import {type Layout, type Target} from './model.js';

export const targets: ReadonlyArray<Target> = ['claude', 'pi', 'codex'];

export function createLayout(home: string): Layout {
	const root = join(home, '.amc');
	const claude = join(home, '.claude', 'skills');
	const pi = join(home, '.pi', 'agent', 'skills');
	const codex = join(home, '.codex', 'skills');

	return {
		home,
		amc: {
			root,
			skills: join(root, 'skills'),
			backups: join(root, 'backups'),
			disabledLinks: join(root, 'disabled-links'),
			staging: join(root, 'staging'),
			failed: join(root, 'failed'),
			marketplace: join(root, 'marketplace.json'),
			skillsLock: join(root, 'skills-lock.json'),
			deleteJournals: join(root, 'delete-journals'),
			reconcileJournals: join(root, 'reconcile-journals'),
			credentials: join(root, 'credentials'),
			githubAuth: join(root, 'github-auth.json'),
			githubToken: join(root, 'credentials', 'github-token'),
		},
		targets: {claude, pi, codex},
		sources: {
			agents: join(home, '.agents', 'skills'),
			agent: join(home, '.agent', 'skills'),
			claude,
			pi,
			codex,
		},
	};
}


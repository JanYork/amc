import {parseArgs} from 'node:util';
import type {ReconcileChoice, Target} from '../core/model.js';
import type {TerminalPresentation} from '../presentation/theme.js';

export type MarketplaceSource = 'skills.sh' | 'github';

export type Command =
	| Readonly<{kind: 'tui'}>
	| Readonly<{kind: 'help'}>
	| Readonly<{kind: 'version'}>
	| Readonly<{
		kind: 'list';
		page: number;
		limit: number;
		all: boolean;
		search: string | undefined;
		diagnostics: boolean;
	}>
	| Readonly<{kind: 'enable'; name: string; target: Target | undefined}>
	| Readonly<{kind: 'disable'; name: string; target: Target | undefined}>
	| Readonly<{kind: 'migrate'; name: string; source: Target | undefined}>
	| Readonly<{kind: 'migrate-all'; apply: boolean}>
	| Readonly<{kind: 'reconcile'; apply: boolean; name: string | undefined; source: ReconcileChoice | undefined}>
	| Readonly<{kind: 'github-auth-login' | 'github-auth-token' | 'github-auth-status'}>
	| Readonly<{kind: 'updates-check'; name: string | undefined}>
	| Readonly<{kind: 'marketplace-search'; query: string; source: MarketplaceSource | undefined}>
	| Readonly<{kind: 'repos-list'}>
	| Readonly<{kind: 'repos-add'; source: string; branch: string | undefined}>
	| Readonly<{kind: 'repos-refresh'; source: string}>
	| Readonly<{kind: 'repos-remove'; source: string}>
	| Readonly<{kind: 'repos-enable' | 'repos-disable'; source: string}>
	| Readonly<{kind: 'install'; source: string; skill: string; branch: string | undefined}>
	| Readonly<{kind: 'upgrade'; name: string}>
	| Readonly<{kind: 'delete'; name: string; confirmation: string}>
	| Readonly<{kind: 'plugins-list'; page: number; limit: number; all: boolean; search: string | undefined}>
	| Readonly<{kind: 'plugin-enable'; id: string}>
	| Readonly<{kind: 'plugin-disable'; id: string}>
	| Readonly<{kind: 'hooks-list'; page: number; limit: number; all: boolean; search: string | undefined}>
	| Readonly<{kind: 'hook-edit'; id: string}>
	| Readonly<{kind: 'hook-enable'; id: string}>
	| Readonly<{kind: 'hook-disable'; id: string}>
	| Readonly<{kind: 'mcp-list'; page: number; limit: number; all: boolean; search: string | undefined}>
	| Readonly<{kind: 'mcp-enable'; id: string}>
	| Readonly<{kind: 'mcp-disable'; id: string}>;

export type HeadlessCommand = Exclude<Command, {kind: 'tui'}>;

export type OutputContext = Readonly<{
	isTTY: boolean;
	columns: number;
	presentation: TerminalPresentation;
}>;


export class UsageError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

export function usage(message: string): never {
	throw new UsageError(message);
}

function parseMarketplaceSource(value: string | undefined): MarketplaceSource | undefined {
	if (value === undefined) return undefined;
	if (value === 'skills.sh' || value === 'github') return value;
	return usage('--source must be skills.sh or github');
}

function parseReconcileChoice(value: string | undefined): ReconcileChoice | undefined {
	if (value === undefined) return undefined;
	switch (value) {
		case 'agents':
		case 'agent':
		case 'claude':
		case 'pi':
		case 'codex':
		case 'canonical':
			return value;
		default:
			return usage('--source must be agents, agent, claude, pi, codex, or canonical');
	}
}

function validateRepositorySource(value: string | undefined): string {
	if (value === undefined || value.trim().length === 0 || value.includes('\0')) return usage('Repository source must not be empty');
	return value;
}

function parseTarget(value: string | undefined, option: string): Target | undefined {
	if (value === undefined) {
		return undefined;
	}

	switch (value) {
		case 'claude':
		case 'pi':
		case 'codex': {
			return value;
		}

		default: {
			return usage(`${option} must be claude, pi, or codex`);
		}
	}
}

function validateName(value: string | undefined): string {
	if (
		value === undefined
		|| value.length === 0
		|| value === '.'
		|| value === '..'
		|| value === '__proto__'
		|| value === 'constructor'
		|| value.includes('/')
		|| value.includes('\\')
		|| value.trim() !== value
		|| /[\u0000-\u001f\u007f]/u.test(value)
	) {
		return usage('Skill name must be one safe path segment');
	}

	return value;
}

function validateHookId(value: string | undefined): string {
	if (value === undefined || !/^[a-f0-9]{16}$/u.test(value)) {
		return usage('Hook id must be the 16-character id shown by amc hooks list');
	}
	return value;
}

function requirePositionals(positionals: ReadonlyArray<string>, count: number): void {
	if (positionals.length !== count) {
		usage('Invalid command arguments');
	}
}

function parsePositiveInteger(value: string | undefined, option: string, maximum?: number): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!/^[1-9]\d*$/u.test(value)) {
		return usage(`${option} must be a positive integer`);
	}

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || (maximum !== undefined && parsed > maximum)) {
		return usage(maximum === undefined
			? `${option} must be a safe positive integer`
			: `${option} must be between 1 and ${maximum}`);
	}

	return parsed;
}

export function parseCommand(arguments_: ReadonlyArray<string>): Command {
	try {
		const {positionals, values} = parseArgs({
			args: [...arguments_],
			allowPositionals: true,
			strict: true,
			options: {
				help: {type: 'boolean', short: 'h'},
				version: {type: 'boolean', short: 'v'},
				target: {type: 'string'},
				source: {type: 'string'},
				page: {type: 'string'},
				limit: {type: 'string'},
				search: {type: 'string'},
				all: {type: 'boolean'},
				diagnostics: {type: 'boolean'},
				yes: {type: 'boolean'},
				branch: {type: 'string'},
				skill: {type: 'string'},
				confirm: {type: 'string'},
				apply: {type: 'boolean'},
				'token-stdin': {type: 'boolean'},
			},
		});

		const hasTarget = values.target !== undefined;
		const hasSource = values.source !== undefined;
		const wantsHelp = values.help === true;
		const wantsVersion = values.version === true;
		const hasPage = values.page !== undefined;
		const hasLimit = values.limit !== undefined;
		const hasSearch = values.search !== undefined;
		const wantsAll = values.all === true;
		const wantsDiagnostics = values.diagnostics === true;
		const wantsYes = values.yes === true;
		const hasBranch = values.branch !== undefined;
		const hasSkill = values.skill !== undefined;
		const hasConfirm = values.confirm !== undefined;
		const wantsApply = values.apply === true;
		const wantsTokenStdin = values['token-stdin'] === true;
		const hasListOption = hasPage || hasLimit || hasSearch || wantsDiagnostics;
		const hasMarketplaceOption = hasBranch || hasSkill || hasConfirm;

		if (wantsHelp || wantsVersion) {
			if (
				positionals.length > 0
				|| hasTarget
				|| hasSource
				|| hasListOption
				|| wantsAll
				|| wantsYes
				|| hasMarketplaceOption
				|| wantsApply
				|| wantsTokenStdin
				|| (wantsHelp && wantsVersion)
			) {
				return usage('Help and version flags must be used alone');
			}

			return wantsHelp ? {kind: 'help'} : {kind: 'version'};
		}

		if (positionals.length === 0) {
			if (hasTarget || hasSource || hasListOption || wantsAll || wantsYes || hasMarketplaceOption || wantsApply || wantsTokenStdin) {
				return usage('Options require a command');
			}

			return {kind: 'tui'};
		}

		const kind = positionals[0];
		if (kind !== 'reconcile' && wantsApply) return usage('--apply is only valid with reconcile');
		if (kind !== 'auth' && wantsTokenStdin) return usage('--token-stdin is only valid with auth github set');
		switch (kind) {
			case 'updates': {
				if (positionals[1] !== 'check' || positionals.length > 3) return usage('Invalid updates command');
				if (hasTarget || hasSource || hasListOption || wantsAll || wantsYes || hasMarketplaceOption) return usage('updates check accepts no options');
				return {kind: 'updates-check', name: positionals[2] === undefined ? undefined : validateName(positionals[2])};
			}
			case 'auth': {
				const provider = positionals[1];
				const action = positionals[2];
				if (provider !== 'github' || (action !== 'login' && action !== 'set' && action !== 'status')) return usage('Invalid auth command');
				requirePositionals(positionals, 3);
				if (hasTarget || hasSource || hasListOption || wantsAll || wantsYes || hasMarketplaceOption) return usage('auth github options are invalid');
				if (action === 'set' && !wantsTokenStdin) return usage('auth github set requires --token-stdin');
				if (action !== 'set' && wantsTokenStdin) return usage('--token-stdin is only valid with auth github set');
				return {kind: action === 'login' ? 'github-auth-login' : action === 'set' ? 'github-auth-token' : 'github-auth-status'};
			}
			case 'reconcile': {
				if (hasTarget || hasListOption || wantsAll || hasMarketplaceOption) return usage('reconcile options are invalid');
				if (!wantsApply) {
					requirePositionals(positionals, 1);
					if (wantsYes || hasSource) return usage('reconcile preview accepts no options');
					return {kind: 'reconcile', apply: false, name: undefined, source: undefined};
				}
				if (!wantsYes) return usage('reconcile --apply requires --yes');
				if (positionals.length === 1) {
					if (hasSource) return usage('bulk reconcile does not accept --source');
					return {kind: 'reconcile', apply: true, name: undefined, source: undefined};
				}
				requirePositionals(positionals, 2);
				if (!hasSource) return usage('single Skill reconcile requires --source');
				return {
					kind: 'reconcile',
					apply: true,
					name: validateName(positionals[1]),
					source: parseReconcileChoice(values.source),
				};
			}
			case 'search': {
				requirePositionals(positionals, 2);
				if (hasTarget || hasListOption || wantsAll || wantsYes || hasMarketplaceOption) return usage('search accepts only --source');
				if ((positionals[1] ?? '').trim().length === 0) return usage('Search query must not be empty');
				return {kind: 'marketplace-search', query: positionals[1] ?? '', source: parseMarketplaceSource(values.source)};
			}
			case 'repos': {
				const action = positionals[1];
				if (hasTarget || hasListOption || wantsAll || wantsYes || hasSkill || hasConfirm || hasSource) return usage('repos command options are invalid');
				if (action === 'list') {
					requirePositionals(positionals, 2);
					if (hasBranch) return usage('repos list accepts no options');
					return {kind: 'repos-list'};
				}
				if (action === 'add') {
					requirePositionals(positionals, 3);
					return {kind: 'repos-add', source: validateRepositorySource(positionals[2]), branch: values.branch};
				}
				if (hasBranch) return usage(`repos ${action ?? ''} accepts no options`);
				if (action === 'refresh' || action === 'remove' || action === 'enable' || action === 'disable') {
					requirePositionals(positionals, 3);
					const source = validateRepositorySource(positionals[2]);
					return {kind: action === 'refresh' ? 'repos-refresh' : action === 'remove' ? 'repos-remove' : action === 'enable' ? 'repos-enable' : 'repos-disable', source};
				}
				return usage('Invalid repos command');
			}
			case 'install': {
				requirePositionals(positionals, 2);
				if (hasTarget || hasSource || hasListOption || wantsAll || wantsYes || hasConfirm || !hasSkill) return usage('install requires --skill and accepts optional --branch');
				return {kind: 'install', source: validateRepositorySource(positionals[1]), skill: validateName(values.skill), branch: values.branch};
			}
			case 'upgrade': {
				requirePositionals(positionals, 2);
				if (hasTarget || hasSource || hasListOption || wantsAll || wantsYes || hasMarketplaceOption) return usage('upgrade accepts no options');
				return {kind: 'upgrade', name: validateName(positionals[1])};
			}
			case 'delete': {
				requirePositionals(positionals, 2);
				const name = validateName(positionals[1]);
				if (hasTarget || hasSource || hasListOption || wantsAll || hasBranch || hasSkill || !wantsYes || !hasConfirm || values.confirm !== name) {
					return usage('delete requires --yes and --confirm with the exact Skill name');
				}
				return {kind: 'delete', name, confirmation: values.confirm};
			}
			case 'plugins':
			case 'hooks':
			case 'mcp': {
				const action = positionals[1];
				if (hasTarget || hasSource || wantsDiagnostics || wantsYes || hasMarketplaceOption) {
					return usage(`${kind} does not accept target, source, diagnostics, or yes options`);
				}
				if (action === 'list') {
					requirePositionals(positionals, 2);
					if (wantsAll && (hasPage || hasLimit)) {
						return usage(`${kind} list --all does not accept --page or --limit`);
					}
					if (values.search !== undefined && values.search.length === 0) {
						return usage(`${kind} list --search must not be empty`);
					}
					return {
						kind: kind === 'plugins' ? 'plugins-list' : kind === 'hooks' ? 'hooks-list' : 'mcp-list',
						page: parsePositiveInteger(values.page, '--page') ?? 1,
						limit: parsePositiveInteger(values.limit, '--limit', 100) ?? 20,
						all: wantsAll,
						search: values.search,
					};
				}
				if (hasListOption || wantsAll) {
					return usage(`${kind} ${action ?? ''} does not accept list options`);
				}
				if (kind === 'plugins' && (action === 'enable' || action === 'disable')) {
					requirePositionals(positionals, 3);
					return {kind: action === 'enable' ? 'plugin-enable' : 'plugin-disable', id: validateName(positionals[2])};
				}
				if (kind === 'mcp' && (action === 'enable' || action === 'disable')) {
					requirePositionals(positionals, 3);
					return {kind: action === 'enable' ? 'mcp-enable' : 'mcp-disable', id: validateName(positionals[2])};
				}
				if (kind === 'hooks' && action === 'edit') {
					requirePositionals(positionals, 3);
					return {kind: 'hook-edit', id: validateHookId(positionals[2])};
				}
				if (kind === 'hooks' && (action === 'enable' || action === 'disable')) {
					requirePositionals(positionals, 3);
					return {kind: action === 'enable' ? 'hook-enable' : 'hook-disable', id: validateHookId(positionals[2])};
				}
				return usage(`Invalid ${kind} command`);
			}

			case 'list': {
				requirePositionals(positionals, 1);
				if (hasTarget || hasSource || wantsYes || hasMarketplaceOption) {
					return usage('list does not accept target or source options');
				}
				if (wantsAll && (hasPage || hasLimit)) {
					return usage('list --all does not accept --page or --limit');
				}
				if (values.search !== undefined && values.search.length === 0) {
					return usage('list --search must not be empty');
				}

				return {
					kind: 'list',
					page: parsePositiveInteger(values.page, '--page') ?? 1,
					limit: parsePositiveInteger(values.limit, '--limit', 100) ?? 20,
					all: wantsAll,
					search: values.search,
					diagnostics: wantsDiagnostics,
				};
			}

			case 'enable':
			case 'disable': {
				requirePositionals(positionals, 2);
				if (hasSource || hasListOption || wantsAll || wantsYes || hasMarketplaceOption) {
					return usage(`${kind} accepts only --target`);
				}

				return {
					kind,
					name: validateName(positionals[1]),
					target: parseTarget(values.target, '--target'),
				};
			}

			case 'migrate': {
				if (wantsAll) {
					requirePositionals(positionals, 1);
					if (hasTarget || hasSource || hasListOption || hasMarketplaceOption) {
						return usage('migrate --all accepts only --yes');
					}
					return {kind: 'migrate-all', apply: wantsYes};
				}
				requirePositionals(positionals, 2);
				if (hasTarget || hasListOption || wantsYes || hasMarketplaceOption) {
					return usage('migrate accepts only --source');
				}

				return {
					kind,
					name: validateName(positionals[1]),
					source: parseTarget(values.source, '--source'),
				};
			}

			default: {
				return usage(`Unknown command: ${kind}`);
			}
		}
	} catch (error: unknown) {
		if (error instanceof UsageError) {
			throw error;
		}

		throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments');
	}
}


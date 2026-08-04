import {parseArgs} from 'node:util';
import type {Target} from '../core/index.js';

export type Command =
	| Readonly<{kind: 'tui'}>
	| Readonly<{kind: 'help'}>
	| Readonly<{kind: 'version'}>
	| Readonly<{kind: 'list'}>
	| Readonly<{kind: 'enable'; name: string; target: Target | undefined}>
	| Readonly<{kind: 'disable'; name: string; target: Target | undefined}>
	| Readonly<{kind: 'migrate'; name: string; source: Target | undefined}>;

export class UsageError extends Error {
	readonly exitCode = 2;

	constructor(message: string) {
		super(message);
		this.name = 'UsageError';
	}
}

function usage(message: string): never {
	throw new UsageError(message);
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
		|| value.includes('/')
		|| value.includes('\\')
		|| value.includes('\0')
	) {
		return usage('Skill name must be one safe path segment');
	}

	return value;
}

function requirePositionals(positionals: ReadonlyArray<string>, count: number): void {
	if (positionals.length !== count) {
		usage('Invalid command arguments');
	}
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
			},
		});

		const hasTarget = values.target !== undefined;
		const hasSource = values.source !== undefined;
		const wantsHelp = values.help === true;
		const wantsVersion = values.version === true;

		if (wantsHelp || wantsVersion) {
			if (positionals.length > 0 || hasTarget || hasSource || (wantsHelp && wantsVersion)) {
				return usage('Help and version flags must be used alone');
			}

			return wantsHelp ? {kind: 'help'} : {kind: 'version'};
		}

		if (positionals.length === 0) {
			if (hasTarget || hasSource) {
				return usage('Options require a command');
			}

			return {kind: 'tui'};
		}

		const kind = positionals[0];
		switch (kind) {
			case 'list': {
				requirePositionals(positionals, 1);
				if (hasTarget || hasSource) {
					return usage('list does not accept target or source options');
				}

				return {kind: 'list'};
			}

			case 'enable':
			case 'disable': {
				requirePositionals(positionals, 2);
				if (hasSource) {
					return usage(`${kind} does not accept --source`);
				}

				return {
					kind,
					name: validateName(positionals[1]),
					target: parseTarget(values.target, '--target'),
				};
			}

			case 'migrate': {
				requirePositionals(positionals, 2);
				if (hasTarget) {
					return usage('migrate does not accept --target');
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

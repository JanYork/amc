import {parseArgs} from 'node:util';
import {
	AmcError,
	executeBulkMigration,
	executeMigration,
	listSkills,
	planBulkMigration,
	planMigration,
	setSkillEnabled,
	type Diagnostic,
	type BulkMigrationPlan,
	type BulkMigrationResult,
	type BulkMigrationStatus,
	type Layout,
	type MigrationResult,
	type ScanResult,
	type Skill,
	type Target,
	type TargetState,
	type ToggleResult,
} from '../core/index.js';

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
	| Readonly<{kind: 'migrate-all'; apply: boolean}>;

export type HeadlessCommand = Exclude<Command, {kind: 'tui'}>;

export type OutputContext = Readonly<{
	isTTY: boolean;
	columns: number;
}>;

export const version = '0.1.0';

export const helpText = `AMC — Agent Management CLI

Usage:
  amc
  amc list [--page <n>] [--limit <1-100>] [--search <text>]
  amc list --all [--search <text>]
  amc list --diagnostics [--page <n>] [--limit <1-100>] [--all]
  amc enable <skill> [--target claude|pi|codex]
  amc disable <skill> [--target claude|pi|codex]
  amc migrate <skill> [--source claude|pi|codex]
  amc migrate --all [--yes]
  amc --help
  amc --version`;

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
		const hasListOption = hasPage || hasLimit || hasSearch || wantsDiagnostics;

		if (wantsHelp || wantsVersion) {
			if (
				positionals.length > 0
				|| hasTarget
				|| hasSource
				|| hasListOption
				|| wantsAll
				|| wantsYes
				|| (wantsHelp && wantsVersion)
			) {
				return usage('Help and version flags must be used alone');
			}

			return wantsHelp ? {kind: 'help'} : {kind: 'version'};
		}

		if (positionals.length === 0) {
			if (hasTarget || hasSource || hasListOption || wantsAll || wantsYes) {
				return usage('Options require a command');
			}

			return {kind: 'tui'};
		}

		const kind = positionals[0];
		switch (kind) {
			case 'list': {
				requirePositionals(positionals, 1);
				if (hasTarget || hasSource || wantsYes) {
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
				if (hasSource || hasListOption || wantsAll || wantsYes) {
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
					if (hasTarget || hasSource || hasListOption) {
						return usage('migrate --all accepts only --yes');
					}
					return {kind: 'migrate-all', apply: wantsYes};
				}
				requirePositionals(positionals, 2);
				if (hasTarget || hasListOption || wantsYes) {
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

function formatToggle(result: ToggleResult, enabled: boolean): string {
	const action = enabled ? 'Enabled' : 'Disabled';
	const changes = result.changes
		.map(change => `${change.target}=${change.changed ? 'changed' : 'no-op'}`)
		.join(' ');
	return `${action} ${result.name}: ${changes}`;
}

function formatMigration(result: MigrationResult): string {
	const backups = result.backups.map(backup => backup.path).join(', ');
	return backups.length === 0
		? `Migrated ${result.name} to ${result.canonicalPath}; no originals needed backup.`
		: `Migrated ${result.name} to ${result.canonicalPath}; backups: ${backups}`;
}

const bulkPreviewLimit = 10;

function previewSection(label: string, names: ReadonlyArray<string>): ReadonlyArray<string> {
	const shown = names.slice(0, bulkPreviewLimit);
	const lines = [`${label} (${names.length})`, ...shown.map(name => `  ${name}`)];
	if (shown.length < names.length) {
		lines.push(`  … ${names.length - shown.length} more`);
	}
	return lines;
}

function appendPreview(lines: string[], label: string, names: ReadonlyArray<string>): void {
	if (names.length > 0) {
		lines.push('', ...previewSection(label, names));
	}
}

function plannedNames(plan: BulkMigrationPlan, status: BulkMigrationStatus): string[] {
	return plan.items.filter(item => item.status === status).map(item => item.name);
}

function formatBulkPlan(plan: BulkMigrationPlan): string {
	const ready = plannedNames(plan, 'ready');
	const managed = plannedNames(plan, 'managed');
	const divergent = plannedNames(plan, 'divergent');
	const blocked = plannedNames(plan, 'blocked');
	const details: string[] = [];
	appendPreview(details, 'Ready', ready);
	appendPreview(details, 'Managed', managed);
	appendPreview(details, 'Divergent — choose a per-Skill --source', divergent);
	appendPreview(details, 'Blocked — left untouched', blocked);
	return [
		'AMC Bulk Migration · DRY RUN',
		`Ready ${ready.length} · Managed ${managed.length} · Divergent ${divergent.length} · Blocked ${blocked.length} · Warnings ${plan.diagnostics.length}`,
		...details,
		'',
		'No changes made.',
		'Apply this fresh inventory: amc migrate --all --yes',
		'Diagnostics: amc list --diagnostics',
	].join('\n');
}

function formatBulkResult(result: BulkMigrationResult): string {
	const migrated = result.migrated.map(migration => migration.name);
	const backupRoots = result.migrated.flatMap(migration => migration.backupRoot === undefined
		? []
		: [`${migration.name}: ${migration.backupRoot}`]);
	const details: string[] = [];
	appendPreview(details, 'Migrated', migrated);
	appendPreview(details, 'Managed', result.managed);
	appendPreview(details, 'Divergent — skipped', result.divergent);
	appendPreview(details, 'Blocked — untouched', result.blocked);
	appendPreview(details, 'Pending', result.pending);
	if (result.failure !== undefined) {
		details.push('', 'Failed (1)', `  ${result.failure.name}: ${result.failure.code} — ${result.failure.message}`);
	}
	return [
		'AMC Bulk Migration · APPLY',
		`Migrated ${migrated.length} · Managed ${result.managed.length} · Divergent ${result.divergent.length} · Blocked ${result.blocked.length} · Pending ${result.pending.length} · Warnings ${result.diagnostics.length}`,
		...details,
		'',
		`Backup roots (${backupRoots.length})`,
		...(backupRoots.length === 0 ? ['  —'] : backupRoots.map(root => `  ${root}`)),
	].join('\n');
}

type Page<T> = Readonly<{
	rows: ReadonlyArray<T>;
	total: number;
	page: number;
	pageCount: number;
	start: number;
	end: number;
}>;

function paginate<T>(rows: ReadonlyArray<T>, page: number, limit: number, all: boolean): Page<T> {
	if (all) {
		return {
			rows,
			total: rows.length,
			page: 1,
			pageCount: 1,
			start: rows.length === 0 ? 0 : 1,
			end: rows.length,
		};
	}

	const pageCount = Math.max(1, Math.ceil(rows.length / limit));
	if (page > pageCount) {
		return usage(`Page ${page} is out of range; last page is ${pageCount}`);
	}

	const offset = (page - 1) * limit;
	const pageRows = rows.slice(offset, offset + limit);
	return {
		rows: pageRows,
		total: rows.length,
		page,
		pageCount,
		start: pageRows.length === 0 ? 0 : offset + 1,
		end: offset + pageRows.length,
	};
}

function characterLength(value: string): number {
	return Array.from(value).length;
}

function truncateEnd(value: string, width: number): string {
	const characters = Array.from(value);
	if (characters.length <= width) {
		return value;
	}
	if (width <= 1) {
		return '…';
	}
	return `${characters.slice(0, width - 1).join('')}…`;
}

function pad(value: string, width: number): string {
	return `${value}${' '.repeat(Math.max(0, width - characterLength(value)))}`;
}

function fit(value: string, width: number, truncate: boolean): string {
	return pad(truncate ? truncateEnd(value, width) : value, width);
}

function stateText(state: TargetState): string {
	return state;
}

function skillTable(skills: ReadonlyArray<Skill>, output: OutputContext): ReadonlyArray<string> {
	if (skills.length === 0) {
		return ['No Skills found.'];
	}

	const longestName = skills.reduce(
		(longest, skill) => Math.max(longest, characterLength(skill.name)),
		characterLength('SKILL'),
	);
	const targetWidth = 9;
	const fixedWidth = (targetWidth * 3) + 6;
	const skillWidth = output.isTTY
		? Math.max(5, Math.min(longestName, Math.max(5, output.columns - fixedWidth)))
		: longestName;
	const compact = output.isTTY && output.columns < 68;
	const headers = compact ? ['C', 'P', 'X'] : ['CLAUDE', 'PI', 'CODEX'];
	const lines = [
		[
			fit('SKILL', skillWidth, output.isTTY),
			fit(headers[0] ?? '', targetWidth, false),
			fit(headers[1] ?? '', targetWidth, false),
			fit(headers[2] ?? '', targetWidth, false),
		].join('  ').trimEnd(),
	];

	for (const skill of skills) {
		lines.push([
			fit(skill.name, skillWidth, output.isTTY),
			fit(stateText(skill.states.claude), targetWidth, false),
			fit(stateText(skill.states.pi), targetWidth, false),
			fit(stateText(skill.states.codex), targetWidth, false),
		].join('  ').trimEnd());
	}

	return lines;
}

function diagnosticTable(
	diagnostics: ReadonlyArray<Diagnostic>,
	output: OutputContext,
): ReadonlyArray<string> {
	if (diagnostics.length === 0) {
		return ['No diagnostics found.'];
	}

	const longestMessage = diagnostics.reduce(
		(longest, diagnostic) => Math.max(longest, characterLength(diagnostic.message)),
		characterLength('MESSAGE'),
	);
	const longestPath = diagnostics.reduce(
		(longest, diagnostic) => Math.max(longest, characterLength(diagnostic.path)),
		characterLength('PATH'),
	);
	const messageWidth = output.isTTY
		? Math.max(12, Math.min(longestMessage, Math.floor(output.columns * 0.4)))
		: longestMessage;
	const pathWidth = output.isTTY
		? Math.max(5, output.columns - messageWidth - 2)
		: longestPath;
	const lines = [[
		fit('MESSAGE', messageWidth, output.isTTY),
		fit('PATH', pathWidth, output.isTTY),
	].join('  ').trimEnd()];

	for (const diagnostic of diagnostics) {
		lines.push([
			fit(diagnostic.message, messageWidth, output.isTTY),
			fit(diagnostic.path, pathWidth, output.isTTY),
		].join('  ').trimEnd());
	}

	return lines;
}

function warningLabel(count: number): string {
	return `${count} ${count === 1 ? 'warning' : 'warnings'}`;
}

function pageFooter(page: Page<Skill> | Page<Diagnostic>, command: Extract<Command, {kind: 'list'}>): string[] {
	const lines = [`Showing ${page.start}–${page.end} of ${page.total} · Page ${page.page}/${page.pageCount}`];
	if (!command.all && command.search === undefined && page.page < page.pageCount) {
		lines.push(`Next: amc list${command.diagnostics ? ' --diagnostics' : ''} --page ${page.page + 1}`);
	}
	if (!command.all && command.search === undefined && page.page > 1) {
		lines.push(`Previous: amc list${command.diagnostics ? ' --diagnostics' : ''} --page ${page.page - 1}`);
	}
	return lines;
}

function includesSearch(value: string, search: string | undefined): boolean {
	return search === undefined || value.toLowerCase().includes(search.toLowerCase());
}

function formatList(
	result: ScanResult,
	command: Extract<Command, {kind: 'list'}>,
	output: OutputContext,
): string {
	if (command.diagnostics) {
		const filtered = result.diagnostics.filter(diagnostic => includesSearch(
			`${diagnostic.message}\n${diagnostic.path}`,
			command.search,
		));
		const page = paginate(filtered, command.page, command.limit, command.all);
		const count = command.search === undefined
			? `${filtered.length} total`
			: `${filtered.length} matches · ${result.diagnostics.length} total`;
		return [
			`AMC Diagnostics · ${count}`,
			'',
			...diagnosticTable(page.rows, output),
			'',
			...pageFooter(page, command),
		].join('\n');
	}

	const filtered = result.skills.filter(skill => includesSearch(skill.name, command.search));
	const page = paginate(filtered, command.page, command.limit, command.all);
	const count = command.search === undefined
		? `${filtered.length} total`
		: `${filtered.length} matches · ${result.skills.length} total`;
	return [
		`AMC Skills · ${count} · ${warningLabel(result.diagnostics.length)}`,
		'',
		...skillTable(page.rows, output),
		'',
		...pageFooter(page, command),
	].join('\n');
}

export async function executeCommand(
	layout: Layout,
	command: HeadlessCommand,
	output: OutputContext = {isTTY: false, columns: 80},
): Promise<string> {
	switch (command.kind) {
		case 'help':
			return helpText;
		case 'version':
			return version;
		case 'list': {
			const result = await listSkills(layout);
			return formatList(result, command, output);
		}
		case 'enable': {
			const result = command.target === undefined
				? await setSkillEnabled(layout, command.name, true)
				: await setSkillEnabled(layout, command.name, true, [command.target]);
			return formatToggle(result, true);
		}
		case 'disable': {
			const result = command.target === undefined
				? await setSkillEnabled(layout, command.name, false)
				: await setSkillEnabled(layout, command.name, false, [command.target]);
			return formatToggle(result, false);
		}
		case 'migrate': {
			const plan = await planMigration(layout, command.name);
			const result = await executeMigration(layout, plan, command.source);
			return formatMigration(result);
		}
		case 'migrate-all': {
			const plan = await planBulkMigration(layout);
			if (!command.apply) {
				return formatBulkPlan(plan);
			}
			const result = await executeBulkMigration(layout, plan);
			const formatted = formatBulkResult(result);
			if (result.failure !== undefined) {
				throw new AmcError('BULK_MIGRATION_FAILED', formatted, result.failure.path);
			}
			return formatted;
		}
	}
}

import type {BulkMigrationPlan, BulkMigrationResult, BulkMigrationStatus, Diagnostic, MigrationResult, ScanResult, Skill, TargetState, ToggleResult} from '../core/model.js';
import type {HookResource, McpServerResource, PluginResource} from '../core/resources/model.js';
import {ansiCodeForRole, type ColorRole} from '../presentation/theme.js';
import {type Command, type OutputContext, usage} from './commands.js';

function compactPluginState(plugin: PluginResource): string {
	switch (plugin.state) {
		case 'enabled':
			return '●';
		case 'disabled':
			return '○';
		case 'installed':
			return 'I';
		case 'unknown':
			return '?';
	}
}

export function pluginTable(plugins: ReadonlyArray<PluginResource>, output: OutputContext): ReadonlyArray<string> {
	if (plugins.length === 0) {
		return ['No plugins found.'];
	}
	const compact = output.isTTY && output.columns < 68;
	const longest = Math.max(8, ...plugins.map(plugin => characterLength(plugin.name)));
	const widths = compact
		? [Math.max(8, Math.min(longest, output.columns - 26)), 1, 1, 11]
		: [output.isTTY ? Math.max(8, Math.min(longest, output.columns - 48)) : longest, 8, 9, 18];
	const lines = [
		tableBorder(widths, {left: '┌', separator: '┬', right: '┐'}, output),
		tableRow(compact ? ['PLUGIN', 'P', 'S', 'MODE'] : ['PLUGIN', 'PROVIDER', 'STATE', 'MANAGEMENT'], widths, ['bold', 'bold', 'bold', 'bold'], output),
		tableBorder(widths, {left: '├', separator: '┼', right: '┤'}, output),
	];
	for (const plugin of plugins) {
		lines.push(tableRow(
			compact
				? [plugin.name, plugin.provider.slice(0, 1).toUpperCase(), compactPluginState(plugin), plugin.capability.replace('native-', '')]
				: [plugin.name, plugin.provider, plugin.state, plugin.capability],
			widths,
			[undefined, 'accent', plugin.state === 'enabled' ? 'enabled' : 'muted', 'muted'],
			output,
		));
	}
	lines.push(tableBorder(widths, {left: '└', separator: '┴', right: '┘'}, output));
	return lines;
}

export function hookTable(hooks: ReadonlyArray<HookResource>, output: OutputContext): ReadonlyArray<string> {
	if (hooks.length === 0) {
		return ['No hooks found.'];
	}
	const compact = output.isTTY && output.columns < 68;
	const longest = Math.max(8, ...hooks.map(hook => characterLength(hook.event)));
	const widths = compact
		? [8, 1, 1, Math.max(8, Math.min(longest, output.columns - 31)), 1, 3]
		: [16, 8, 7, output.isTTY ? Math.max(8, Math.min(longest, output.columns - 68)) : longest, 8, 9];
	const lines = [
		tableBorder(widths, {left: '┌', separator: '┬', right: '┐'}, output),
		tableRow(compact ? ['ID', 'P', 'S', 'EVENT', 'E', 'TYPE'] : ['ID', 'PROVIDER', 'SCOPE', 'EVENT', 'STATE', 'TYPE'], widths, ['bold', 'bold', 'bold', 'bold', 'bold', 'bold'], output),
		tableBorder(widths, {left: '├', separator: '┼', right: '┤'}, output),
	];
	for (const hook of hooks) {
		lines.push(tableRow(
			compact
				? [hook.id, hook.provider.slice(0, 1).toUpperCase(), hook.scope.slice(0, 1).toUpperCase(), hook.event, hook.state === 'enabled' ? '●' : '○', hook.type]
				: [hook.id, hook.provider, hook.scope, hook.event, hook.state, hook.type],
			widths,
			['muted', 'accent', undefined, undefined, hook.state === 'enabled' ? 'enabled' : 'muted', undefined],
			output,
		));
	}
	lines.push(tableBorder(widths, {left: '└', separator: '┴', right: '┘'}, output));
	return lines;
}

export function mcpTable(servers: ReadonlyArray<McpServerResource>, output: OutputContext): ReadonlyArray<string> {
	if (servers.length === 0) {
		return ['No MCP servers found.'];
	}
	const compact = output.isTTY && output.columns < 68;
	const longest = Math.max(8, ...servers.map(server => characterLength(server.name)));
	const widths = compact
		? [Math.max(8, Math.min(longest, output.columns - 27)), 1, 1, 5, 1]
		: [output.isTTY ? Math.max(8, Math.min(longest, output.columns - 51)) : longest, 8, 7, 9, 9];
	const lines = [
		tableBorder(widths, {left: '┌', separator: '┬', right: '┐'}, output),
		tableRow(compact ? ['SERVER', 'P', 'S', 'TYPE', 'E'] : ['SERVER', 'PROVIDER', 'SCOPE', 'TRANSPORT', 'STATE'], widths, ['bold', 'bold', 'bold', 'bold', 'bold'], output),
		tableBorder(widths, {left: '├', separator: '┼', right: '┤'}, output),
	];
	for (const server of servers) {
		lines.push(tableRow(
			compact
				? [server.name, server.provider.slice(0, 1).toUpperCase(), server.scope.slice(0, 1).toUpperCase(), server.transport, server.state === 'enabled' ? '●' : server.state === 'disabled' ? '○' : '?']
				: [server.name, server.provider, server.scope, server.transport, server.state],
			widths,
			[undefined, 'accent', undefined, 'muted', server.state === 'enabled' ? 'enabled' : 'muted'],
			output,
		));
	}
	lines.push(tableBorder(widths, {left: '└', separator: '┴', right: '┘'}, output));
	return lines;
}

export function resourceFooter<T>(page: Page<T>, prefix: string): ReadonlyArray<string> {
	const lines = [`Showing ${page.start}–${page.end} of ${page.total} · Page ${page.page}/${page.pageCount}`];
	if (page.page < page.pageCount) {
		lines.push(`Next: ${prefix} --page ${page.page + 1}`);
	}
	if (page.page > 1) {
		lines.push(`Previous: ${prefix} --page ${page.page - 1}`);
	}
	return lines;
}

export function formatToggle(result: ToggleResult, enabled: boolean): string {
	const action = enabled ? 'Enabled' : 'Disabled';
	const changes = result.changes
		.map(change => `${change.target}=${change.changed ? 'changed' : 'no-op'}`)
		.join(' ');
	return `${action} ${result.name}: ${changes}`;
}

export function formatMigration(result: MigrationResult): string {
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

export function formatBulkPlan(plan: BulkMigrationPlan): string {
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

export function formatBulkResult(result: BulkMigrationResult): string {
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

export function paginate<T>(rows: ReadonlyArray<T>, page: number, limit: number, all: boolean): Page<T> {
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

function ansi(value: string, code: string, output: OutputContext): string {
	return output.isTTY ? `\u001B[${code}m${value}\u001B[0m` : value;
}

export function ansiRole(value: string, role: ColorRole, output: OutputContext): string {
	const code = ansiCodeForRole(output.presentation, role);
	return code === undefined ? value : ansi(value, code, output);
}

function stateText(state: TargetState, compact: boolean): string {
	if (!compact) {
		return state;
	}
	switch (state) {
		case 'enabled':
			return '●';
		case 'disabled':
			return '○';
		case 'shared':
			return '◆';
		case 'unmanaged':
			return '◇';
		case 'conflict':
			return '!';
	}
}

function stateRole(state: TargetState): ColorRole {
	switch (state) {
		case 'enabled':
			return 'enabled';
		case 'disabled':
			return 'muted';
		case 'shared':
			return 'warning';
		case 'unmanaged':
			return 'warning';
		case 'conflict':
			return 'error';
	}
}

function tableBorder(
	widths: ReadonlyArray<number>,
	characters: Readonly<{left: string; separator: string; right: string}>,
	output: OutputContext,
): string {
	return ansiRole(
		`${characters.left}${widths.map(width => '─'.repeat(width + 2)).join(characters.separator)}${characters.right}`,
		'border',
		output,
	);
}

function tableRow(
	values: ReadonlyArray<string>,
	widths: ReadonlyArray<number>,
	styles: ReadonlyArray<'bold' | ColorRole | undefined>,
	output: OutputContext,
): string {
	const cells = values.map((value, index) => {
		const width = widths[index] ?? characterLength(value);
		const cell = fit(value, width, output.isTTY);
		const style = styles[index];
		return style === undefined
			? cell
			: style === 'bold' ? ansi(cell, '1', output) : ansiRole(cell, style, output);
	});
	return `│ ${cells.join(' │ ')} │`;
}

function skillTable(skills: ReadonlyArray<Skill>, output: OutputContext): ReadonlyArray<string> {
	if (skills.length === 0) {
		return ['No Skills found.'];
	}

	const longestName = skills.reduce(
		(longest, skill) => Math.max(longest, characterLength(skill.name)),
		characterLength('SKILL'),
	);
	const compact = output.isTTY && output.columns < 68;
	const targetWidth = compact ? 5 : 9;
	const fixedWidth = (targetWidth * 3) + 13;
	const skillWidth = output.isTTY
		? Math.max(5, Math.min(longestName, Math.max(5, output.columns - fixedWidth)))
		: longestName;
	const headers = compact ? ['C', 'P', 'X'] : ['CLAUDE', 'PI', 'CODEX'];
	const widths = [skillWidth, targetWidth, targetWidth, targetWidth];
	const lines = [
		tableBorder(widths, {left: '┌', separator: '┬', right: '┐'}, output),
		tableRow(['SKILL', headers[0] ?? '', headers[1] ?? '', headers[2] ?? ''], widths, ['bold', 'bold', 'bold', 'bold'], output),
		tableBorder(widths, {left: '├', separator: '┼', right: '┤'}, output),
	];

	for (const skill of skills) {
		lines.push(tableRow(
			[
				skill.name,
				stateText(skill.states.claude, compact),
				stateText(skill.states.pi, compact),
				stateText(skill.states.codex, compact),
			],
			widths,
			[
				undefined,
				stateRole(skill.states.claude),
				stateRole(skill.states.pi),
				stateRole(skill.states.codex),
			],
			output,
		));
	}
	lines.push(tableBorder(widths, {left: '└', separator: '┴', right: '┘'}, output));

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
		? Math.max(5, output.columns - messageWidth - 7)
		: longestPath;
	const widths = [messageWidth, pathWidth];
	const lines = [
		tableBorder(widths, {left: '┌', separator: '┬', right: '┐'}, output),
		tableRow(['MESSAGE', 'PATH'], widths, ['bold', 'bold'], output),
		tableBorder(widths, {left: '├', separator: '┼', right: '┤'}, output),
	];

	for (const diagnostic of diagnostics) {
		lines.push(tableRow(
			[diagnostic.message, diagnostic.path],
			widths,
			['error', undefined],
			output,
		));
	}
	lines.push(tableBorder(widths, {left: '└', separator: '┴', right: '┘'}, output));

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

export function includesSearch(value: string, search: string | undefined): boolean {
	return search === undefined || value.toLowerCase().includes(search.toLowerCase());
}

export function formatList(
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
			`${ansiRole('AMC', 'accent', output)} Diagnostics · ${count}`,
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
		`${ansiRole('AMC', 'accent', output)} Skills · ${count} · ${ansiRole(warningLabel(result.diagnostics.length), 'muted', output)}`,
		'',
		...skillTable(page.rows, output),
		'',
		...pageFooter(page, command),
	].join('\n');
}


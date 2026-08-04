import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, mkdir, readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, join} from 'node:path';
import type {Target} from './index.js';

export type ManagementCapability =
	| 'native-headless'
	| 'native-interactive'
	| 'config-edit'
	| 'unsupported';

export type PluginState = 'enabled' | 'disabled' | 'unknown';
export type ResourceScope = 'user' | 'project' | 'local' | 'unknown';

export type PluginResource = Readonly<{
	id: string;
	provider: Target;
	name: string;
	version: string | undefined;
	scope: ResourceScope | undefined;
	state: PluginState;
	capability: ManagementCapability;
}>;

export type HookResource = Readonly<{
	id: string;
	provider: Target;
	scope: ResourceScope;
	event: string;
	type: string;
	sourcePath: string;
	capability: ManagementCapability;
}>;

export type McpTransport = 'stdio' | 'http' | 'sse' | 'unknown';

export type McpServerResource = Readonly<{
	id: string;
	provider: Target;
	name: string;
	scope: ResourceScope;
	transport: McpTransport;
	state: PluginState;
	capability: ManagementCapability;
	sourcePath: string;
}>;

export type ResourceDiagnostic = Readonly<{
	provider: Target;
	path: string;
	message: string;
}>;

export type PluginScanResult = Readonly<{
	plugins: ReadonlyArray<PluginResource>;
	diagnostics: ReadonlyArray<ResourceDiagnostic>;
}>;

export type HookScanResult = Readonly<{
	hooks: ReadonlyArray<HookResource>;
	diagnostics: ReadonlyArray<ResourceDiagnostic>;
}>;

export type McpScanResult = Readonly<{
	servers: ReadonlyArray<McpServerResource>;
	diagnostics: ReadonlyArray<ResourceDiagnostic>;
	notes: ReadonlyArray<string>;
}>;

export type ResourceContext = Readonly<{home: string; cwd: string}>;
export type CommandResult = Readonly<{exitCode: number; stdout: string; stderr: string}>;
export type ResourceRuntime = Readonly<{
	run: (program: string, arguments_: ReadonlyArray<string>) => Promise<CommandResult>;
	openEditor: (path: string) => Promise<void>;
}>;

type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is ReadonlyArray<unknown> {
	return Array.isArray(value);
}

function stringField(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === 'string' ? value : undefined;
}

function booleanField(object: JsonObject, key: string): boolean | undefined {
	const value = object[key];
	return typeof value === 'boolean' ? value : undefined;
}

function scopeField(value: unknown): ResourceScope | undefined {
	switch (value) {
		case 'user':
		case 'project':
		case 'local':
			return value;
		default:
			return value === undefined ? undefined : 'unknown';
	}
}

function transportField(value: unknown): McpTransport {
	switch (value) {
		case 'stdio':
			return 'stdio';
		case 'http':
		case 'streamable-http':
			return 'http';
		case 'sse':
			return 'sse';
		default:
			return 'unknown';
	}
}

function parseJson(text: string): unknown {
	return JSON.parse(text);
}

function pluginDiagnostic(provider: Target, message: string): ResourceDiagnostic {
	return {provider, path: provider, message};
}

function parseClaudePlugins(value: unknown): ReadonlyArray<PluginResource> {
	if (!isUnknownArray(value)) {
		throw new Error('expected a JSON array');
	}
	return value.flatMap(entry => {
		if (!isObject(entry)) {
			return [];
		}
		const name = stringField(entry, 'pluginId') ?? stringField(entry, 'id') ?? stringField(entry, 'name');
		if (name === undefined) {
			return [];
		}
		const enabled = booleanField(entry, 'enabled');
		return [{
			id: `claude:${name}`,
			provider: 'claude',
			name,
			version: stringField(entry, 'version'),
			scope: scopeField(entry['scope']),
			state: enabled === undefined ? 'unknown' : enabled ? 'enabled' : 'disabled',
			capability: 'native-headless',
		}];
	});
}

function parseCodexPlugins(value: unknown): ReadonlyArray<PluginResource> {
	if (!isObject(value) || !isUnknownArray(value['installed'])) {
		throw new Error('expected an installed JSON array');
	}
	return value['installed'].flatMap(entry => {
		if (!isObject(entry)) {
			return [];
		}
		const name = stringField(entry, 'pluginId') ?? stringField(entry, 'id') ?? stringField(entry, 'name');
		if (name === undefined) {
			return [];
		}
		const enabled = booleanField(entry, 'enabled');
		return [{
			id: `codex:${name}`,
			provider: 'codex',
			name,
			version: stringField(entry, 'version'),
			scope: scopeField(entry['scope']),
			state: enabled === undefined ? 'unknown' : enabled ? 'enabled' : 'disabled',
			capability: 'config-edit',
		}];
	});
}

function parsePiPlugins(text: string): ReadonlyArray<PluginResource> {
	let scope: ResourceScope = 'user';
	const plugins: PluginResource[] = [];
	for (const line of text.split(/\r?\n/u)) {
		if (/^project packages:/iu.test(line)) {
			scope = 'project';
			continue;
		}
		if (/^user packages:/iu.test(line)) {
			scope = 'user';
			continue;
		}
		const match = /^\s{2}((?:npm:|git:|https?:|\/|\.\/)[^\s]+)\s*$/u.exec(line);
		const name = match?.[1];
		if (name !== undefined) {
			plugins.push({
				id: `pi:${name}`,
				provider: 'pi',
				name,
				version: undefined,
				scope,
				state: 'unknown',
				capability: 'native-interactive',
			});
		}
	}
	return plugins;
}

async function scanPluginProvider(
	provider: Target,
	runtime: ResourceRuntime,
): Promise<Readonly<{plugins: ReadonlyArray<PluginResource>; diagnostic: ResourceDiagnostic | undefined}>> {
	const command = provider === 'pi' ? ['list'] : ['plugin', 'list', '--json'];
	try {
		const result = await runtime.run(provider, command);
		if (result.exitCode !== 0) {
			return {plugins: [], diagnostic: pluginDiagnostic(provider, result.stderr.trim() || `exit ${result.exitCode}`)};
		}
		const plugins = provider === 'pi'
			? parsePiPlugins(result.stdout)
			: provider === 'claude'
				? parseClaudePlugins(parseJson(result.stdout))
				: parseCodexPlugins(parseJson(result.stdout));
		return {plugins, diagnostic: undefined};
	} catch (error: unknown) {
		return {
			plugins: [],
			diagnostic: pluginDiagnostic(provider, error instanceof Error ? error.message : 'plugin scan failed'),
		};
	}
}

export async function scanPlugins(
	_context: ResourceContext,
	runtime: ResourceRuntime,
): Promise<PluginScanResult> {
	const results = await Promise.all([
		scanPluginProvider('claude', runtime),
		scanPluginProvider('codex', runtime),
		scanPluginProvider('pi', runtime),
	]);
	return {
		plugins: results.flatMap(result => result.plugins)
			.sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name)),
		diagnostics: results.flatMap(result => result.diagnostic === undefined ? [] : [result.diagnostic]),
	};
}

export async function setPluginEnabled(
	context: ResourceContext,
	runtime: ResourceRuntime,
	id: string,
	enabled: boolean,
): Promise<PluginResource> {
	const current = (await scanPlugins(context, runtime)).plugins.find(plugin => plugin.id === id);
	if (current === undefined) {
		throw new Error(`PLUGIN_NOT_FOUND: ${id}`);
	}
	if (current.provider === 'pi') {
		throw new Error(`INTERACTIVE_REQUIRED: ${pluginInteractionInstruction(current)}`);
	}
	if (current.provider === 'claude') {
		const arguments_ = ['plugin', enabled ? 'enable' : 'disable', current.name];
		if (current.scope !== undefined && current.scope !== 'unknown') {
			arguments_.push('--scope', current.scope);
		}
		const mutation = await runtime.run('claude', arguments_);
		if (mutation.exitCode !== 0) {
			throw new Error(`PLUGIN_CHANGE_FAILED: ${mutation.stderr.trim() || `exit ${mutation.exitCode}`}`);
		}
	} else {
		await updateTomlBooleanWithConfirmation(
			join(context.home, '.codex', 'config.toml'),
			'plugins',
			current.name,
			enabled,
			async () => {
				const confirmed = (await scanPlugins(context, runtime)).plugins.find(plugin => plugin.id === id);
				return confirmed?.state === (enabled ? 'enabled' : 'disabled');
			},
		);
	}
	const confirmed = (await scanPlugins(context, runtime)).plugins.find(plugin => plugin.id === id);
	const expectedState: PluginState = enabled ? 'enabled' : 'disabled';
	if (confirmed?.state !== expectedState) {
		throw new Error(`PLUGIN_STATE_UNCONFIRMED: expected ${expectedState}`);
	}
	return confirmed;
}

export function pluginInteractionInstruction(plugin: PluginResource): string {
	return plugin.provider === 'pi'
		? `Pi does not expose a headless package-resource toggle. Run \`pi config\`, select \`${plugin.name}\`, then change its resource state.`
		: `${plugin.name} can be toggled directly by AMC.`;
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}

function tomlSectionHeader(group: string, name: string): string {
	return `[${group}.${tomlString(name)}]`;
}

function updateTomlBoolean(text: string, group: string, name: string, enabled: boolean): string {
	const lines = text.split('\n');
	const quotedHeader = tomlSectionHeader(group, name);
	const bareHeader = `[${group}.${name}]`;
	const sectionStart = lines.findIndex(line => line.trim() === quotedHeader || line.trim() === bareHeader);
	const setting = `enabled = ${enabled ? 'true' : 'false'}`;
	if (sectionStart === -1) {
		const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
		return `${text}${separator}${quotedHeader}\n${setting}\n`;
	}
	const nextSection = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/u.test(line));
	const sectionEnd = nextSection === -1 ? lines.length : nextSection;
	const enabledIndex = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && /^\s*enabled\s*=/u.test(line));
	if (enabledIndex === -1) {
		lines.splice(sectionStart + 1, 0, setting);
	} else {
		lines[enabledIndex] = setting;
	}
	return lines.join('\n');
}

async function atomicReplace(path: string, contents: string, mode: number): Promise<void> {
	await mkdir(dirname(path), {recursive: true});
	const temporaryPath = `${path}.amc-${randomUUID()}.tmp`;
	await writeFile(temporaryPath, contents, {encoding: 'utf8', flag: 'wx', mode});
	await rename(temporaryPath, path);
}

async function replaceWithBackupAndConfirmation(
	path: string,
	original: string,
	next: string,
	errorCode: string,
	confirm: () => Promise<boolean>,
): Promise<void> {
	const fileMode = (await stat(path)).mode & 0o777;
	const backupPath = `${path}.amc-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
	await copyFile(path, backupPath, constants.COPYFILE_EXCL);
	if (await readFile(path, 'utf8') !== original) {
		throw new Error(`${errorCode}: config changed while AMC was preparing the update. Backup: ${backupPath}`);
	}
	await atomicReplace(path, next, fileMode);
	let confirmationFailure: string | undefined;
	try {
		if (await confirm()) {
			return;
		}
	} catch (error: unknown) {
		confirmationFailure = error instanceof Error ? error.message : 'verification failed';
	}
	try {
		await atomicReplace(path, original, fileMode);
	} catch (error: unknown) {
		throw new Error(`${errorCode}: restore from ${backupPath}; ${error instanceof Error ? error.message : 'rollback failed'}`);
	}
	throw new Error(`${errorCode}: original config restored${confirmationFailure === undefined ? '' : ` after ${confirmationFailure}`}. Backup: ${backupPath}`);
}

async function updateTomlBooleanWithConfirmation(
	path: string,
	group: string,
	name: string,
	enabled: boolean,
	confirm: () => Promise<boolean>,
): Promise<void> {
	const original = await readFile(path, 'utf8');
	await replaceWithBackupAndConfirmation(
		path,
		original,
		updateTomlBoolean(original, group, name, enabled),
		'CONFIG_CONFIRMATION_FAILED',
		confirm,
	);
}

async function readJsonObject(path: string, provider: Target): Promise<Readonly<{
	value: JsonObject | undefined;
	diagnostic: ResourceDiagnostic | undefined;
}>> {
	try {
		const value = parseJson(await readFile(path, 'utf8'));
		return isObject(value)
			? {value, diagnostic: undefined}
			: {value: undefined, diagnostic: {provider, path, message: 'expected a JSON object'}};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return {value: undefined, diagnostic: undefined};
		}
		return {value: undefined, diagnostic: {provider, path, message: error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error ? error.message : 'read failed'}};
	}
}

function stringArray(value: unknown): ReadonlyArray<string> {
	return isUnknownArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function claudeMcpServers(
	value: unknown,
	path: string,
	scope: ResourceScope,
	disabled: ReadonlySet<string>,
): ReadonlyArray<McpServerResource> {
	if (!isObject(value)) {
		return [];
	}
	return Object.entries(value).flatMap(([name, server]) => {
		if (!isObject(server)) {
			return [];
		}
		return [{
			id: `claude:${name}:${scope}`,
			provider: 'claude',
			name,
			scope,
			transport: transportField(server['type'] ?? (server['url'] === undefined ? 'stdio' : 'http')),
			state: disabled.has(name) ? 'disabled' : 'enabled',
			capability: 'config-edit',
			sourcePath: path,
		}];
	});
}

function codexMcpServers(
	value: unknown,
	context: ResourceContext,
	projectNames: ReadonlySet<string>,
): ReadonlyArray<McpServerResource> {
	if (!isUnknownArray(value)) {
		throw new Error('expected a JSON array');
	}
	return value.flatMap(entry => {
		if (!isObject(entry)) {
			return [];
		}
		const name = stringField(entry, 'name');
		if (name === undefined) {
			return [];
		}
		const transport = isObject(entry['transport']) ? transportField(entry['transport']['type']) : 'unknown';
		const enabled = booleanField(entry, 'enabled');
		const scope: ResourceScope = projectNames.has(name) ? 'project' : 'user';
		return [{
			id: `codex:${name}:${scope}`,
			provider: 'codex',
			name,
			scope,
			transport,
			state: enabled === undefined ? 'unknown' : enabled ? 'enabled' : 'disabled',
			capability: 'config-edit',
			sourcePath: scope === 'project'
				? join(context.cwd, '.codex', 'config.toml')
				: join(context.home, '.codex', 'config.toml'),
		}];
	});
}

async function tomlSectionNames(path: string, group: string): Promise<Readonly<{
	names: ReadonlySet<string>;
	diagnostic: ResourceDiagnostic | undefined;
}>> {
	try {
		const text = await readFile(path, 'utf8');
		const names = new Set<string>();
		const pattern = new RegExp(`^\\s*\\[${group}\\.(?:"((?:\\\\.|[^"])*)"|([A-Za-z0-9_-]+))\\]\\s*$`, 'u');
		for (const line of text.split(/\r?\n/u)) {
			const match = pattern.exec(line);
			const bare = match?.[2];
			if (bare !== undefined) {
				names.add(bare);
				continue;
			}
			const quoted = match?.[1];
			if (quoted !== undefined) {
				const decoded: unknown = JSON.parse(`"${quoted}"`);
				if (typeof decoded === 'string') {
					names.add(decoded);
				}
			}
		}
		return {names, diagnostic: undefined};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return {names: new Set<string>(), diagnostic: undefined};
		}
		return {names: new Set<string>(), diagnostic: {provider: 'codex', path, message: error instanceof Error ? error.message : 'read failed'}};
	}
}

export async function scanMcpServers(context: ResourceContext, runtime: ResourceRuntime): Promise<McpScanResult> {
	const claudePath = join(context.home, '.claude.json');
	const projectPath = join(context.cwd, '.mcp.json');
	const codexProjectPath = join(context.cwd, '.codex', 'config.toml');
	const [claude, project, codexProject] = await Promise.all([
		readJsonObject(claudePath, 'claude'),
		readJsonObject(projectPath, 'claude'),
		tomlSectionNames(codexProjectPath, 'mcp_servers'),
	]);
	const projectsValue = claude.value?.['projects'];
	const projectValue = isObject(projectsValue) ? projectsValue[context.cwd] : undefined;
	const projectSettings: JsonObject | undefined = isObject(projectValue) ? projectValue : undefined;
	const disabled = new Set(stringArray(projectSettings?.['disabledMcpServers']));
	const disabledProject = new Set(stringArray(projectSettings?.['disabledMcpjsonServers']));
	const claudeServers = [
		...claudeMcpServers(claude.value?.['mcpServers'], claudePath, 'user', disabled),
		...claudeMcpServers(projectSettings?.['mcpServers'], claudePath, 'local', disabled),
		...claudeMcpServers(project.value?.['mcpServers'], projectPath, 'project', disabledProject),
	];
	let codexServers: ReadonlyArray<McpServerResource> = [];
	let codexDiagnostic: ResourceDiagnostic | undefined;
	try {
		const result = await runtime.run('codex', ['mcp', 'list', '--json']);
		if (result.exitCode === 0) {
			codexServers = codexMcpServers(parseJson(result.stdout), context, codexProject.names);
		} else {
			codexDiagnostic = pluginDiagnostic('codex', result.stderr.trim() || `exit ${result.exitCode}`);
		}
	} catch (error: unknown) {
		codexDiagnostic = pluginDiagnostic('codex', error instanceof Error ? error.message : 'MCP scan failed');
	}
	return {
		servers: [...claudeServers, ...codexServers]
			.sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope)),
		diagnostics: [claude.diagnostic, project.diagnostic, codexProject.diagnostic, codexDiagnostic].filter((item): item is ResourceDiagnostic => item !== undefined),
		notes: ['Pi does not provide native MCP; extensions may add their own MCP support.'],
	};
}

function updatedStringList(object: JsonObject, key: string, name: string, include: boolean): JsonObject {
	const current = stringArray(object[key]);
	const next = include
		? current.includes(name) ? current : [...current, name]
		: current.filter(item => item !== name);
	return {...object, [key]: next};
}

async function updateClaudeMcpState(
	context: ResourceContext,
	server: McpServerResource,
	enabled: boolean,
	confirm: () => Promise<boolean>,
): Promise<void> {
	const path = join(context.home, '.claude.json');
	const original = await readFile(path, 'utf8');
	const root = parseJson(original);
	if (!isObject(root)) {
		throw new Error('MCP_CHANGE_FAILED: ~/.claude.json is not a JSON object');
	}
	const projectsValue = root['projects'];
	const projects: JsonObject = isObject(projectsValue) ? projectsValue : {};
	const currentProjectValue = projects[context.cwd];
	const currentProject: JsonObject = isObject(currentProjectValue) ? currentProjectValue : {};
	const disabledKey = server.scope === 'project' ? 'disabledMcpjsonServers' : 'disabledMcpServers';
	const enabledKey = server.scope === 'project' ? 'enabledMcpjsonServers' : undefined;
	let nextProject = updatedStringList(currentProject, disabledKey, server.name, !enabled);
	if (enabledKey !== undefined) {
		nextProject = updatedStringList(nextProject, enabledKey, server.name, enabled);
	}
	const nextRoot: JsonObject = {...root, projects: {...projects, [context.cwd]: nextProject}};
	await replaceWithBackupAndConfirmation(
		path,
		original,
		`${JSON.stringify(nextRoot, undefined, 2)}\n`,
		'MCP_STATE_UNCONFIRMED',
		confirm,
	);
}

export async function setMcpServerEnabled(
	context: ResourceContext,
	runtime: ResourceRuntime,
	id: string,
	enabled: boolean,
): Promise<McpServerResource> {
	const current = (await scanMcpServers(context, runtime)).servers.find(server => server.id === id);
	if (current === undefined) {
		throw new Error(`MCP_NOT_FOUND: ${id}`);
	}
	if (current.provider === 'pi' || current.capability === 'unsupported') {
		throw new Error('MCP_UNSUPPORTED: Pi does not provide native MCP management.');
	}
	if (current.provider === 'codex') {
		await updateTomlBooleanWithConfirmation(
			current.sourcePath,
			'mcp_servers',
			current.name,
			enabled,
			async () => {
				const confirmed = (await scanMcpServers(context, runtime)).servers.find(server => server.id === id);
				return confirmed?.state === (enabled ? 'enabled' : 'disabled');
			},
		);
	} else {
		await updateClaudeMcpState(context, current, enabled, async () => {
			const confirmed = (await scanMcpServers(context, runtime)).servers.find(server => server.id === id);
			return confirmed?.state === (enabled ? 'enabled' : 'disabled');
		});
	}
	const confirmed = (await scanMcpServers(context, runtime)).servers.find(server => server.id === id);
	const expected = enabled ? 'enabled' : 'disabled';
	if (confirmed?.state !== expected) {
		throw new Error(`MCP_STATE_UNCONFIRMED: expected ${expected}`);
	}
	return confirmed;
}

function hookId(parts: ReadonlyArray<string>): string {
	return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function hookType(value: unknown): string {
	return isObject(value) ? stringField(value, 'type') ?? 'unknown' : 'unknown';
}

function claudeHooks(
	value: unknown,
	path: string,
	scope: ResourceScope,
): ReadonlyArray<HookResource> {
	if (!isObject(value) || !isObject(value['hooks'])) {
		return [];
	}
	const hooks: HookResource[] = [];
	for (const [event, groups] of Object.entries(value['hooks'])) {
		if (!isUnknownArray(groups)) {
			continue;
		}
		groups.forEach((group, groupIndex) => {
			if (!isObject(group) || !isUnknownArray(group['hooks'])) {
				return;
			}
			group['hooks'].forEach((hook, hookIndex) => {
				hooks.push({
					id: hookId(['claude', scope, path, event, `${groupIndex}`, `${hookIndex}`]),
					provider: 'claude',
					scope,
					event,
					type: hookType(hook),
					sourcePath: path,
					capability: 'config-edit',
				});
			});
		});
	}
	return hooks;
}

function codexHooks(
	value: unknown,
	path: string,
	scope: ResourceScope,
): ReadonlyArray<HookResource> {
	if (!isObject(value) || !isUnknownArray(value['hooks'])) {
		return [];
	}
	return value['hooks'].flatMap((hook, index) => {
		if (!isObject(hook)) {
			return [];
		}
		const event = stringField(hook, 'event') ?? 'unknown';
		return [{
			id: hookId(['codex', scope, path, event, `${index}`]),
			provider: 'codex',
			scope,
			event,
			type: stringField(hook, 'type') ?? (stringField(hook, 'command') === undefined ? 'unknown' : 'command'),
			sourcePath: path,
			capability: 'config-edit',
		}];
	});
}

function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

async function jsonHooks(
	provider: 'claude' | 'codex',
	path: string,
	scope: ResourceScope,
): Promise<Readonly<{hooks: ReadonlyArray<HookResource>; diagnostic: ResourceDiagnostic | undefined}>> {
	try {
		const value = parseJson(await readFile(path, 'utf8'));
		return {
			hooks: provider === 'claude' ? claudeHooks(value, path, scope) : codexHooks(value, path, scope),
			diagnostic: undefined,
		};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return {hooks: [], diagnostic: undefined};
		}
		return {
			hooks: [],
			diagnostic: {provider, path, message: error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error ? error.message : 'read failed'},
		};
	}
}

const extensionSuffixes = new Set(['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs']);

async function piExtensions(
	path: string,
	scope: ResourceScope,
): Promise<Readonly<{hooks: ReadonlyArray<HookResource>; diagnostic: ResourceDiagnostic | undefined}>> {
	try {
		const entries = await readdir(path, {withFileTypes: true});
		const sourcePaths: string[] = [];
		for (const entry of entries) {
			if (entry.isFile() && extensionSuffixes.has(extname(entry.name))) {
				sourcePaths.push(join(path, entry.name));
				continue;
			}
			if (entry.isDirectory()) {
				const children = await readdir(join(path, entry.name), {withFileTypes: true});
				const index = children.find(child => child.isFile()
					&& child.name.startsWith('index.')
					&& extensionSuffixes.has(extname(child.name)));
				if (index !== undefined) {
					sourcePaths.push(join(path, entry.name, index.name));
				}
			}
		}
		return {
			hooks: sourcePaths.map(sourcePath => {
				return {
					id: hookId(['pi', scope, sourcePath]),
					provider: 'pi',
					scope,
					event: 'Extension',
					type: 'extension',
					sourcePath,
					capability: 'config-edit',
				};
			}),
			diagnostic: undefined,
		};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return {hooks: [], diagnostic: undefined};
		}
		return {hooks: [], diagnostic: {provider: 'pi', path, message: error instanceof Error ? error.message : 'read failed'}};
	}
}

export async function scanHooks(context: ResourceContext): Promise<HookScanResult> {
	const sources = await Promise.all([
		jsonHooks('claude', join(context.home, '.claude', 'settings.json'), 'user'),
		jsonHooks('claude', join(context.cwd, '.claude', 'settings.json'), 'project'),
		jsonHooks('claude', join(context.cwd, '.claude', 'settings.local.json'), 'local'),
		jsonHooks('codex', join(context.home, '.codex', 'hooks.json'), 'user'),
		jsonHooks('codex', join(context.cwd, '.codex', 'hooks.json'), 'project'),
		piExtensions(join(context.home, '.pi', 'agent', 'extensions'), 'user'),
		piExtensions(join(context.cwd, '.pi', 'extensions'), 'project'),
	]);
	return {
		hooks: sources.flatMap(source => source.hooks)
			.sort((left, right) => left.provider.localeCompare(right.provider) || basename(left.sourcePath).localeCompare(basename(right.sourcePath)) || left.event.localeCompare(right.event)),
		diagnostics: sources.flatMap(source => source.diagnostic === undefined ? [] : [source.diagnostic]),
	};
}

export async function editHook(
	context: ResourceContext,
	runtime: ResourceRuntime,
	id: string,
): Promise<void> {
	const hook = (await scanHooks(context)).hooks.find(candidate => candidate.id === id);
	if (hook === undefined) {
		throw new Error(`HOOK_NOT_FOUND: ${id}`);
	}
	await runtime.openEditor(hook.sourcePath);
}

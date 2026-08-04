import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {basename, extname, join} from 'node:path';
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
			capability: 'native-interactive',
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
	if (current.capability !== 'native-headless' || current.provider !== 'claude') {
		const instruction = current.provider === 'codex' ? 'codex /plugins' : 'pi config';
		throw new Error(`INTERACTIVE_REQUIRED: use ${instruction} to change ${current.name}`);
	}
	const arguments_ = ['plugin', enabled ? 'enable' : 'disable', current.name];
	if (current.scope !== undefined && current.scope !== 'unknown') {
		arguments_.push('--scope', current.scope);
	}
	const mutation = await runtime.run('claude', arguments_);
	if (mutation.exitCode !== 0) {
		throw new Error(`PLUGIN_CHANGE_FAILED: ${mutation.stderr.trim() || `exit ${mutation.exitCode}`}`);
	}
	const confirmed = (await scanPlugins(context, runtime)).plugins.find(plugin => plugin.id === id);
	const expectedState: PluginState = enabled ? 'enabled' : 'disabled';
	if (confirmed?.state !== expectedState) {
		throw new Error(`PLUGIN_STATE_UNCONFIRMED: expected ${expectedState}`);
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

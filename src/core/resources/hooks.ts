import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, extname, join, relative, resolve, sep} from 'node:path';
import type {HookResource, HookScanResult, HookState, ResourceContext, ResourceDiagnostic, ResourceRuntime, ResourceScope} from './model.js';
import {atomicReplace, booleanField, hasErrorCode, isObject, isUnknownArray, type JsonObject, parseJson, pluginDiagnostic, replaceWithBackupAndConfirmation, scopeField, stringArray, stringField} from './persistence.js';

export type HookPreview = Readonly<{
	sourcePath: string;
	lines: ReadonlyArray<string>;
	truncated: boolean;
}>;

export type HookEditRecovery = Readonly<{
	sourcePath: string;
	backupPath: string;
	editedHash: string;
	mode: number;
}>;

export type HookEditResult =
	| Readonly<{state: 'valid'; sourcePath: string}>
	| Readonly<{state: 'invalid'; sourcePath: string; diagnostic: ResourceDiagnostic; recovery: HookEditRecovery}>;

function hookId(parts: ReadonlyArray<string>): string {
	return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}

function contentsHash(contents: Uint8Array): string {
	return createHash('sha256').update(contents).digest('hex');
}

function terminalSafe(value: string): string {
	return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '�');
}

function hookType(value: unknown): string {
	return isObject(value) ? stringField(value, 'type') ?? 'unknown' : 'unknown';
}

function jsonIdentity(value: unknown): string {
	return JSON.stringify(value) ?? '';
}

function withoutHooks(group: JsonObject): JsonObject {
	return Object.fromEntries(Object.entries(group).filter(([key]) => key !== 'hooks'));
}

function nestedHookId(
	provider: 'claude' | 'codex',
	scope: ResourceScope,
	path: string,
	event: string,
	groupIndex: number,
	hookIndex: number,
	group: JsonObject,
	hook: unknown,
): string {
	return hookId([
		provider,
		scope,
		path,
		event,
		`${groupIndex}`,
		`${hookIndex}`,
		jsonIdentity(withoutHooks(group)),
		jsonIdentity(hook),
	]);
}

function flatHookId(scope: ResourceScope, path: string, event: string, index: number, hook: JsonObject): string {
	return hookId(['codex', scope, path, event, `${index}`, jsonIdentity(hook)]);
}

function disabledHookId(activeId: string): string {
	return hookId(['disabled', activeId]);
}

function eventHooks(
	provider: 'claude' | 'codex',
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
					id: nestedHookId(provider, scope, path, event, groupIndex, hookIndex, group, hook),
					provider,
					scope,
					event,
					type: hookType(hook),
					state: 'enabled',
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
	if (!isObject(value)) {
		return [];
	}
	if (isObject(value['hooks'])) {
		return eventHooks('codex', value, path, scope);
	}
	if (!isUnknownArray(value['hooks'])) {
		return [];
	}
	return value['hooks'].flatMap((hook, index) => {
		if (!isObject(hook)) {
			return [];
		}
		const event = stringField(hook, 'event') ?? 'unknown';
		return [{
			id: flatHookId(scope, path, event, index, hook),
			provider: 'codex',
			scope,
			event,
			type: stringField(hook, 'type') ?? (stringField(hook, 'command') === undefined ? 'unknown' : 'command'),
			state: 'enabled',
			sourcePath: path,
			capability: 'config-edit',
		}];
	});
}

function pluginRoot(home: string, plugin: JsonObject): string | undefined {
	const marketplace = stringField(plugin, 'marketplaceName');
	const name = stringField(plugin, 'name');
	const version = stringField(plugin, 'version');
	if (marketplace !== undefined && name !== undefined && version !== undefined) {
		return join(home, '.codex', 'plugins', 'cache', marketplace, name, version);
	}
	const source = plugin['source'];
	return isObject(source) ? stringField(source, 'path') : undefined;
}

function containedPath(root: string, child: string): string | undefined {
	const path = resolve(root, child);
	const offset = relative(root, path);
	return offset === '..' || offset.startsWith(`..${sep}`) ? undefined : path;
}

async function codexPluginHooks(
	context: ResourceContext,
	runtime: ResourceRuntime,
): Promise<HookScanResult> {
	const inventory = await runtime.run('codex', ['plugin', 'list', '--json']);
	if (inventory.exitCode !== 0) {
		return {hooks: [], diagnostics: [pluginDiagnostic('codex', inventory.stderr.trim() || `exit ${inventory.exitCode}`)]};
	}
	let value: unknown;
	try {
		value = parseJson(inventory.stdout);
	} catch (error: unknown) {
		return {hooks: [], diagnostics: [pluginDiagnostic('codex', error instanceof Error ? error.message : 'invalid plugin inventory')]};
	}
	if (!isObject(value) || !isUnknownArray(value['installed'])) {
		return {hooks: [], diagnostics: [pluginDiagnostic('codex', 'expected an installed JSON array')]};
	}
	const sources = await Promise.all(value['installed'].flatMap(plugin => {
		if (!isObject(plugin) || booleanField(plugin, 'enabled') !== true) {
			return [];
		}
		const root = pluginRoot(context.home, plugin);
		if (root === undefined) {
			return [];
		}
		return [readCodexPluginHooks(root, scopeField(plugin['scope']) ?? 'user')];
	}));
	return {
		hooks: sources.flatMap(source => source.hooks),
		diagnostics: sources.flatMap(source => source.diagnostic === undefined ? [] : [source.diagnostic]),
	};
}

async function readCodexPluginHooks(
	root: string,
	scope: ResourceScope,
): Promise<Readonly<{hooks: ReadonlyArray<HookResource>; diagnostic: ResourceDiagnostic | undefined}>> {
	const manifestPath = join(root, '.codex-plugin', 'plugin.json');
	try {
		const manifest = parseJson(await readFile(manifestPath, 'utf8'));
		if (!isObject(manifest)) {
			return {hooks: [], diagnostic: {provider: 'codex', path: manifestPath, message: 'invalid plugin manifest'}};
		}
		const configured = stringField(manifest, 'hooks') ?? 'hooks/hooks.json';
		const path = containedPath(root, configured);
		if (path === undefined) {
			return {hooks: [], diagnostic: {provider: 'codex', path: manifestPath, message: 'hook path escapes plugin root'}};
		}
		const result = await jsonHooks('codex', path, scope);
		return {
			hooks: result.hooks.map(hook => ({...hook, capability: 'unsupported'})),
			diagnostic: result.diagnostic,
		};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return {hooks: [], diagnostic: undefined};
		}
		return {hooks: [], diagnostic: {provider: 'codex', path: manifestPath, message: error instanceof Error ? error.message : 'read failed'}};
	}
}

async function jsonHooks(
	provider: 'claude' | 'codex',
	path: string,
	scope: ResourceScope,
): Promise<Readonly<{hooks: ReadonlyArray<HookResource>; diagnostic: ResourceDiagnostic | undefined}>> {
	try {
		const value = parseJson(await readFile(path, 'utf8'));
		return {
			hooks: provider === 'claude' ? eventHooks('claude', value, path, scope) : codexHooks(value, path, scope),
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

async function piExtensionOverrides(settingsPath: string): Promise<ReadonlyArray<string>> {
	try {
		const value = parseJson(await readFile(settingsPath, 'utf8'));
		return isObject(value) ? stringArray(value['extensions']) : [];
	} catch (error: unknown) {
		return hasErrorCode(error, 'ENOENT') ? [] : [];
	}
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
	return isUnknownArray(value) && value.every(item => typeof item === 'string');
}

function piExtensionSpec(extensionRoot: string, sourcePath: string): string {
	const selectedPath = basename(sourcePath).startsWith('index.') ? dirname(sourcePath) : sourcePath;
	return relative(dirname(extensionRoot), selectedPath).split(sep).join('/');
}

function piExtensionState(overrides: ReadonlyArray<string>, spec: string): HookState {
	const match = [...overrides].reverse().find(value => value.replace(/^[+!-]/u, '') === spec);
	return match?.startsWith('-') === true || match?.startsWith('!') === true ? 'disabled' : 'enabled';
}

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
		const overrides = await piExtensionOverrides(join(dirname(path), 'settings.json'));
		return {
			hooks: sourcePaths.map(sourcePath => {
				const spec = piExtensionSpec(path, sourcePath);
				return {
					id: hookId(['pi', scope, sourcePath]),
					provider: 'pi',
					scope,
					event: 'Extension',
					type: 'extension',
					state: piExtensionState(overrides, spec),
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

type DisabledHookLocation =
	| Readonly<{format: 'nested'; groupIndex: number; hookIndex: number; group: JsonObject}>
	| Readonly<{format: 'flat'; index: number}>;

type DisabledHookRecord = Readonly<{
	version: 1;
	id: string;
	provider: 'claude' | 'codex';
	scope: ResourceScope;
	event: string;
	type: string;
	sourcePath: string;
	hook: JsonObject;
	location: DisabledHookLocation;
}>;

function resourceScope(value: unknown): ResourceScope | undefined {
	return value === 'user' || value === 'project' || value === 'local' || value === 'unknown' ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function disabledHookRecord(value: unknown): DisabledHookRecord | undefined {
	if (!isObject(value) || value['version'] !== 1 || !isObject(value['hook']) || !isObject(value['location'])) {
		return undefined;
	}
	const id = stringField(value, 'id');
	const provider = value['provider'];
	const scope = resourceScope(value['scope']);
	const event = stringField(value, 'event');
	const type = stringField(value, 'type');
	const sourcePath = stringField(value, 'sourcePath');
	const format = stringField(value['location'], 'format');
	if (id === undefined || !/^[a-f0-9]{16}$/u.test(id) || (provider !== 'claude' && provider !== 'codex') || scope === undefined || event === undefined || type === undefined || sourcePath === undefined) {
		return undefined;
	}
	if (format === 'flat') {
		const index = nonNegativeInteger(value['location']['index']);
		return index === undefined ? undefined : {version: 1, id, provider, scope, event, type, sourcePath, hook: value['hook'], location: {format, index}};
	}
	if (format === 'nested' && isObject(value['location']['group'])) {
		const groupIndex = nonNegativeInteger(value['location']['groupIndex']);
		const hookIndex = nonNegativeInteger(value['location']['hookIndex']);
		return groupIndex === undefined || hookIndex === undefined ? undefined : {
			version: 1, id, provider, scope, event, type, sourcePath, hook: value['hook'],
			location: {format, groupIndex, hookIndex, group: value['location']['group']},
		};
	}
	return undefined;
}

async function disabledHooks(context: ResourceContext): Promise<Readonly<{hooks: ReadonlyArray<HookResource>; diagnostics: ReadonlyArray<ResourceDiagnostic>}>> {
	const directory = join(context.home, '.amc', 'disabled-hooks');
	try {
		const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
		const hooks: HookResource[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		for (const name of names) {
			const path = join(directory, name);
			try {
				const record = disabledHookRecord(parseJson(await readFile(path, 'utf8')));
				if (record === undefined) {
					diagnostics.push({provider: 'codex', path, message: 'invalid disabled hook record'});
					continue;
				}
				hooks.push({...record, state: 'disabled', capability: 'config-edit'});
			} catch (error: unknown) {
				diagnostics.push({provider: 'codex', path, message: error instanceof Error ? error.message : 'read failed'});
			}
		}
		return {hooks, diagnostics};
	} catch (error: unknown) {
		return hasErrorCode(error, 'ENOENT')
			? {hooks: [], diagnostics: []}
			: {hooks: [], diagnostics: [{provider: 'codex', path: directory, message: error instanceof Error ? error.message : 'read failed'}]};
	}
}

export async function scanHooks(context: ResourceContext, runtime: ResourceRuntime): Promise<HookScanResult> {
	const sources = await Promise.all([
		jsonHooks('claude', join(context.home, '.claude', 'settings.json'), 'user'),
		jsonHooks('claude', join(context.cwd, '.claude', 'settings.json'), 'project'),
		jsonHooks('claude', join(context.cwd, '.claude', 'settings.local.json'), 'local'),
		jsonHooks('codex', join(context.home, '.codex', 'hooks.json'), 'user'),
		jsonHooks('codex', join(context.cwd, '.codex', 'hooks.json'), 'project'),
		piExtensions(join(context.home, '.pi', 'agent', 'extensions'), 'user'),
		piExtensions(join(context.cwd, '.pi', 'extensions'), 'project'),
	]);
	const [pluginHooks, parked] = await Promise.all([codexPluginHooks(context, runtime), disabledHooks(context)]);
	return {
		hooks: [...sources.flatMap(source => source.hooks), ...pluginHooks.hooks, ...parked.hooks]
			.sort((left, right) => left.provider.localeCompare(right.provider) || basename(left.sourcePath).localeCompare(basename(right.sourcePath)) || left.event.localeCompare(right.event)),
		diagnostics: [...sources.flatMap(source => source.diagnostic === undefined ? [] : [source.diagnostic]), ...pluginHooks.diagnostics, ...parked.diagnostics],
	};
}

function removeJsonHook(value: JsonObject, selected: HookResource): Readonly<{next: JsonObject; record: DisabledHookRecord}> {
	if (selected.provider === 'pi') {
		throw new Error(`HOOK_CHANGE_FAILED: ${selected.id} is not a JSON hook`);
	}
	const hooksValue = value['hooks'];
	if (isObject(hooksValue)) {
		const groups = hooksValue[selected.event];
		if (!isUnknownArray(groups)) {
			throw new Error(`HOOK_NOT_FOUND: ${selected.id}`);
		}
		for (const [groupIndex, groupValue] of groups.entries()) {
			if (!isObject(groupValue) || !isUnknownArray(groupValue['hooks'])) {
				continue;
			}
			for (const [hookIndex, hookValue] of groupValue['hooks'].entries()) {
				if (!isObject(hookValue) || nestedHookId(
					selected.provider,
					selected.scope,
					selected.sourcePath,
					selected.event,
					groupIndex,
					hookIndex,
					groupValue,
					hookValue,
				) !== selected.id) {
					continue;
				}
				const nextGroup = {...groupValue, hooks: groupValue['hooks'].filter((_, index) => index !== hookIndex)};
				const nextGroups = nextGroup.hooks.length === 0
					? groups.filter((_, index) => index !== groupIndex)
					: groups.map((group, index) => index === groupIndex ? nextGroup : group);
				return {
					next: {...value, hooks: {...hooksValue, [selected.event]: nextGroups}},
					record: {
						version: 1, id: disabledHookId(selected.id), provider: selected.provider, scope: selected.scope, event: selected.event,
						type: selected.type, sourcePath: selected.sourcePath, hook: hookValue,
						location: {format: 'nested', groupIndex, hookIndex, group: withoutHooks(groupValue)},
					},
				};
			}
		}
	}
	if (selected.provider === 'codex' && isUnknownArray(hooksValue)) {
		for (const [index, hookValue] of hooksValue.entries()) {
			if (!isObject(hookValue)) {
				continue;
			}
			const event = stringField(hookValue, 'event') ?? 'unknown';
			if (flatHookId(selected.scope, selected.sourcePath, event, index, hookValue) === selected.id) {
				return {
					next: {...value, hooks: hooksValue.filter((_, hookIndex) => hookIndex !== index)},
					record: {version: 1, id: disabledHookId(selected.id), provider: 'codex', scope: selected.scope, event, type: selected.type, sourcePath: selected.sourcePath, hook: hookValue, location: {format: 'flat', index}},
				};
			}
		}
	}
	throw new Error(`HOOK_NOT_FOUND: ${selected.id}`);
}

function insertAt<T>(values: ReadonlyArray<T>, index: number, value: T): ReadonlyArray<T> {
	return [...values.slice(0, index), value, ...values.slice(index)];
}

function restoreJsonHook(value: JsonObject, record: DisabledHookRecord): Readonly<{next: JsonObject; activeId: string}> {
	const hooksValue = value['hooks'];
	if (record.location.format === 'flat') {
		const hooks = isUnknownArray(hooksValue) ? hooksValue : [];
		const index = Math.min(record.location.index, hooks.length);
		return {
			next: {...value, hooks: insertAt(hooks, index, record.hook)},
			activeId: flatHookId(record.scope, record.sourcePath, record.event, index, record.hook),
		};
	}
	const location = record.location;
	const hooks = isObject(hooksValue) ? hooksValue : {};
	const groupsValue = hooks[record.event];
	const groups = isUnknownArray(groupsValue) ? groupsValue : [];
	const matchingGroupIndex = groups.findIndex(group => isObject(group) && jsonIdentity(withoutHooks(group)) === jsonIdentity(location.group));
	if (matchingGroupIndex >= 0) {
		const group = groups[matchingGroupIndex];
		if (!isObject(group)) {
			throw new Error(`HOOK_RESTORE_FAILED: invalid group for ${record.id}`);
		}
		const groupHooks = isUnknownArray(group['hooks']) ? group['hooks'] : [];
		const hookIndex = Math.min(location.hookIndex, groupHooks.length);
		const restoredGroup = {...group, hooks: insertAt(groupHooks, hookIndex, record.hook)};
		return {
			next: {...value, hooks: {...hooks, [record.event]: groups.map((item, index) => index === matchingGroupIndex ? restoredGroup : item)}},
			activeId: nestedHookId(record.provider, record.scope, record.sourcePath, record.event, matchingGroupIndex, hookIndex, restoredGroup, record.hook),
		};
	}
	const groupIndex = Math.min(location.groupIndex, groups.length);
	const restoredGroup = {...location.group, hooks: [record.hook]};
	return {
		next: {...value, hooks: {...hooks, [record.event]: insertAt(groups, groupIndex, restoredGroup)}},
		activeId: nestedHookId(record.provider, record.scope, record.sourcePath, record.event, groupIndex, 0, restoredGroup, record.hook),
	};
}

async function updatePiHook(context: ResourceContext, hook: HookResource, enabled: boolean, confirm: () => Promise<boolean>): Promise<void> {
	const extensionRoot = hook.scope === 'user' ? join(context.home, '.pi', 'agent', 'extensions') : join(context.cwd, '.pi', 'extensions');
	const settingsPath = join(dirname(extensionRoot), 'settings.json');
	try {
		await stat(settingsPath);
	} catch (error: unknown) {
		if (!hasErrorCode(error, 'ENOENT')) {
			throw error;
		}
		await mkdir(dirname(settingsPath), {recursive: true});
		await writeFile(settingsPath, '{}\n', {encoding: 'utf8', flag: 'wx'});
	}
	const original = await readFile(settingsPath, 'utf8');
	const value = parseJson(original);
	if (!isObject(value) || (value['extensions'] !== undefined && !isStringArray(value['extensions']))) {
		throw new Error(`HOOK_CHANGE_FAILED: ${settingsPath} must contain an object with an extensions array of strings`);
	}
	const spec = piExtensionSpec(extensionRoot, hook.sourcePath);
	const current = value['extensions'] ?? [];
	const extensions = [...current.filter(item => item.replace(/^[+!-]/u, '') !== spec), `${enabled ? '+' : '-'}${spec}`];
	await replaceWithBackupAndConfirmation(settingsPath, original, `${JSON.stringify({...value, extensions}, undefined, 2)}\n`, 'HOOK_STATE_UNCONFIRMED', confirm);
}

export async function setHookEnabled(
	context: ResourceContext,
	runtime: ResourceRuntime,
	id: string,
	enabled: boolean,
): Promise<HookResource> {
	const current = (await scanHooks(context, runtime)).hooks.find(hook => hook.id === id);
	if (current === undefined) {
		throw new Error(`HOOK_NOT_FOUND: ${id}`);
	}
	if (current.state === (enabled ? 'enabled' : 'disabled')) {
		return current;
	}
	if (current.capability !== 'config-edit') {
		throw new Error(`HOOK_CHANGE_FAILED: ${current.sourcePath} is a provider-managed plugin cache`);
	}
	let confirmedId = id;
	if (current.provider === 'pi') {
		const confirm = async (): Promise<boolean> => (await scanHooks(context, runtime)).hooks
			.some(hook => hook.id === id && hook.state === (enabled ? 'enabled' : 'disabled'));
		await updatePiHook(context, current, enabled, confirm);
	} else {
		const directory = join(context.home, '.amc', 'disabled-hooks');
		if (enabled) {
			const recordPath = join(directory, `${id}.json`);
			const record = disabledHookRecord(parseJson(await readFile(recordPath, 'utf8')));
			if (record === undefined) {
				throw new Error(`HOOK_RESTORE_FAILED: invalid record for ${id}`);
			}
			const original = await readFile(record.sourcePath, 'utf8');
			const value = parseJson(original);
			if (!isObject(value)) {
				throw new Error(`HOOK_RESTORE_FAILED: ${record.sourcePath} is not a JSON object`);
			}
			const restored = restoreJsonHook(value, record);
			confirmedId = restored.activeId;
			const confirm = async (): Promise<boolean> => (await scanHooks(context, runtime)).hooks
				.some(hook => hook.id === restored.activeId && hook.state === 'enabled');
			const archivePath = `${recordPath}.restored-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
			await rename(recordPath, archivePath);
			try {
				await replaceWithBackupAndConfirmation(record.sourcePath, original, `${JSON.stringify(restored.next, undefined, 2)}\n`, 'HOOK_STATE_UNCONFIRMED', confirm);
			} catch (error: unknown) {
				await rename(archivePath, recordPath);
				throw error;
			}
		} else {
			const original = await readFile(current.sourcePath, 'utf8');
			const value = parseJson(original);
			if (!isObject(value)) {
				throw new Error(`HOOK_CHANGE_FAILED: ${current.sourcePath} is not a JSON object`);
			}
			const removed = removeJsonHook(value, current);
			confirmedId = removed.record.id;
			const recordPath = join(directory, `${removed.record.id}.json`);
			const confirm = async (): Promise<boolean> => (await scanHooks(context, runtime)).hooks
				.some(hook => hook.id === removed.record.id && hook.state === 'disabled');
			await mkdir(directory, {recursive: true});
			await writeFile(recordPath, `${JSON.stringify(removed.record, undefined, 2)}\n`, {encoding: 'utf8', flag: 'wx', mode: 0o600});
			try {
				await replaceWithBackupAndConfirmation(current.sourcePath, original, `${JSON.stringify(removed.next, undefined, 2)}\n`, 'HOOK_STATE_UNCONFIRMED', confirm);
			} catch (error: unknown) {
				await rename(recordPath, `${recordPath}.failed-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
				throw error;
			}
		}
	}
	const confirmed = (await scanHooks(context, runtime)).hooks.find(hook => hook.id === confirmedId);
	if (confirmed?.state !== (enabled ? 'enabled' : 'disabled')) {
		throw new Error(`HOOK_STATE_UNCONFIRMED: expected ${enabled ? 'enabled' : 'disabled'}`);
	}
	return confirmed;
}

async function selectedHook(
	context: ResourceContext,
	runtime: ResourceRuntime,
	id: string,
): Promise<HookResource> {
	const hook = (await scanHooks(context, runtime)).hooks.find(candidate => candidate.id === id);
	if (hook === undefined) {
		throw new Error(`HOOK_NOT_FOUND: ${id}`);
	}
	return hook;
}

export async function readHookPreview(
	context: ResourceContext,
	runtime: ResourceRuntime,
	id: string,
	maxBytes = 1_048_576,
): Promise<HookPreview> {
	const hook = await selectedHook(context, runtime, id);
	const handle = await open(hook.sourcePath, 'r');
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
		const truncated = bytesRead > maxBytes;
		const contents = new TextDecoder().decode(buffer.subarray(0, Math.min(bytesRead, maxBytes)));
		return {sourcePath: hook.sourcePath, lines: terminalSafe(contents).split(/\r?\n/u), truncated};
	} finally {
		await handle.close();
	}
}

export async function editHook(
	context: ResourceContext,
	runtime: ResourceRuntime,
	id: string,
): Promise<HookEditResult> {
	const hook = await selectedHook(context, runtime, id);
	if (hook.capability !== 'config-edit') {
		throw new Error(`HOOK_EDIT_UNSUPPORTED: ${id}`);
	}
	const original = await readFile(hook.sourcePath);
	const mode = (await stat(hook.sourcePath)).mode & 0o777;
	const backupPath = `${hook.sourcePath}.amc-edit-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
	await writeFile(backupPath, original, {flag: 'wx', mode: 0o600});
	await runtime.openEditor(hook.sourcePath);
	const edited = await readFile(hook.sourcePath);
	const result = await scanHooks(context, runtime);
	const diagnostic = result.diagnostics.find(candidate => candidate.path === hook.sourcePath);
	if (diagnostic === undefined) {
		return {state: 'valid', sourcePath: hook.sourcePath};
	}
	return {
		state: 'invalid',
		sourcePath: hook.sourcePath,
		diagnostic,
		recovery: {sourcePath: hook.sourcePath, backupPath, editedHash: contentsHash(edited), mode},
	};
}

export async function restoreHookEdit(recovery: HookEditRecovery): Promise<void> {
	const current = await readFile(recovery.sourcePath);
	if (contentsHash(current) !== recovery.editedHash) {
		throw new Error('HOOK_EDIT_CHANGED: source changed after the failed edit.');
	}
	const original = await readFile(recovery.backupPath, 'utf8');
	await atomicReplace(recovery.sourcePath, original, recovery.mode);
}

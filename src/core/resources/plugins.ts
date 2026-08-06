import {join} from 'node:path';
import type {Target} from '../model.js';
import type {PluginResource, PluginScanResult, PluginState, ResourceContext, ResourceDiagnostic, ResourceRuntime, ResourceScope} from './model.js';
import {booleanField, isObject, isUnknownArray, parseJson, pluginDiagnostic, scopeField, stringField, updateTomlBooleanWithConfirmation} from './persistence.js';

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
				state: 'installed',
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


import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {McpScanResult, McpServerResource, ResourceContext, ResourceDiagnostic, ResourceRuntime, ResourceScope} from './model.js';
import {booleanField, hasErrorCode, isObject, isUnknownArray, type JsonObject, parseJson, pluginDiagnostic, readJsonObject, replaceWithBackupAndConfirmation, stringArray, stringField, transportField, updateTomlBooleanWithConfirmation} from './persistence.js';

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


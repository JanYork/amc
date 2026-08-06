import type {Target} from '../model.js';

export type ManagementCapability =
	| 'native-headless'
	| 'native-interactive'
	| 'config-edit'
	| 'unsupported';

export type PluginState = 'enabled' | 'disabled' | 'installed' | 'unknown';
export type HookState = 'enabled' | 'disabled';
export type McpState = 'enabled' | 'disabled' | 'unknown';
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
	state: HookState;
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
	state: McpState;
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


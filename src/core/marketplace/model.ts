export type MarketplaceResponse = Readonly<{
	status: number;
	url: string;
	body: Uint8Array;
}>;

export type MarketplaceRuntime = Readonly<{
	get: (url: string, maximumBytes?: number, timeoutMs?: number) => Promise<MarketplaceResponse>;
}>;

export type SkillManifest = Readonly<{
	name: string;
	description: string;
}>;

export type RepositoryCoordinate = Readonly<{
	owner: string;
	repository: string;
	branch: string;
	commit: string;
}>;

export type RemoteSkillFile = Readonly<{
	path: string;
	size: number;
	executable: boolean;
}>;

export type RemoteSkill = Readonly<{
	name: string;
	description: string;
	relativePath: string;
	files: ReadonlyArray<RemoteSkillFile>;
}>;

export type RepositoryScan = Readonly<{
	repository: RepositoryCoordinate;
	skills: ReadonlyArray<RemoteSkill>;
	diagnostics: ReadonlyArray<string>;
}>;

export type SkillsShLead = Readonly<{
	id: string;
	name: string;
	skillId: string;
	source: string;
	installs: number;
}>;

export type SkillsShPage = Readonly<{
	items: ReadonlyArray<SkillsShLead>;
	page: number;
	total: number;
	hasMore: boolean;
}>;

export type MarketplaceRepository = Readonly<{
	enabled: boolean;
	addedAt: string;
	scan: RepositoryScan;
}>;

export type MarketplaceState = Readonly<{
	schemaVersion: 1;
	repositories: ReadonlyArray<MarketplaceRepository>;
}>;

export type MarketplaceItem = Readonly<{
	name: string;
	description: string | undefined;
	source: string;
	branch: string | undefined;
	relativePath: string | undefined;
	commit: string | undefined;
	installs: number | undefined;
	freshness: 'cached' | 'live';
}>;

export type MarketplaceSearchResult = Readonly<{
	items: ReadonlyArray<MarketplaceItem>;
	diagnostics: ReadonlyArray<string>;
}>;

export type MarketplaceFeaturedPage = Readonly<{
	items: ReadonlyArray<MarketplaceItem>;
	page: number;
	total: number;
	hasMore: boolean;
}>;

export type InstallationRecord = Readonly<{
	owner: string;
	repository: string;
	branch: string;
	relativePath: string;
	commit: string;
	installedHash: string;
	installedAt: string;
	updatedAt: string;
}>;

export type InstallResult = Readonly<{
	state: 'installed' | 'unchanged';
	record: InstallationRecord;
}>;

export type InstallHooks = Readonly<{
	afterMove?: (path: string) => Promise<void>;
}>;

export type UpgradeResult = Readonly<{
	state: 'unchanged' | 'metadata-updated' | 'updated';
	record: InstallationRecord;
}>;

export type UpgradeHooks = Readonly<{
	afterReplace?: (path: string) => Promise<void>;
}>;

export type DeleteSlot = Readonly<{
	relativePath: string;
	expectedKind: 'directory' | 'file' | 'symlink';
	expectedValue: string;
}>;

export type PermanentDeletePlan = Readonly<{
	operationId: string;
	name: string;
	challenge: string;
	planDigest: string;
	slots: ReadonlyArray<DeleteSlot>;
	foreignPaths: ReadonlyArray<string>;
	localDrift: boolean;
	record: InstallationRecord | null;
	journalPath: string;
}>;

export type PermanentDeleteResult = Readonly<{
	state: 'deleted';
	operationId: string;
	removed: number;
}>;

export type PermanentDeleteHooks = Readonly<{
	afterRemove?: (index: number) => Promise<void>;
}>;

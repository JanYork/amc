export type Target = 'claude' | 'pi' | 'codex';
export type SkillSource = 'agents' | 'agent' | Target;
export type ReconcileChoice = SkillSource | 'canonical';

export type AmcPaths = Readonly<{
	root: string;
	skills: string;
	backups: string;
	disabledLinks: string;
	staging: string;
	failed: string;
	marketplace: string;
	skillsLock: string;
	deleteJournals: string;
	reconcileJournals: string;
	credentials: string;
	githubAuth: string;
	githubToken: string;
}>;

export type TargetPaths = Readonly<Record<Target, string>>;
export type SkillSourcePaths = Readonly<Record<SkillSource, string>>;

export type Layout = Readonly<{
	home: string;
	amc: AmcPaths;
	targets: TargetPaths;
	sources: SkillSourcePaths;
}>;

export type TargetState = 'enabled' | 'disabled' | 'shared' | 'unmanaged' | 'conflict';

export type Skill = Readonly<{
	name: string;
	canonical: boolean;
	states: Readonly<Record<Target, TargetState>>;
}>;

export type SkillDetails = Readonly<{
	name: string;
	description: string;
	sourcePath: string;
}>;

export type Diagnostic = Readonly<{
	path: string;
	message: string;
}>;

export type ScanResult = Readonly<{
	skills: ReadonlyArray<Skill>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>;

export type TargetChange = Readonly<{
	target: Target;
	before: 'enabled' | 'disabled';
	after: 'enabled' | 'disabled';
	changed: boolean;
}>;

export type ToggleResult = Readonly<{
	operationId: string;
	name: string;
	changes: ReadonlyArray<TargetChange>;
}>;

export type ReconcileStatus = 'managed' | 'ready' | 'conflict' | 'blocked';

export type ReconcileSource = Readonly<{
	source: SkillSource;
	path: string;
	kind: 'directory' | 'managed-link' | 'foreign-link' | 'broken-link' | 'invalid';
	fingerprint: string | undefined;
	providers: ReadonlyArray<Target>;
}>;

export type ReconcileBlocker = Readonly<{
	code: 'CANONICAL_CONFLICT' | 'CONTENT_DIVERGENCE' | 'CROSS_DEVICE' | 'FOREIGN_LINK' | 'SOURCE_CONFLICT' | 'NO_SOURCE';
	path: string;
	message: string;
}>;

export type ReconcileCanonical =
	| Readonly<{state: 'missing'; path: string; fingerprint: undefined}>
	| Readonly<{state: 'valid'; path: string; fingerprint: string | undefined}>
	| Readonly<{state: 'conflict'; path: string; fingerprint: undefined}>;

export type SkillReconcilePlan = Readonly<{
	name: string;
	status: ReconcileStatus;
	canonical: ReconcileCanonical;
	sources: ReadonlyArray<ReconcileSource>;
	providers: ReadonlyArray<Target>;
	selectedSource: SkillSource | undefined;
	blockers: ReadonlyArray<ReconcileBlocker>;
}>;

export type ReconcileHooks = Readonly<{
	afterMove?: (index: number) => Promise<void>;
	afterLink?: (index: number) => Promise<void>;
}>;

export type SkillReconcileResult = Readonly<{
	operationId: string;
	name: string;
	canonicalPath: string;
	backupRoot: string;
	archivedSources: ReadonlyArray<string>;
	linkedTargets: ReadonlyArray<Target>;
}>;

export type ReconciliationPlan = Readonly<{
	items: ReadonlyArray<SkillReconcilePlan>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>;

export type ReconciliationFailure = Readonly<{
	name: string;
	code: AmcErrorCode | 'UNEXPECTED';
	message: string;
	path: string;
}>;

export type ReconciliationResult = Readonly<{
	reconciled: ReadonlyArray<SkillReconcileResult>;
	managed: ReadonlyArray<string>;
	conflicts: ReadonlyArray<string>;
	blocked: ReadonlyArray<string>;
	pending: ReadonlyArray<string>;
	diagnostics: ReadonlyArray<Diagnostic>;
	failure: ReconciliationFailure | undefined;
}>;

export type MigrationSource = Readonly<{
	target: Target;
	path: string;
	contentPath: string;
	kind: 'directory' | 'foreign-link';
	linkText: string | undefined;
	fingerprint: string;
}>;

export type MigrationBlocker = Readonly<{
	code: 'CANONICAL_CONFLICT' | 'CANONICAL_DIFFERENCE' | 'TARGET_CONFLICT' | 'NO_SOURCE';
	path: string;
	message: string;
}>;

export type MigrationCanonical =
	| Readonly<{state: 'missing'; path: string}>
	| Readonly<{state: 'valid'; path: string; fingerprint: string}>
	| Readonly<{state: 'conflict'; path: string}>;

export type MigrationTarget =
	| Readonly<{target: Target; state: 'disabled'; path: string}>
	| Readonly<{target: Target; state: 'enabled'; path: string; linkText: string}>
	| Readonly<{
		target: Target;
		state: 'unmanaged';
		path: string;
		kind: 'directory' | 'foreign-link';
		contentPath: string;
		linkText: string | undefined;
		fingerprint: string;
	}>
	| Readonly<{
		target: Target;
		state: 'conflict';
		path: string;
		kind: 'broken-link' | 'invalid';
		contentPath: string | undefined;
		linkText: string | undefined;
	}>;

export type MigrationPlan = Readonly<{
	name: string;
	canonical: MigrationCanonical;
	targets: ReadonlyArray<MigrationTarget>;
	sources: ReadonlyArray<MigrationSource>;
	blockers: ReadonlyArray<MigrationBlocker>;
	sourceRequired: boolean;
}>;

export type MigrationBackup = Readonly<{
	target: Target;
	path: string;
}>;

export type MigrationResult = Readonly<{
	operationId: string;
	name: string;
	canonicalPath: string;
	backupRoot: string | undefined;
	backups: ReadonlyArray<MigrationBackup>;
	linkedTargets: ReadonlyArray<Target>;
}>;

export type AmcErrorCode =
	| 'INVALID_SKILL_NAME'
	| 'CANONICAL_MISSING'
	| 'TARGET_BLOCKED'
	| 'PARKING_BLOCKED'
	| 'OPERATION_FAILED'
	| 'ROLLBACK_FAILED'
	| 'SOURCE_REQUIRED'
	| 'SOURCE_INVALID'
	| 'MIGRATION_BLOCKED'
	| 'STALE_PLAN'
	| 'MIGRATION_FAILED'
	| 'BULK_MIGRATION_FAILED'
	| 'RECONCILE_BLOCKED'
	| 'STALE_RECONCILE_PLAN'
	| 'RECONCILE_FAILED';

export class AmcError extends Error {
	readonly code: AmcErrorCode;
	readonly path: string;

	constructor(code: AmcErrorCode, message: string, path: string) {
		super(message);
		this.name = 'AmcError';
		this.code = code;
		this.path = path;
	}
}

export type BulkMigrationStatus = 'ready' | 'managed' | 'divergent' | 'blocked';

export type BulkMigrationItem = Readonly<{
	name: string;
	status: BulkMigrationStatus;
	plan: MigrationPlan;
}>;

export type BulkMigrationPlan = Readonly<{
	items: ReadonlyArray<BulkMigrationItem>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>;

export type BulkMigrationFailure = Readonly<{
	name: string;
	code: AmcErrorCode | 'UNEXPECTED';
	message: string;
	path: string;
}>;

export type BulkMigrationResult = Readonly<{
	migrated: ReadonlyArray<MigrationResult>;
	managed: ReadonlyArray<string>;
	divergent: ReadonlyArray<string>;
	blocked: ReadonlyArray<string>;
	pending: ReadonlyArray<string>;
	diagnostics: ReadonlyArray<Diagnostic>;
	failure: BulkMigrationFailure | undefined;
}>;


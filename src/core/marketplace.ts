export {
	configureGitHubOAuth,
	configureGitHubToken,
	inspectGitHubAuthentication,
	resolveGitHubAuthentication,
	type GitHubAuthMethod,
	type GitHubAuthRuntime,
	type GitHubAuthStatus,
	type ResolvedGitHubAuthentication,
} from './marketplace/auth.js';
export {parseSkillManifest} from './marketplace/manifest.js';
export {scanGitHubRepository} from './marketplace/github.js';
export {listPopularSkillsSh, searchSkillsSh} from './marketplace/skills-sh.js';
export {
	addMarketplaceRepository,
	listMarketplaceRepositories,
	refreshMarketplaceRepository,
	removeMarketplaceRepository,
	setMarketplaceRepositoryEnabled,
} from './marketplace/repositories.js';
export {listMarketplaceFeatured, resolveMarketplaceItem, searchMarketplace} from './marketplace/catalog.js';
export {installMarketplaceSkill} from './skills/install.js';
export {upgradeMarketplaceSkill} from './skills/update.js';
export {checkAppliedSkillUpdates, type SkillUpdateState, type SkillUpdateStatus} from './skills/update-check.js';
export {permanentlyDeleteSkill, planPermanentDelete} from './skills/permanent-delete.js';
export {readInstalledSkills} from './skills/provenance.js';
export type {
	InstallationRecord,
	InstallHooks,
	InstallResult,
	MarketplaceFeaturedPage,
	MarketplaceItem,
	MarketplaceRepository,
	MarketplaceResponse,
	MarketplaceRuntime,
	MarketplaceSearchResult,
	DeleteSlot,
	PermanentDeleteHooks,
	PermanentDeletePlan,
	PermanentDeleteResult,
	RemoteSkill,
	RemoteSkillFile,
	RepositoryCoordinate,
	RepositoryScan,
	SkillManifest,
	SkillsShLead,
	SkillsShPage,
	UpgradeHooks,
	UpgradeResult,
} from './marketplace/model.js';

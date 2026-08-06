import {AmcError, executeBulkMigration, executeMigration, executeReconciliation, executeSkillReconciliation, listSkills, planBulkMigration, planMigration, planReconciliation, planSkillReconciliation, recoverIncompleteReconciliations, setSkillEnabled, type Layout} from '../core/index.js';
import {editHook, scanHooks, scanMcpServers, scanPlugins, setHookEnabled, setMcpServerEnabled, setPluginEnabled, type ResourceContext, type ResourceRuntime} from '../core/resources.js';
import {
	addMarketplaceRepository,
	checkAppliedSkillUpdates,
	configureGitHubOAuth,
	configureGitHubToken,
	inspectGitHubAuthentication,
	installMarketplaceSkill,
	listMarketplaceRepositories,
	permanentlyDeleteSkill,
	planPermanentDelete,
	refreshMarketplaceRepository,
	removeMarketplaceRepository,
	searchMarketplace,
	setMarketplaceRepositoryEnabled,
	upgradeMarketplaceSkill,
	type GitHubAuthRuntime,
	type MarketplaceRuntime,
} from '../core/marketplace.js';
import type {HeadlessCommand, OutputContext} from './commands.js';
import {helpText, version} from './help.js';
import {ansiRole, formatBulkPlan, formatBulkResult, formatList, formatMigration, formatToggle, hookTable, includesSearch, mcpTable, paginate, pluginTable, resourceFooter} from './format.js';

export type ResourceExecution = Readonly<{
	context: ResourceContext;
	runtime: ResourceRuntime;
	marketplace?: MarketplaceRuntime;
	githubAuth?: Readonly<{
		runtime: GitHubAuthRuntime;
		environment: Readonly<Record<string, string | undefined>>;
		readStdin: () => Promise<string>;
		stdinIsTTY: boolean;
	}>;
}>;

function requireResources(resources: ResourceExecution | undefined): ResourceExecution {
	if (resources === undefined) {
		throw new Error('Resource runtime is unavailable.');
	}
	return resources;
}

function requireMarketplace(resources: ResourceExecution | undefined): MarketplaceRuntime {
	const runtime = resources?.marketplace;
	if (runtime === undefined) throw new Error('Marketplace runtime is unavailable.');
	return runtime;
}

function requireGitHubAuth(resources: ResourceExecution | undefined): NonNullable<ResourceExecution['githubAuth']> {
	const auth = resources?.githubAuth;
	if (auth === undefined) throw new Error('GitHub authentication runtime is unavailable.');
	return auth;
}


export async function executeCommand(
	layout: Layout,
	command: HeadlessCommand,
	output: OutputContext = {
		isTTY: false,
		columns: 80,
		presentation: {theme: 'mono', colorDepth: 1},
	},
	resources?: ResourceExecution,
): Promise<string> {
	switch (command.kind) {
		case 'help':
			return helpText;
		case 'version':
			return version;
		case 'list': {
			const result = await listSkills(layout);
			return formatList(result, command, output);
		}
		case 'enable': {
			const result = command.target === undefined
				? await setSkillEnabled(layout, command.name, true)
				: await setSkillEnabled(layout, command.name, true, [command.target]);
			return formatToggle(result, true);
		}
		case 'disable': {
			const result = command.target === undefined
				? await setSkillEnabled(layout, command.name, false)
				: await setSkillEnabled(layout, command.name, false, [command.target]);
			return formatToggle(result, false);
		}
		case 'migrate': {
			const plan = await planMigration(layout, command.name);
			const result = await executeMigration(layout, plan, command.source);
			return formatMigration(result);
		}
		case 'reconcile': {
			if (command.name !== undefined) {
				const recovery = await recoverIncompleteReconciliations(layout);
				if (recovery.failures.length > 0) throw new Error(`Reconciliation recovery blocked at: ${recovery.failures.join(', ')}`);
				const plan = await planSkillReconciliation(layout, command.name);
				const result = await executeSkillReconciliation(layout, plan, command.source);
				return `Reconciled ${result.name}: ${result.linkedTargets.join(', ') || 'no new links'}; backup ${result.backupRoot}`;
			}
			if (!command.apply) {
				const plan = await planReconciliation(layout);
				return [
					`AMC Reconciliation · ${plan.items.length} Skills · ${plan.diagnostics.length} warnings`,
					...plan.items.map(item => `${item.name}\t${item.status}\t${item.providers.join(',') || '-'}\t${item.sources.map(source => source.source).join(',') || '-'}`),
				].join('\n');
			}
			const recovery = await recoverIncompleteReconciliations(layout);
			if (recovery.failures.length > 0) throw new Error(`Reconciliation recovery blocked at: ${recovery.failures.join(', ')}`);
			const result = await executeReconciliation(layout, await planReconciliation(layout));
			if (result.failure !== undefined) {
				throw new AmcError('RECONCILE_FAILED', result.failure.message, result.failure.path);
			}
			return `Reconciled ${result.reconciled.length} Skills; ${result.conflicts.length} conflicts; ${result.blocked.length} blocked.`;
		}
		case 'updates-check': {
			const statuses = await checkAppliedSkillUpdates(layout, requireMarketplace(resources), command.name);
			const mark = (state: (typeof statuses)[number]['state']): string => {
				switch (state) {
					case 'current': return '✓ Current';
					case 'update': return '↑ Update';
					case 'drift': return '~ Drift';
					case 'untracked': return '— Untracked';
					case 'error': return '? Error';
				}
			};
			return [
				`AMC Skill Updates · ${statuses.length} applied · ${statuses.filter(item => item.state === 'update').length} updates`,
				...statuses.map(item => `${item.name}\t${mark(item.state)}${item.message === undefined ? '' : `\t${item.message}`}`),
			].join('\n');
		}
		case 'github-auth-login': {
			const auth = requireGitHubAuth(resources);
			if (!auth.stdinIsTTY) throw new Error('GitHub OAuth login requires an interactive terminal.');
			await configureGitHubOAuth(layout, auth.runtime);
			return 'GitHub authentication configured through gh OAuth.';
		}
		case 'github-auth-token': {
			const auth = requireGitHubAuth(resources);
			if (auth.stdinIsTTY) throw new Error('Refusing to read an echoed Token from a terminal. Pipe it to --token-stdin.');
			await configureGitHubToken(layout, await auth.readStdin());
			return 'GitHub Token configured.';
		}
		case 'github-auth-status': {
			const auth = requireGitHubAuth(resources);
			const status = await inspectGitHubAuthentication(layout, auth.environment, auth.runtime);
			return [
				'GitHub Authentication',
				`Method: ${status.method}`,
				`Status: ${status.valid ? 'valid' : status.method === 'none' ? 'not configured' : 'invalid'}`,
				...(status.valid ? [
					`API rate: ${status.remaining ?? 0} / ${status.limit ?? 0} remaining`,
					`Reset: ${new Date((status.reset ?? 0) * 1000).toISOString()}`,
				] : []),
			].join('\n');
		}
		case 'marketplace-search': {
			const result = await searchMarketplace(layout, requireMarketplace(resources), command.query, command.source);
			return [
				`AMC Marketplace · ${result.items.length} results · ${result.diagnostics.length} warnings`,
				...result.items.map(item => `${item.name}\t${item.source}\t${item.branch ?? 'registry'}\t${item.relativePath ?? 'unresolved'}\t${item.installs ?? 0}`),
				...result.diagnostics.map(diagnostic => `Warning: ${diagnostic}`),
			].join('\n');
		}
		case 'repos-list': {
			const repositories = await listMarketplaceRepositories(layout);
			return repositories.length === 0
				? 'No marketplace repositories configured.'
				: repositories.map(item => `${item.scan.repository.owner}/${item.scan.repository.repository}\t${item.scan.repository.branch}\t${item.scan.skills.length} Skill${item.scan.skills.length === 1 ? '' : 's'}\t${item.enabled ? 'enabled' : 'disabled'}`).join('\n');
		}
		case 'repos-add': {
			const repository = await addMarketplaceRepository(layout, requireMarketplace(resources), command.branch === undefined
				? {source: command.source}
				: {source: command.source, branch: command.branch});
			return `Added ${repository.scan.repository.owner}/${repository.scan.repository.repository}: ${repository.scan.skills.length} Skills`;
		}
		case 'repos-refresh': {
			const repository = await refreshMarketplaceRepository(layout, requireMarketplace(resources), command.source);
			return `Refreshed ${repository.scan.repository.owner}/${repository.scan.repository.repository}: ${repository.scan.skills.length} Skills`;
		}
		case 'repos-remove':
			await removeMarketplaceRepository(layout, command.source);
			return `Removed marketplace repository ${command.source}. Installed Skills were not changed.`;
		case 'repos-enable':
		case 'repos-disable': {
			const enabled = command.kind === 'repos-enable';
			await setMarketplaceRepositoryEnabled(layout, command.source, enabled);
			return `${enabled ? 'Enabled' : 'Disabled'} marketplace repository ${command.source}.`;
		}
		case 'install': {
			const result = await installMarketplaceSkill(layout, requireMarketplace(resources), command.branch === undefined
				? {source: command.source, skill: command.skill}
				: {source: command.source, skill: command.skill, branch: command.branch});
			return `${result.state === 'installed' ? 'Installed' : 'Already installed'} ${command.skill} from ${result.record.owner}/${result.record.repository}:${result.record.relativePath}. Providers remain disabled.`;
		}
		case 'upgrade': {
			const result = await upgradeMarketplaceSkill(layout, requireMarketplace(resources), command.name);
			return `Upgrade ${command.name}: ${result.state}`;
		}
		case 'delete': {
			const plan = await planPermanentDelete(layout, command.name);
			const result = await permanentlyDeleteSkill(layout, plan, {challenge: plan.challenge, name: command.confirmation});
			return `Permanently deleted ${command.name}: ${result.removed} AMC-owned paths removed.`;
		}
		case 'migrate-all': {
			const plan = await planBulkMigration(layout);
			if (!command.apply) {
				return formatBulkPlan(plan);
			}
			const result = await executeBulkMigration(layout, plan);
			const formatted = formatBulkResult(result);
			if (result.failure !== undefined) {
				throw new AmcError('BULK_MIGRATION_FAILED', formatted, result.failure.path);
			}
			return formatted;
		}
		case 'plugins-list': {
			const {context, runtime} = requireResources(resources);
			const result = await scanPlugins(context, runtime);
			const filtered = result.plugins.filter(plugin => includesSearch(`${plugin.name}\n${plugin.provider}`, command.search));
			const page = paginate(filtered, command.page, command.limit, command.all);
			return [
				`${ansiRole('AMC', 'accent', output)} Plugins · ${filtered.length} shown · ${result.diagnostics.length} warnings`,
				'', ...pluginTable(page.rows, output), '', ...resourceFooter(page, 'amc plugins list'),
			].join('\n');
		}
		case 'plugin-enable':
		case 'plugin-disable': {
			const {context, runtime} = requireResources(resources);
			const enabled = command.kind === 'plugin-enable';
			const plugin = await setPluginEnabled(context, runtime, command.id, enabled);
			return `${enabled ? 'Enabled' : 'Disabled'} ${plugin.id}: ${plugin.state}`;
		}
		case 'hooks-list': {
			const {context, runtime} = requireResources(resources);
			const result = await scanHooks(context, runtime);
			const filtered = result.hooks.filter(hook => includesSearch(`${hook.provider}\n${hook.event}\n${hook.type}\n${hook.sourcePath}`, command.search));
			const page = paginate(filtered, command.page, command.limit, command.all);
			return [
				`${ansiRole('AMC', 'accent', output)} Hooks · ${filtered.length} shown · ${result.diagnostics.length} warnings`,
				'', ...hookTable(page.rows, output), '', ...resourceFooter(page, 'amc hooks list'),
			].join('\n');
		}
		case 'hook-edit': {
			const {context, runtime} = requireResources(resources);
			await editHook(context, runtime, command.id);
			return `Edited hook source for ${command.id}.`;
		}
		case 'hook-enable':
		case 'hook-disable': {
			const {context, runtime} = requireResources(resources);
			const enabled = command.kind === 'hook-enable';
			const hook = await setHookEnabled(context, runtime, command.id, enabled);
			return `${enabled ? 'Enabled' : 'Disabled'} ${hook.id}: ${hook.state}`;
		}
		case 'mcp-list': {
			const {context, runtime} = requireResources(resources);
			const result = await scanMcpServers(context, runtime);
			const filtered = result.servers.filter(server => includesSearch(`${server.name}\n${server.provider}\n${server.scope}\n${server.transport}\n${server.state}`, command.search));
			const page = paginate(filtered, command.page, command.limit, command.all);
			return [
				`${ansiRole('AMC', 'accent', output)} MCP · ${filtered.length} shown · ${result.diagnostics.length} warnings`,
				'', ...mcpTable(page.rows, output), '', ...resourceFooter(page, 'amc mcp list'),
				...(result.notes.length === 0 ? [] : ['', ...result.notes.map(note => `Note: ${note}`)]),
			].join('\n');
		}
		case 'mcp-enable':
		case 'mcp-disable': {
			const {context, runtime} = requireResources(resources);
			const enabled = command.kind === 'mcp-enable';
			const server = await setMcpServerEnabled(context, runtime, command.id, enabled);
			return `${enabled ? 'Enabled' : 'Disabled'} ${server.id}: ${server.state}`;
		}
	}
}

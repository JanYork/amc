import {join} from 'node:path';
import type {Layout} from '../model.js';
import {scanGitHubRepository} from '../marketplace/github.js';
import type {InstallationRecord, MarketplaceRuntime, RemoteSkill, UpgradeHooks, UpgradeResult} from '../marketplace/model.js';
import {stageRemoteSkill} from './install.js';
import {createOperationId, createOperationRoot, fingerprintDirectory, moveIntoOperationRoot, movePathExclusive} from './migration.js';
import {lstatIfPresent, validateSkillName} from './scan.js';
import {readSkillsLock, writeSkillsLock} from './provenance.js';

function exactSkill(skills: ReadonlyArray<RemoteSkill>, record: InstallationRecord, name: string): RemoteSkill {
	const skill = skills.find(item => item.relativePath === record.relativePath && item.name === name);
	if (skill === undefined) throw new Error(`Installed Skill source no longer contains ${name}`);
	return skill;
}

function nextRecord(record: InstallationRecord, commit: string, installedHash: string): InstallationRecord {
	return {...record, commit, installedHash, updatedAt: new Date().toISOString()};
}

export async function upgradeMarketplaceSkill(
	layout: Layout,
	runtime: MarketplaceRuntime,
	name: string,
	hooks: UpgradeHooks = {},
): Promise<UpgradeResult> {
	validateSkillName(name);
	const canonicalPath = join(layout.amc.skills, name);
	const beforeLock = await readSkillsLock(layout);
	const record = beforeLock.lock.skills[name];
	if (record === undefined || await lstatIfPresent(canonicalPath) === undefined) throw new Error(`Installed marketplace Skill not found: ${name}`);
	const currentHash = await fingerprintDirectory(canonicalPath);
	if (currentHash !== record.installedHash) throw new Error(`LOCAL_DRIFT: ${name} has local changes`);

	const scan = await scanGitHubRepository(runtime, {
		source: `${record.owner}/${record.repository}`,
		branch: record.branch,
	});
	const skill = exactSkill(scan.skills, record, name);
	if (scan.repository.commit === record.commit) return {state: 'unchanged', record};

	const operationId = createOperationId();
	let stage: string | undefined;
	let backupPath: string | undefined;
	try {
		stage = await stageRemoteSkill(
			layout,
			runtime,
			operationId,
			skill,
			scan.repository.owner,
			scan.repository.repository,
			scan.repository.commit,
			name,
		);
		const nextHash = await fingerprintDirectory(stage);
		const freshLock = await readSkillsLock(layout);
		if (freshLock.text !== beforeLock.text || await fingerprintDirectory(canonicalPath) !== currentHash) {
			throw new Error('Upgrade plan is stale');
		}
		const updatedRecord = nextRecord(record, scan.repository.commit, nextHash);
		if (nextHash === currentHash) {
			const backup = await createOperationRoot(layout.amc.backups, operationId);
			await moveIntoOperationRoot(stage, backup, ['staging', name]);
			stage = undefined;
			await writeSkillsLock(layout, {
				schemaVersion: 1,
				skills: {...freshLock.lock.skills, [name]: updatedRecord},
			}, freshLock.text);
			return {state: 'metadata-updated', record: updatedRecord};
		}

		const backup = await createOperationRoot(layout.amc.backups, operationId);
		backupPath = await moveIntoOperationRoot(canonicalPath, backup, ['canonical', name]);
		await movePathExclusive(stage, canonicalPath);
		stage = undefined;
		await hooks.afterReplace?.(canonicalPath);
		if (await fingerprintDirectory(canonicalPath) !== nextHash) throw new Error('Upgraded Skill verification failed');
		try {
			await writeSkillsLock(layout, {
				schemaVersion: 1,
				skills: {...freshLock.lock.skills, [name]: updatedRecord},
			}, freshLock.text);
		} catch (error: unknown) {
			const failed = await createOperationRoot(layout.amc.failed, operationId);
			await moveIntoOperationRoot(canonicalPath, failed, ['canonical', name]);
			await movePathExclusive(backupPath, canonicalPath);
			backupPath = undefined;
			throw error;
		}
		return {state: 'updated', record: updatedRecord};
	} catch (error: unknown) {
		if (backupPath !== undefined && await lstatIfPresent(backupPath) !== undefined) {
			try {
				if (await lstatIfPresent(canonicalPath) !== undefined) {
					const failed = await createOperationRoot(layout.amc.failed, operationId);
					await moveIntoOperationRoot(canonicalPath, failed, ['canonical', name]);
				}
				await movePathExclusive(backupPath, canonicalPath);
				backupPath = undefined;
			} catch {
				throw new Error(`Upgrade failed and needs manual recovery: ${backupPath}`);
			}
		}
		if (stage !== undefined && await lstatIfPresent(stage) !== undefined) {
			try {
				const failed = await createOperationRoot(layout.amc.failed, operationId);
				await moveIntoOperationRoot(stage, failed, ['staging', name]);
			} catch {
				throw new Error(`Upgrade failed and staging needs manual recovery: ${stage}`);
			}
		}
		throw error;
	}
}

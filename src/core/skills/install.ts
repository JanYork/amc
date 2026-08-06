import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {Layout} from '../model.js';
import {scanGitHubRepository} from '../marketplace/github.js';
import type {InstallationRecord, InstallHooks, InstallResult, MarketplaceRuntime, RemoteSkill} from '../marketplace/model.js';
import {selectRemoteSkill} from '../marketplace/select.js';
import {createOperationId, createOperationRoot, fingerprintDirectory, moveIntoOperationRoot, movePathExclusive} from './migration.js';
import {isSkillDirectory, lstatIfPresent, validateSkillName} from './scan.js';
import {readSkillsLock, writeSkillsLock} from './provenance.js';

function sameIdentity(record: InstallationRecord, skill: RemoteSkill, owner: string, repository: string, branch: string): boolean {
	return record.owner.toLowerCase() === owner.toLowerCase()
		&& record.repository.toLowerCase() === repository.toLowerCase()
		&& record.branch === branch
		&& record.relativePath === skill.relativePath;
}

function rawUrl(owner: string, repository: string, commit: string, path: string): string {
	return `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export async function stageRemoteSkill(
	layout: Layout,
	runtime: MarketplaceRuntime,
	operationId: string,
	skill: RemoteSkill,
	owner: string,
	repository: string,
	commit: string,
	name: string,
): Promise<string> {
	const operation = await createOperationRoot(layout.amc.staging, operationId);
	const stage = join(operation.path, name);
	await mkdir(stage);
	const prefix = skill.relativePath === '.' ? '' : `${skill.relativePath}/`;
	for (const file of skill.files) {
		if (prefix.length > 0 && !file.path.startsWith(prefix)) throw new Error('Remote Skill file escaped its source directory');
		const relativePath = prefix.length === 0 ? file.path : file.path.slice(prefix.length);
		if (relativePath.length === 0) throw new Error('Remote Skill file path is invalid');
		const url = rawUrl(owner, repository, commit, file.path);
		const response = await runtime.get(url, file.size, 30_000);
		const finalUrl = new URL(response.url);
		if (response.url !== url || response.status < 200 || response.status >= 300 || finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'raw.githubusercontent.com' || response.body.length !== file.size) {
			throw new Error(`GitHub content request failed for ${file.path}`);
		}
		const destination = join(stage, ...relativePath.split('/'));
		await mkdir(dirname(destination), {recursive: true});
		await writeFile(destination, response.body, {flag: 'wx', mode: file.executable ? 0o700 : 0o600});
	}
	if (!(await isSkillDirectory(stage))) throw new Error('Staged remote content is not a valid Skill');
	return stage;
}

export async function installMarketplaceSkill(
	layout: Layout,
	runtime: MarketplaceRuntime,
	input: Readonly<{source: string; skill: string; branch?: string}>,
	hooks: InstallHooks = {},
): Promise<InstallResult> {
	validateSkillName(input.skill);
	const canonicalPath = join(layout.amc.skills, input.skill);
	const beforeLock = await readSkillsLock(layout);
	const existingRecord = beforeLock.lock.skills[input.skill];
	const canonicalExists = await lstatIfPresent(canonicalPath) !== undefined;
	if (canonicalExists && existingRecord === undefined) throw new Error(`Install conflict: ${input.skill} is untracked`);
	if (!canonicalExists && existingRecord !== undefined) throw new Error(`Install conflict: ${input.skill} provenance has no canonical Skill`);

	const scan = await scanGitHubRepository(runtime, input.branch === undefined
		? {source: input.source}
		: {source: input.source, branch: input.branch});
	const selected = selectRemoteSkill(scan.skills, input.skill);
	if (selected.name !== input.skill) validateSkillName(selected.name);
	const installName = selected.name;
	if (installName !== input.skill) throw new Error(`Requested Skill resolves to another install name: ${installName}`);
	if (existingRecord !== undefined) {
		if (!sameIdentity(existingRecord, selected, scan.repository.owner, scan.repository.repository, scan.repository.branch)) {
			throw new Error(`Install conflict: ${installName} is from a different source`);
		}
		const currentHash = await fingerprintDirectory(canonicalPath);
		if (currentHash !== existingRecord.installedHash) throw new Error(`Install conflict: ${installName} has local changes`);
		return {state: 'unchanged', record: existingRecord};
	}

	const operationId = createOperationId();
	let stage: string | undefined;
	let canonicalCreated = false;
	try {
		stage = await stageRemoteSkill(
			layout,
			runtime,
			operationId,
			selected,
			scan.repository.owner,
			scan.repository.repository,
			scan.repository.commit,
			installName,
		);
		const installedHash = await fingerprintDirectory(stage);
		const freshLock = await readSkillsLock(layout);
		if (freshLock.text !== beforeLock.text || await lstatIfPresent(canonicalPath) !== undefined) {
			throw new Error('Install plan is stale');
		}
		await movePathExclusive(stage, canonicalPath);
		stage = undefined;
		canonicalCreated = true;
		await hooks.afterMove?.(canonicalPath);
		if (await fingerprintDirectory(canonicalPath) !== installedHash) throw new Error('Installed Skill verification failed');
		const now = new Date().toISOString();
		const record: InstallationRecord = {
			owner: scan.repository.owner,
			repository: scan.repository.repository,
			branch: scan.repository.branch,
			relativePath: selected.relativePath,
			commit: scan.repository.commit,
			installedHash,
			installedAt: now,
			updatedAt: now,
		};
		try {
			await writeSkillsLock(layout, {
				schemaVersion: 1,
				skills: {...freshLock.lock.skills, [installName]: record},
			}, freshLock.text);
		} catch (error: unknown) {
			const failed = await createOperationRoot(layout.amc.failed, operationId);
			await moveIntoOperationRoot(canonicalPath, failed, ['canonical', installName]);
			throw error;
		}
		return {state: 'installed', record};
	} catch (error: unknown) {
		if (canonicalCreated && await lstatIfPresent(canonicalPath) !== undefined) {
			try {
				const failed = await createOperationRoot(layout.amc.failed, operationId);
				await moveIntoOperationRoot(canonicalPath, failed, ['canonical', installName]);
			} catch {
				throw new Error(`Install failed and canonical content needs manual recovery: ${canonicalPath}`);
			}
		}
		if (stage !== undefined && await lstatIfPresent(stage) !== undefined) {
			try {
				const failed = await createOperationRoot(layout.amc.failed, operationId);
				await moveIntoOperationRoot(stage, failed, ['staging', installName]);
			} catch {
				throw new Error(`Install failed and staging needs manual recovery: ${stage}`);
			}
		}
		throw error;
	}
}

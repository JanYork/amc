import {createHash, type Hash} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Layout} from '../model.js';
import {scanGitHubRepository} from '../marketplace/github.js';
import type {InstallationRecord, MarketplaceRuntime, RemoteSkill, RepositoryScan} from '../marketplace/model.js';
import {fingerprintDirectory} from './migration.js';
import {readInstalledSkills} from './provenance.js';
import {listSkills, readDirectory, validateSkillName} from './scan.js';

export type SkillUpdateState = 'current' | 'update' | 'drift' | 'untracked' | 'error';
export type SkillUpdateStatus = Readonly<{name: string; state: SkillUpdateState; message?: string}>;

function update(hash: Hash, path: string, executable: boolean, body: Uint8Array): void {
	hash.update(path);
	hash.update('\0');
	hash.update(executable ? 'x' : '-');
	hash.update('\0');
	hash.update(String(body.length));
	hash.update('\0');
	hash.update(body);
	hash.update('\0');
}

async function localPayload(path: string): Promise<string> {
	const hash = createHash('sha256');
	async function visit(directory: string, prefix: string): Promise<void> {
		for (const entry of [...await readDirectory(directory)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
			const entryPath = join(directory, entry.name);
			const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) await visit(entryPath, relative);
			else if (entry.isFile()) {
				const metadata = await lstat(entryPath);
				update(hash, relative, (metadata.mode & 0o111) !== 0, await readFile(entryPath));
			} else throw new Error(`Unsupported local entry: ${relative}`);
		}
	}
	await visit(path, '');
	return hash.digest('hex');
}

function rawUrl(record: InstallationRecord, commit: string, path: string): string {
	return `https://raw.githubusercontent.com/${record.owner}/${record.repository}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function remotePayload(runtime: MarketplaceRuntime, record: InstallationRecord, commit: string, skill: RemoteSkill): Promise<string> {
	const hash = createHash('sha256');
	const prefix = skill.relativePath === '.' ? '' : `${skill.relativePath}/`;
	for (const file of skill.files) {
		const relative = prefix.length === 0 ? file.path : file.path.slice(prefix.length);
		const url = rawUrl(record, commit, file.path);
		const response = await runtime.get(url, file.size, 30_000);
		if (response.status < 200 || response.status >= 300 || response.url !== url || response.body.length !== file.size) {
			throw new Error(`Remote content request failed for ${relative}`);
		}
		update(hash, relative, file.executable, response.body);
	}
	return hash.digest('hex');
}

function exactSkill(scan: RepositoryScan, record: InstallationRecord, name: string): RemoteSkill {
	const skill = scan.skills.find(item => item.name === name && item.relativePath === record.relativePath);
	if (skill === undefined) throw new Error('Installed source path no longer exists');
	return skill;
}

export async function checkAppliedSkillUpdates(
	layout: Layout,
	runtime: MarketplaceRuntime,
	name?: string,
): Promise<ReadonlyArray<SkillUpdateStatus>> {
	if (name !== undefined) validateSkillName(name);
	const [inventory, records] = await Promise.all([listSkills(layout), readInstalledSkills(layout)]);
	const applied = inventory.skills.filter(skill => skill.canonical && (name === undefined || skill.name === name));
	if (name !== undefined && applied.length === 0) throw new Error(`Applied Skill not found: ${name}`);
	const scans = new Map<string, Promise<RepositoryScan>>();
	const results: SkillUpdateStatus[] = [];
	for (const skill of applied) {
		const record = records[skill.name];
		if (record === undefined) {
			results.push({name: skill.name, state: 'untracked'});
			continue;
		}
		const canonical = join(layout.amc.skills, skill.name);
		try {
			if (await fingerprintDirectory(canonical) !== record.installedHash) {
				results.push({name: skill.name, state: 'drift'});
				continue;
			}
			const key = `${record.owner}/${record.repository}:${record.branch}`;
			let scan = scans.get(key);
			if (scan === undefined) {
				scan = scanGitHubRepository(runtime, {source: `${record.owner}/${record.repository}`, branch: record.branch});
				scans.set(key, scan);
			}
			const repository = await scan;
			if (repository.repository.commit === record.commit) {
				results.push({name: skill.name, state: 'current'});
				continue;
			}
			const remote = exactSkill(repository, record, skill.name);
			const [localHash, remoteHash] = await Promise.all([
				localPayload(canonical),
				remotePayload(runtime, record, repository.repository.commit, remote),
			]);
			results.push({name: skill.name, state: localHash === remoteHash ? 'current' : 'update'});
		} catch (error: unknown) {
			results.push({name: skill.name, state: 'error', message: error instanceof Error ? error.message : 'Update check failed'});
		}
	}
	return results;
}

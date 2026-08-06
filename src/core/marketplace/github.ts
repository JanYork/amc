import {parseSkillManifest} from './manifest.js';
import type {MarketplaceRuntime, RemoteSkill, RemoteSkillFile, RepositoryScan} from './model.js';

const MAX_TREE_ENTRIES = 10_000;
const MAX_SKILLS = 200;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const field = value[key];
	return typeof field === 'string' ? field : undefined;
}

function parseJson(body: Uint8Array): unknown {
	return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(body));
}

function validateResponseUrl(value: string, expectedHost: string): void {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.hostname !== expectedHost || url.username.length > 0 || url.password.length > 0) {
		throw new Error(`Unexpected remote response URL: ${expectedHost}`);
	}
}

async function getJson(runtime: MarketplaceRuntime, url: string): Promise<unknown> {
	const response = await runtime.get(url, MAX_MANIFEST_BYTES, 10_000);
	validateResponseUrl(response.url, 'api.github.com');
	if (response.url !== url) throw new Error('GitHub request redirected to an unexpected URL');
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`GitHub request failed with status ${response.status}`);
	}
	return parseJson(response.body);
}

function validOwner(value: string): boolean {
	return value.length > 0 && value.length <= 39 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/iu.test(value);
}

function validRepository(value: string): boolean {
	return value.length > 0 && value.length <= 100 && value !== '.' && value !== '..' && /^[a-z\d._-]+$/iu.test(value);
}

function validBranch(value: string): boolean {
	if (value.length === 0 || value.length > 255 || value.includes('\\') || value.includes('\0') || value.startsWith('/') || value.endsWith('/')) {
		return false;
	}
	return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && /^[a-z\d._-]+$/iu.test(part));
}

function parseSource(source: string): Readonly<{owner: string; repository: string}> {
	const trimmed = source.trim();
	let parts: ReadonlyArray<string>;
	if (trimmed.startsWith('https://')) {
		const url = new URL(trimmed);
		if (
			url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port.length > 0
			|| url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0
		) {
			throw new Error('Source must be a public GitHub repository');
		}
		parts = url.pathname.replace(/\/$/u, '').split('/').filter(Boolean);
	} else {
		parts = trimmed.split('/');
	}
	if (parts.length !== 2) {
		throw new Error('Source must be owner/repository');
	}
	const owner = parts[0] ?? '';
	const repository = (parts[1] ?? '').replace(/\.git$/iu, '');
	if (!validOwner(owner) || !validRepository(repository)) {
		throw new Error('Source must be a public GitHub repository');
	}
	return {owner: owner.toLowerCase(), repository: repository.toLowerCase()};
}

function validInstallName(name: string): boolean {
	return name.length > 0 && name === name.trim() && name !== '.' && name !== '..'
		&& name !== '__proto__' && name !== 'prototype' && name !== 'constructor'
		&& !name.includes('/') && !name.includes('\\') && !/[\u0000-\u001f\u007f-\u009f]/u.test(name);
}

function validDescription(description: string): boolean {
	return description.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/u.test(description);
}

function validTreePath(path: string): boolean {
	const parts = path.split('/');
	return path.length > 0 && path.length <= 1024 && parts.length <= 16
		&& !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
		&& parts.every(part => part.length > 0 && part !== '.' && part !== '..');
}

type TreeFile = Readonly<{path: string; size: number; executable: boolean}>;
type ParsedTree = Readonly<{
	files: ReadonlyArray<TreeFile>;
	unsupportedLinks: ReadonlyArray<string>;
}>;

function parseTree(value: unknown): ParsedTree {
	if (!isRecord(value) || value['truncated'] === true || !Array.isArray(value['tree'])) {
		throw new Error(value !== null && isRecord(value) && value['truncated'] === true
			? 'GitHub repository tree is truncated'
			: 'Invalid GitHub repository tree');
	}
	if (value['tree'].length > MAX_TREE_ENTRIES) {
		throw new Error('GitHub repository tree exceeds the entry limit');
	}
	const files: TreeFile[] = [];
	const unsupportedLinks: string[] = [];
	for (const item of value['tree']) {
		if (!isRecord(item)) throw new Error('Invalid GitHub tree entry');
		const path = stringField(item, 'path');
		const type = stringField(item, 'type');
		const mode = stringField(item, 'mode');
		if (path === undefined || type === undefined || mode === undefined || !validTreePath(path)) {
			throw new Error('Invalid or unsafe GitHub tree entry');
		}
		if (mode === '120000' || mode === '160000' || type === 'commit') {
			unsupportedLinks.push(path);
			continue;
		}
		if (type === 'tree') continue;
		const size = item['size'];
		if (type !== 'blob' || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
			throw new Error('GitHub repository contains an unsupported or oversized file');
		}
		if (mode !== '100644' && mode !== '100755') {
			throw new Error('GitHub repository contains an unsupported file mode');
		}
		files.push({path, size, executable: mode === '100755'});
	}
	return {
		files: files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
		unsupportedLinks: unsupportedLinks.sort(),
	};
}

function entryInside(directory: string, path: string): boolean {
	return directory === '.' || path.startsWith(`${directory}/`);
}

function rawUrl(owner: string, repository: string, commit: string, path: string): string {
	const encodedPath = path.split('/').map(encodeURIComponent).join('/');
	return `https://raw.githubusercontent.com/${owner}/${repository}/${commit}/${encodedPath}`;
}

async function getText(runtime: MarketplaceRuntime, url: string, maximumBytes: number): Promise<string> {
	const response = await runtime.get(url, maximumBytes, 30_000);
	validateResponseUrl(response.url, 'raw.githubusercontent.com');
	if (response.url !== url) throw new Error('GitHub content redirected to an unexpected URL');
	if (response.status < 200 || response.status >= 300 || response.body.length > maximumBytes) {
		throw new Error(`GitHub content request failed with status ${response.status}`);
	}
	return new TextDecoder('utf-8', {fatal: true}).decode(response.body);
}

function skillFiles(tree: ReadonlyArray<TreeFile>, directory: string): ReadonlyArray<RemoteSkillFile> {
	const prefix = directory === '.' ? '' : `${directory}/`;
	const selected = tree.filter(file => prefix.length === 0 || file.path.startsWith(prefix));
	const total = selected.reduce((sum, file) => sum + file.size, 0);
	if (selected.length > MAX_FILES || total > MAX_SKILL_BYTES) {
		throw new Error('Skill exceeds the file or byte limit');
	}
	return selected.map(file => ({path: file.path, size: file.size, executable: file.executable}));
}

export async function scanGitHubRepository(
	runtime: MarketplaceRuntime,
	input: Readonly<{source: string; branch?: string}>,
): Promise<RepositoryScan> {
	const {owner, repository} = parseSource(input.source);
	const metadata = await getJson(runtime, `https://api.github.com/repos/${owner}/${repository}`);
	if (!isRecord(metadata) || metadata['private'] !== false) {
		throw new Error('Source must be a public GitHub repository');
	}
	const branch = input.branch ?? stringField(metadata, 'default_branch');
	if (branch === undefined || !validBranch(branch)) {
		throw new Error('GitHub repository branch is invalid');
	}
	const reference = await getJson(runtime, `https://api.github.com/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
	const object = isRecord(reference) && isRecord(reference['object']) ? reference['object'] : undefined;
	const commit = object === undefined ? undefined : stringField(object, 'sha');
	if (commit === undefined || !/^[a-f\d]{40}$/iu.test(commit)) {
		throw new Error('GitHub branch did not resolve to a commit');
	}
	const tree = parseTree(await getJson(runtime, `https://api.github.com/repos/${owner}/${repository}/git/trees/${commit}?recursive=1`));
	const manifestFiles = tree.files.filter(file => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'));
	if (manifestFiles.length > MAX_SKILLS) {
		throw new Error('GitHub repository exceeds the Skill limit');
	}
	const skills: RemoteSkill[] = [];
	const diagnostics: string[] = [];
	for (const manifestFile of manifestFiles) {
		const relativePath = manifestFile.path === 'SKILL.md'
			? '.'
			: manifestFile.path.slice(0, -'/SKILL.md'.length);
		const unsupportedLink = tree.unsupportedLinks.find(path => entryInside(relativePath, path));
		if (unsupportedLink !== undefined) {
			diagnostics.push(`${manifestFile.path}: unsupported symlink or submodule at ${unsupportedLink}`);
			continue;
		}
		if (manifestFile.size > MAX_MANIFEST_BYTES) {
			diagnostics.push(`${manifestFile.path}: SKILL.md exceeds the size limit`);
			continue;
		}
		let manifest;
		try {
			manifest = parseSkillManifest(await getText(runtime, rawUrl(owner, repository, commit, manifestFile.path), MAX_MANIFEST_BYTES));
		} catch (error: unknown) {
			diagnostics.push(`${manifestFile.path}: ${error instanceof Error ? error.message : 'read failed'}`);
			continue;
		}
		if (manifest === undefined || !validInstallName(manifest.name) || !validDescription(manifest.description)) {
			diagnostics.push(`${manifestFile.path}: invalid Skill frontmatter or install name`);
			continue;
		}
		skills.push({...manifest, relativePath, files: skillFiles(tree.files, relativePath)});
	}
	return {
		repository: {owner, repository, branch, commit: commit.toLowerCase()},
		skills: skills.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
		diagnostics,
	};
}

import {constants, type Dirent, type Stats} from 'node:fs';
import {access, lstat, readdir, readFile, readlink, stat} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {AmcError, type Diagnostic, type Layout, type ScanResult, type SkillDetails, type Target, type TargetState} from '../model.js';
import {targets} from '../layout.js';

type TargetEntry = Readonly<{
	state: Exclude<TargetState, 'disabled'>;
	visible: boolean;
}>;

type TargetObservation =
	| Readonly<{state: 'disabled'}>
	| Readonly<{state: 'enabled'; linkText: string}>
	| Readonly<{
		state: 'unmanaged';
		kind: 'directory' | 'foreign-link';
		contentPath: string;
		linkText: string | undefined;
	}>
	| Readonly<{
		state: 'conflict';
		kind: 'broken-link' | 'invalid';
		contentPath: string | undefined;
		linkText: string | undefined;
	}>;

type TargetScan = Readonly<{
	entries: ReadonlyMap<string, TargetEntry>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>;


export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

export async function lstatIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return undefined;
		}
		throw error;
	}
}


export async function readDirectory(path: string): Promise<ReadonlyArray<Dirent>> {
	try {
		return await readdir(path, {withFileTypes: true});
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return [];
		}
		throw error;
	}
}

export async function isSkillDirectory(path: string): Promise<boolean> {
	const directory = await lstatIfPresent(path);
	if (!directory?.isDirectory()) {
		return false;
	}

	const skillFile = join(path, 'SKILL.md');
	try {
		if (!(await stat(skillFile)).isFile()) {
			return false;
		}
		await access(skillFile, constants.R_OK);
		return true;
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return false;
		}
		throw error;
	}
}

export async function observeTargetPath(
	path: string,
	canonicalPath: string,
	canonicalValid: boolean,
): Promise<TargetObservation> {
	const entry = await lstatIfPresent(path);
	if (entry === undefined) {
		return {state: 'disabled'};
	}
	if (entry.isSymbolicLink()) {
		const linkText = await readlink(path);
		const contentPath = resolve(dirname(path), linkText);
		if (contentPath === resolve(canonicalPath) && canonicalValid) {
			return {state: 'enabled', linkText};
		}
		if (await isSkillDirectory(contentPath)) {
			return {state: 'unmanaged', kind: 'foreign-link', contentPath, linkText};
		}
		return {state: 'conflict', kind: 'broken-link', contentPath, linkText};
	}
	if (entry.isDirectory() && await isSkillDirectory(path)) {
		return {state: 'unmanaged', kind: 'directory', contentPath: path, linkText: undefined};
	}
	return {state: 'conflict', kind: 'invalid', contentPath: undefined, linkText: undefined};
}

async function scanCanonical(path: string): Promise<Readonly<{
	names: ReadonlySet<string>;
	diagnostics: ReadonlyArray<Diagnostic>;
}>> {
	const names = new Set<string>();
	const diagnostics: Diagnostic[] = [];

	for (const entry of await readDirectory(path)) {
		const entryPath = join(path, entry.name);
		if (await isSkillDirectory(entryPath)) {
			names.add(entry.name);
		} else {
			diagnostics.push({path: entryPath, message: 'Canonical entry is not a valid Skill directory.'});
		}
	}

	return {names, diagnostics};
}

async function scanTarget(
	path: string,
	canonicalPath: string,
	canonicalNames: ReadonlySet<string>,
): Promise<TargetScan> {
	const entries = new Map<string, TargetEntry>();
	const diagnostics: Diagnostic[] = [];

	for (const entry of await readDirectory(path)) {
		const entryPath = join(path, entry.name);
		const observation = await observeTargetPath(
			entryPath,
			join(canonicalPath, entry.name),
			canonicalNames.has(entry.name),
		);
		switch (observation.state) {
			case 'disabled':
				continue;
			case 'enabled':
			case 'unmanaged':
				entries.set(entry.name, {state: observation.state, visible: true});
				continue;
			case 'conflict':
				entries.set(entry.name, {state: 'conflict', visible: false});
				diagnostics.push({
					path: entryPath,
					message: observation.kind === 'broken-link'
						? 'Target symlink does not resolve to a valid Skill directory.'
						: 'Target entry is not a valid Skill directory.',
				});
		}
	}

	return {entries, diagnostics};
}

function targetState(scan: TargetScan, name: string): TargetState {
	return scan.entries.get(name)?.state ?? 'disabled';
}

async function scanShared(
	path: string,
	canonicalPath: string,
	canonicalNames: ReadonlySet<string>,
): Promise<TargetScan> {
	const scan = await scanTarget(path, canonicalPath, canonicalNames);
	return {
		entries: new Map([...scan.entries].map(([name, entry]) => [name, {
			...entry,
			state: entry.state === 'enabled' || entry.state === 'unmanaged' ? 'shared' : entry.state,
		}])),
		diagnostics: scan.diagnostics,
	};
}

function effectiveTargetState(direct: TargetScan, shared: ReadonlyArray<TargetScan>, name: string): TargetState {
	const directState = targetState(direct, name);
	if (directState !== 'disabled') return directState;
	return shared.some(scan => targetState(scan, name) === 'conflict')
		? 'conflict'
		: shared.some(scan => targetState(scan, name) === 'shared') ? 'shared' : 'disabled';
}

export async function listSkills(layout: Layout): Promise<ScanResult> {
	const canonical = await scanCanonical(layout.amc.skills);
	const [agents, agent, claude, pi, codex] = await Promise.all([
		scanShared(layout.sources.agents, layout.amc.skills, canonical.names),
		scanShared(layout.sources.agent, layout.amc.skills, canonical.names),
		scanTarget(layout.targets.claude, layout.amc.skills, canonical.names),
		scanTarget(layout.targets.pi, layout.amc.skills, canonical.names),
		scanTarget(layout.targets.codex, layout.amc.skills, canonical.names),
	]);
	const names = new Set(canonical.names);

	for (const scan of [agents, agent, claude, pi, codex]) {
		for (const [name, entry] of scan.entries) {
			if (entry.visible) names.add(name);
		}
	}

	const shared = [agents, agent];
	const skills = [...names].sort(compareCodePoints).map(name => ({
		name,
		canonical: canonical.names.has(name),
		states: {
			claude: targetState(claude, name),
			pi: effectiveTargetState(pi, shared, name),
			codex: effectiveTargetState(codex, shared, name),
		},
	}));
	const diagnostics = [
		...canonical.diagnostics,
		...agents.diagnostics,
		...agent.diagnostics,
		...claude.diagnostics,
		...pi.diagnostics,
		...codex.diagnostics,
	].sort((left, right) => compareCodePoints(left.path, right.path));

	return {skills, diagnostics};
}

function normalizeDescription(value: string): string {
	return value.replaceAll(/\s+/gu, ' ').trim();
}

function inlineDescription(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed === 'string') {
				return normalizeDescription(parsed);
			}
		} catch {
			return normalizeDescription(trimmed.slice(1, -1));
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return normalizeDescription(trimmed.slice(1, -1).replaceAll("''", "'"));
	}
	return normalizeDescription(trimmed);
}

function descriptionFromContent(content: string): string {
	const lines = content.replace(/^\uFEFF/u, '').split(/\r?\n/u);
	const frontmatterEnd = lines[0]?.trim() === '---'
		? lines.findIndex((line, index) => index > 0 && line.trim() === '---')
		: -1;

	if (frontmatterEnd > 0) {
		for (let index = 1; index < frontmatterEnd; index += 1) {
			const match = /^description:\s*(.*)$/u.exec(lines[index] ?? '');
			if (match === null) {
				continue;
			}
			const value = match[1] ?? '';
			if (/^[>|][+-]?$/u.test(value.trim())) {
				const block: string[] = [];
				for (let blockIndex = index + 1; blockIndex < frontmatterEnd; blockIndex += 1) {
					const line = lines[blockIndex] ?? '';
					if (line.length > 0 && !/^\s/u.test(line)) {
						break;
					}
					block.push(line.trim());
				}
				const description = normalizeDescription(block.join(' '));
				if (description.length > 0) {
					return description;
				}
			} else {
				const description = inlineDescription(value);
				if (description.length > 0) {
					return description;
				}
			}
			break;
		}
	}

	const body = lines.slice(frontmatterEnd > 0 ? frontmatterEnd + 1 : 0);
	const paragraph: string[] = [];
	for (const line of body) {
		const trimmed = line.trim();
		if (trimmed.length === 0) {
			if (paragraph.length > 0) {
				break;
			}
			continue;
		}
		if (paragraph.length === 0 && (trimmed.startsWith('#') || trimmed.startsWith('<!--'))) {
			continue;
		}
		paragraph.push(trimmed);
	}
	return normalizeDescription(paragraph.join(' ')) || 'No description provided.';
}

export async function readSkillDetails(
	layout: Layout,
	name: string,
	preferredTarget?: Target,
): Promise<SkillDetails> {
	validateSkillName(name);
	const canonicalPath = join(layout.amc.skills, name);
	let contentPath: string | undefined;
	if (await isSkillDirectory(canonicalPath)) {
		contentPath = canonicalPath;
	} else {
		const targetOrder: ReadonlyArray<Target> = preferredTarget === undefined
			? targets
			: [preferredTarget, ...targets.filter(target => target !== preferredTarget)];
		for (const target of targetOrder) {
			const observation = await observeTargetPath(
				join(layout.targets[target], name),
				canonicalPath,
				false,
			);
			if (observation.state === 'unmanaged') {
				contentPath = observation.contentPath;
				break;
			}
		}
	}
	if (contentPath === undefined) {
		for (const source of [layout.sources.agents, layout.sources.agent]) {
			const observation = await observeTargetPath(join(source, name), canonicalPath, false);
			if (observation.state === 'unmanaged') {
				contentPath = observation.contentPath;
				break;
			}
		}
	}
	if (contentPath === undefined) {
		throw new AmcError('CANONICAL_MISSING', `Skill is not readable: ${name}`, canonicalPath);
	}
	const sourcePath = join(contentPath, 'SKILL.md');
	return {
		name,
		description: descriptionFromContent(await readFile(sourcePath, 'utf8')),
		sourcePath,
	};
}

export async function isOwnedLink(path: string, canonicalPath: string): Promise<boolean> {
	const entry = await lstatIfPresent(path);
	if (!entry?.isSymbolicLink()) {
		return false;
	}
	return resolve(dirname(path), await readlink(path)) === resolve(canonicalPath);
}

export function validateSkillName(name: string): void {
	if (
		name.length === 0 ||
		name === '.' ||
		name === '..' ||
		name === '__proto__' ||
		name === 'constructor' ||
		name.includes('/') ||
		name.includes('\\') ||
		name.trim() !== name ||
		/[\u0000-\u001f\u007f]/u.test(name)
	) {
		throw new AmcError('INVALID_SKILL_NAME', `Invalid Skill name: ${name}`, name);
	}
}


export function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

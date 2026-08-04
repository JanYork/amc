import {lstat, mkdir, mkdtemp, readlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';

const defaultSkillContent = (name: string): string => `# ${name}

Test skill.
`;

const hasStringCode = (error: unknown): error is {code: string} =>
	typeof error === 'object' &&
	error !== null &&
	'code' in error &&
	typeof error.code === 'string';

export const createTestHome = async (): Promise<string> => mkdtemp(join(tmpdir(), 'amc-test-'));

export const writeSkill = async (
	parent: string,
	name: string,
	content = defaultSkillContent(name),
): Promise<string> => {
	const skillDirectory = join(parent, name);
	await mkdir(skillDirectory, {recursive: true});
	await writeFile(join(skillDirectory, 'SKILL.md'), content, 'utf8');
	return skillDirectory;
};

export const pathExists = async (path: string): Promise<boolean> => {
	try {
		await lstat(path);
		return true;
	} catch (error: unknown) {
		if (hasStringCode(error) && error.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
};

export const resolvedLink = async (path: string): Promise<string> =>
	resolve(dirname(path), await readlink(path));

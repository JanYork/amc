import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';

type JsonObject = Readonly<Record<string, unknown>>;

const repositoryRoot = process.cwd();

const isObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const readJsonObject = async (path: string): Promise<JsonObject> => {
	const value: unknown = JSON.parse(await readFile(path, 'utf8'));
	assert.ok(isObject(value), `${path} must contain a JSON object`);
	return value;
};

const objectField = (object: JsonObject, key: string): JsonObject => {
	const value = object[key];
	assert.ok(isObject(value), `${key} must be an object`);
	return value;
};

const stringField = (object: JsonObject, key: string): string => {
	const value = object[key];
	if (typeof value !== 'string') {
		assert.fail(`${key} must be a string`);
	}
	return value;
};

test('package identity, publishing metadata, and runtime allowlist stay synchronized', async () => {
	const packageJson = await readJsonObject(join(repositoryRoot, 'package.json'));
	assert.equal(packageJson['name'], '@i-xor/amc');
	assert.equal(packageJson['license'], 'Apache-2.0');
	assert.equal(packageJson['author'], 'JanYork');
	assert.deepEqual(packageJson['keywords'], [
		'agent-skills',
		'cli',
		'claude-code',
		'codex',
		'pi',
		'developer-tools',
	]);
	assert.deepEqual(packageJson['files'], [
		'dist/src',
		'README.md',
		'README.zh-CN.md',
		'LICENSE',
		'NOTICE',
	]);
	assert.deepEqual(packageJson['bin'], {amc: 'dist/src/main.js'});
	assert.deepEqual(packageJson['repository'], {
		type: 'git',
		url: 'git+https://github.com/JanYork/amc.git',
	});
	assert.deepEqual(packageJson['bugs'], {url: 'https://github.com/JanYork/amc/issues'});
	assert.equal(packageJson['homepage'], 'https://github.com/JanYork/amc#readme');
	assert.deepEqual(packageJson['engines'], {node: '>=22'});
	assert.deepEqual(packageJson['publishConfig'], {access: 'public', provenance: true});
	assert.deepEqual(packageJson['dependencies'], {ink: '7.1.1', react: '19.2.8'});
	assert.deepEqual(packageJson['devDependencies'], {
		'@types/node': '22.20.1',
		'@types/react': '19.2.18',
		'ink-testing-library': '4.0.0',
		oxlint: '1.77.0',
		typescript: '7.0.2',
	});

	const helpSource = await readFile(join(repositoryRoot, 'src', 'cli', 'help.ts'), 'utf8');
	const versionMatch = /^export const version = '([^']+)'; \/\/ x-release-please-version$/mu.exec(helpSource);
	assert.equal(versionMatch?.[1], stringField(packageJson, 'version'));
});

test('package scripts, registry, and build boundaries remain release-safe', async () => {
	const packageJson = await readJsonObject(join(repositoryRoot, 'package.json'));
	assert.deepEqual(objectField(packageJson, 'scripts'), {
		lint: 'oxlint src test',
		build: 'tsc -p tsconfig.build.json',
		'build:test': 'tsc -p tsconfig.json',
		test: 'npm run build:test && node --test dist/test/*.test.js',
		typecheck: 'tsc -p tsconfig.json --noEmit',
		coverage: 'npm run build:test && node --test --experimental-test-coverage --test-coverage-include=dist/src/**/*.js --test-coverage-lines=80 --test-coverage-branches=75 --test-coverage-functions=90 dist/test/*.test.js',
		prepack: 'npm run lint && npm run typecheck && npm run build',
	});
	assert.equal(await readFile(join(repositoryRoot, '.npmrc'), 'utf8'), 'registry=https://registry.npmjs.org/\n');

	const buildConfig = await readJsonObject(join(repositoryRoot, 'tsconfig.build.json'));
	assert.equal(buildConfig['extends'], './tsconfig.json');
	assert.deepEqual(buildConfig['include'], ['src/**/*.ts', 'src/**/*.tsx']);
	assert.deepEqual(buildConfig['exclude'], ['test']);

	const lockText = await readFile(join(repositoryRoot, 'package-lock.json'), 'utf8');
	assert.equal(lockText.includes('registry.npmmirror.com'), false);
});

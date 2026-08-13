import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';

const repositoryRoot = process.cwd();
const readRepositoryFile = async (path: string): Promise<string> =>
	readFile(join(repositoryRoot, path), 'utf8');

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const objectField = (object: JsonObject, key: string): JsonObject => {
	const value = object[key];
	assert.ok(isObject(value), `${key} must be an object`);
	return value;
};

const readJsonObject = async (path: string): Promise<JsonObject> => {
	const value: unknown = JSON.parse(await readRepositoryFile(path));
	assert.ok(isObject(value), `${path} must contain a JSON object`);
	return value;
};

const publicFiles = [
	'.gitignore',
	'README.md',
	'README.zh-CN.md',
	'CONTRIBUTING.md',
	'SECURITY.md',
	'CODE_OF_CONDUCT.md',
	'CHANGELOG.md',
	'NOTICE',
	'.github/ISSUE_TEMPLATE/bug.yml',
	'.github/ISSUE_TEMPLATE/feature.yml',
	'.github/ISSUE_TEMPLATE/config.yml',
	'.github/pull_request_template.md',
	'.github/dependabot.yml',
	'.github/workflows/ci.yml',
	'.github/workflows/release.yml',
	'release-please-config.json',
	'.release-please-manifest.json',
];

const requiredFiles = [...publicFiles, 'LICENSE'];

test('public documentation is complete, reciprocal, and grounded in CLI help', async () => {
	await Promise.all(requiredFiles.map(async path => {
		assert.ok((await readRepositoryFile(path)).length > 0, `${path} must not be empty`);
	}));

	const [english, chinese, helpSource] = await Promise.all([
		readRepositoryFile('README.md'),
		readRepositoryFile('README.zh-CN.md'),
		readRepositoryFile('src/cli/help.ts'),
	]);
	assert.match(english, /\[简体中文\]\(README\.zh-CN\.md\)/u);
	assert.match(chinese, /\[English\]\(README\.md\)/u);
	assert.match(english, /npm install --global @i-xor\/amc/u);
	assert.match(chinese, /npm install --global @i-xor\/amc/u);
	assert.match(english, /macOS and Linux only/u);
	assert.match(english, /Node\.js 22 or newer/u);
	assert.match(english, /amc hooks enable\|disable <hook-id>/u);
	assert.match(chinese, /amc hooks enable\|disable <hook-id>/u);
	assert.match(english, /disabled-hooks\/<hook-id>\.json/u);
	assert.match(english, /\$VISUAL[\s\S]*\$EDITOR[\s\S]*vim/u);
	assert.match(chinese, /\$VISUAL[\s\S]*\$EDITOR[\s\S]*vim/u);

	const helpCommands = helpSource
		.split('\n')
		.map(line => line.trim().replace(/`;$/u, ''))
		.filter(line => line.startsWith('amc'));
	for (const command of helpCommands) {
		assert.ok(english.includes(command), `README.md must include help command: ${command}`);
		assert.ok(chinese.includes(command), `README.zh-CN.md must include help command: ${command}`);
	}
});

test('legal, security, community, and dependency policies use approved public metadata', async () => {
	const [gitignore, license, notice, security, conduct, bug, feature, dependabot] = await Promise.all([
		readRepositoryFile('.gitignore'),
		readRepositoryFile('LICENSE'),
		readRepositoryFile('NOTICE'),
		readRepositoryFile('SECURITY.md'),
		readRepositoryFile('CODE_OF_CONDUCT.md'),
		readRepositoryFile('.github/ISSUE_TEMPLATE/bug.yml'),
		readRepositoryFile('.github/ISSUE_TEMPLATE/feature.yml'),
		readRepositoryFile('.github/dependabot.yml'),
	]);
	assert.equal(gitignore, `# Dependencies and generated artifacts
node_modules/
dist/
coverage/
.cache/
*.log
*.tgz
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Local credentials and environment overrides
.env
.env.*
!.env.example
*.local

# Editor and operating-system metadata
.DS_Store
.idea/
.vscode/
`);
	assert.doesNotMatch(gitignore, /agent|superpowers|playwright|output|lwc/iu);
	assert.match(license, /Apache License\s+Version 2\.0, January 2004/u);
	assert.match(license, /END OF TERMS AND CONDITIONS/u);
	assert.equal(notice, 'AMC — Agent Management CLI\nCopyright 2026 JanYork\n\nThis product includes software developed for the AMC project.\n');
	const advisoryUrl = 'https://github.com/JanYork/amc/security/advisories/new';
	assert.ok(security.includes(advisoryUrl));
	assert.ok(conduct.includes(advisoryUrl));
	assert.match(conduct, /`Conduct report`/u);
	assert.match(conduct, /Contributor Covenant/u);
	assert.match(bug, /Do not paste secrets/u);
	assert.match(feature, /Do not paste secrets/u);
	assert.match(dependabot, /package-ecosystem: npm[\s\S]*interval: weekly/u);
	assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*interval: weekly/u);
});

test('CI and release automation stays bounded to the approved matrix and publish path', async () => {
	const [ci, release] = await Promise.all([
		readRepositoryFile('.github/workflows/ci.yml'),
		readRepositoryFile('.github/workflows/release.yml'),
	]);
	assert.match(ci, /on:\n  pull_request:\n  push:\n    branches:\n      - main/u);
	assert.match(ci, /permissions:\n  contents: read/u);
	assert.match(ci, /os:\n          - ubuntu-latest\n          - macos-latest\n        node:\n          - 22\n          - 26/u);
	assert.match(ci, /needs: test[\s\S]*runs-on: ubuntu-latest[\s\S]*node-version: 26/u);
	assert.match(ci, /npm ci[\s\S]*npm run lint[\s\S]*npm run typecheck[\s\S]*npm test/u);
	assert.equal((ci.match(/registry-url: https:\/\/registry\.npmjs\.org/gu) ?? []).length, 2);
	assert.equal((ci.match(/cache: npm/gu) ?? []).length, 2);
	assert.match(ci, /npm run coverage/u);
	assert.match(ci, /npm audit --audit-level=high --omit=dev --registry=https:\/\/registry\.npmjs\.org/u);
	assert.match(ci, /npm audit --audit-level=high --registry=https:\/\/registry\.npmjs\.org/u);
	assert.match(ci, /npm publish --dry-run --access public/u);
	assert.match(ci, /test ! -e "\$HOME_DIR\/\.amc"/u);
	assert.equal((ci.match(/actions\/checkout@v5/gu) ?? []).length, 2);
	assert.equal((ci.match(/actions\/setup-node@v6/gu) ?? []).length, 2);

	assert.match(release, /on:\n  push:\n    branches:\n      - main/u);
	assert.match(release, /release:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n      pull-requests: write/u);
	assert.match(release, /googleapis\/release-please-action@v4/u);
	assert.doesNotMatch(release, /^  publish:/mu);
	assert.doesNotMatch(release, /npm publish/u);
	assert.doesNotMatch(release, /NPM_TOKEN/u);

	for (const workflow of [ci, release]) {
		assert.doesNotMatch(workflow, /windows-latest/iu);
		assert.doesNotMatch(workflow, /npm_[A-Za-z0-9]{20,}/u, 'workflow contains a literal npm token');
		assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN:\s+(?!\$\{\{ secrets\.NPM_TOKEN \}\})\S+/u, 'workflow contains a literal auth token');
	}
});

test('Release Please owns versioning across initial and generated release states', async () => {
	const [config, manifest, changelog, helpSource, packageJson] = await Promise.all([
		readJsonObject('release-please-config.json'),
		readJsonObject('.release-please-manifest.json'),
		readRepositoryFile('CHANGELOG.md'),
		readRepositoryFile('src/cli/help.ts'),
		readJsonObject('package.json'),
	]);
	const rootPackage = objectField(objectField(config, 'packages'), '.');
	assert.equal(rootPackage['release-type'], 'node');
	assert.equal(rootPackage['package-name'], '@i-xor/amc');
	assert.equal(rootPackage['include-v-in-tag'], true);
	assert.equal(rootPackage['release-name-pattern'], 'AMC v${version}');
	assert.deepEqual(rootPackage['changelog-sections'], [
		{type: 'feat', section: 'Features'},
		{type: 'fix', section: 'Bug Fixes'},
		{type: 'security', section: 'Security'},
		{type: 'perf', section: 'Performance'},
		{type: 'refactor', section: 'Code Refactoring'},
		{type: 'docs', section: 'Documentation'},
		{type: 'build', section: 'Build System'},
		{type: 'ci', section: 'Continuous Integration'},
		{type: 'test', section: 'Tests', hidden: true},
		{type: 'chore', section: 'Miscellaneous Chores', hidden: true},
	]);
	assert.deepEqual(rootPackage['extra-files'], [{type: 'generic', path: 'src/cli/help.ts'}]);
	const packageVersion = packageJson['version'];
	const manifestVersion = manifest['.'];
	assert.ok(typeof packageVersion === 'string');
	assert.ok(typeof manifestVersion === 'string');
	assert.ok(manifestVersion === '0.0.0' || manifestVersion === packageVersion);
	assert.ok(helpSource.includes(`export const version = '${packageVersion}'; // x-release-please-version`));
	if (manifestVersion === '0.0.0') {
		assert.equal(packageVersion, '0.1.0');
		assert.doesNotMatch(changelog, /## 0\.1\.0/u);
		assert.match(changelog, /## Unreleased\n\n(?:No release has been published yet\.|- Add )/u);
	} else {
		assert.ok(changelog.includes(`## ${packageVersion} (`));
	}
});

test('intended public files contain no personal absolute paths or contact addresses', async () => {
	for (const path of publicFiles) {
		const content = await readRepositoryFile(path);
		assert.doesNotMatch(content, /\/Users\/|\/home\/[A-Za-z0-9._-]+\//u, `${path} contains a personal absolute path`);
		assert.doesNotMatch(content, /\b[A-Z]:\\Users\\/iu, `${path} contains a personal Windows path`);
		assert.doesNotMatch(content, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu, `${path} contains an email address`);
	}
});

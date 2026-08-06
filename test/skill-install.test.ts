import assert from 'node:assert/strict';
import {readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {installMarketplaceSkill, readInstalledSkills, type MarketplaceRuntime} from '../src/core/marketplace.js';
import {createLayout} from '../src/core/index.js';
import {createTestHome, pathExists, writeSkill} from './helpers.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function installRuntime(owner = 'example'): MarketplaceRuntime {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	return {
		get: url => {
			const responses: Readonly<Record<string, Uint8Array>> = {
				[`https://api.github.com/repos/${owner}/skills`]: json({private: false, default_branch: 'main'}),
				[`https://api.github.com/repos/${owner}/skills/git/ref/heads/main`]: json({object: {sha: commit}}),
				[`https://api.github.com/repos/${owner}/skills/git/trees/${commit}?recursive=1`]: json({
					truncated: false,
					tree: [
						{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: 58},
						{path: 'skills/alpha/script.sh', type: 'blob', mode: '100755', size: 18},
					],
				}),
				[`https://raw.githubusercontent.com/${owner}/skills/${commit}/skills/alpha/SKILL.md`]: text('---\nname: alpha\ndescription: Installed skill.\n---\n# Alpha\n'),
				[`https://raw.githubusercontent.com/${owner}/skills/${commit}/skills/alpha/script.sh`]: text('#!/bin/sh\necho ok\n'),
			};
			const body = responses[url];
			return Promise.resolve(body === undefined
				? {status: 404, url, body: text('missing')}
				: {status: 200, url, body});
		},
	};
}

test('marketplace install writes one verified canonical Skill and provenance without enabling targets', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const result = await installMarketplaceSkill(layout, installRuntime(), {source: 'example/skills', skill: 'alpha'});

	assert.equal(result.state, 'installed');
	assert.equal(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), '---\nname: alpha\ndescription: Installed skill.\n---\n# Alpha\n');
	assert.equal((await stat(join(layout.amc.skills, 'alpha', 'script.sh'))).mode & 0o111, 0o100);
	assert.equal(await pathExists(join(layout.targets.claude, 'alpha')), false);
	assert.equal(await pathExists(join(layout.targets.pi, 'alpha')), false);
	assert.equal(await pathExists(join(layout.targets.codex, 'alpha')), false);
	const installed = await readInstalledSkills(layout);
	assert.equal(installed['alpha']?.owner, 'example');
	assert.equal(installed['alpha']?.relativePath, 'skills/alpha');
	assert.equal(installed['alpha']?.installedHash, result.record.installedHash);

	const repeated = await installMarketplaceSkill(layout, installRuntime(), {source: 'example/skills', skill: 'alpha'});
	assert.equal(repeated.state, 'unchanged');
	assert.equal(repeated.record.installedHash, result.record.installedHash);
});

test('marketplace install uses the same conventional-path disambiguation as metadata resolution', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const manifest = text('---\nname: azure-storage\ndescription: Azure Storage guidance.\n---\n');
	const runtime: MarketplaceRuntime = {get: url => {
		const responses: Readonly<Record<string, Uint8Array>> = {
			'https://api.github.com/repos/microsoft/azure-skills': json({private: false, default_branch: 'main'}),
			'https://api.github.com/repos/microsoft/azure-skills/git/ref/heads/main': json({object: {sha: commit}}),
			[`https://api.github.com/repos/microsoft/azure-skills/git/trees/${commit}?recursive=1`]: json({truncated: false, tree: [
				{path: '.github/plugins/azure-skills/skills/azure-storage/SKILL.md', type: 'blob', mode: '100644', size: manifest.length},
				{path: 'skills/azure-storage/SKILL.md', type: 'blob', mode: '100644', size: manifest.length},
			]}),
			[`https://raw.githubusercontent.com/microsoft/azure-skills/${commit}/.github/plugins/azure-skills/skills/azure-storage/SKILL.md`]: manifest,
			[`https://raw.githubusercontent.com/microsoft/azure-skills/${commit}/skills/azure-storage/SKILL.md`]: manifest,
		};
		const body = responses[url];
		return Promise.resolve(body === undefined ? {status: 404, url, body: text('missing')} : {status: 200, url, body});
	}};

	const result = await installMarketplaceSkill(layout, runtime, {source: 'microsoft/azure-skills', skill: 'azure-storage'});
	assert.equal(result.record.relativePath, 'skills/azure-storage');
	assert.equal(await readFile(join(layout.amc.skills, 'azure-storage', 'SKILL.md'), 'utf8'), new TextDecoder().decode(manifest));
});

test('marketplace install moves an unverifiable canonical candidate to failed recovery', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await assert.rejects(installMarketplaceSkill(layout, installRuntime(), {source: 'example/skills', skill: 'alpha'}, {
		afterMove: path => writeFile(join(path, 'SKILL.md'), 'corrupted'),
	}), /verification/u);
	assert.equal(await pathExists(join(layout.amc.skills, 'alpha')), false);
	assert.equal((await readInstalledSkills(layout))['alpha'], undefined);
});

test('marketplace install rejects a short remote file before creating canonical content', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const base = installRuntime();
	const short: MarketplaceRuntime = {get: (url, maximumBytes, timeoutMs) => url.endsWith('/script.sh')
		? Promise.resolve({status: 200, url, body: text('')})
		: base.get(url, maximumBytes, timeoutMs)};
	await assert.rejects(installMarketplaceSkill(layout, short, {source: 'example/skills', skill: 'alpha'}), /size|content/u);
	assert.equal(await pathExists(join(layout.amc.skills, 'alpha')), false);
});

test('marketplace install refuses untracked and different-source collisions without overwrite', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha', 'local bytes');
	await assert.rejects(installMarketplaceSkill(layout, installRuntime(), {source: 'example/skills', skill: 'alpha'}), /conflict|untracked/u);
	assert.equal(await readFile(join(layout.amc.skills, 'alpha', 'SKILL.md'), 'utf8'), 'local bytes');

	const otherHome = await createTestHome();
	const otherLayout = createLayout(otherHome);
	await installMarketplaceSkill(otherLayout, installRuntime(), {source: 'example/skills', skill: 'alpha'});
	await assert.rejects(installMarketplaceSkill(otherLayout, installRuntime('another'), {source: 'another/skills', skill: 'alpha'}), /different source|conflict/u);
	assert.equal((await readInstalledSkills(otherLayout))['alpha']?.owner, 'example');
});

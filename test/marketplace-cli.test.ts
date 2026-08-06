import assert from 'node:assert/strict';
import test from 'node:test';
import {executeCommand, type ResourceExecution} from '../src/cli/index.js';
import {createLayout} from '../src/core/index.js';
import type {MarketplaceRuntime} from '../src/core/marketplace.js';
import {createTestHome, pathExists} from './helpers.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function marketplaceRuntime(): MarketplaceRuntime {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const manifest = '---\nname: alpha\ndescription: CLI skill.\n---\n# Alpha\n';
	return {get: url => {
		const responses: Readonly<Record<string, Uint8Array>> = {
			'https://api.github.com/repos/example/skills': json({private: false, default_branch: 'main'}),
			'https://api.github.com/repos/example/skills/git/ref/heads/main': json({object: {sha: commit}}),
			[`https://api.github.com/repos/example/skills/git/trees/${commit}?recursive=1`]: json({truncated: false, tree: [{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: text(manifest).length}]}),
			[`https://raw.githubusercontent.com/example/skills/${commit}/skills/alpha/SKILL.md`]: text(manifest),
			'https://skills.sh/api/search?q=alpha&limit=20': json({skills: [{id: 'example/skills/alpha', skillId: 'alpha', name: 'alpha', source: 'example/skills', installs: 10}]}),
		};
		const body = responses[url];
		return Promise.resolve(body === undefined ? {status: 404, url, body: text('missing')} : {status: 200, url, body});
	}};
}

function execution(home: string): ResourceExecution {
	return {
		context: {home, cwd: home},
		runtime: {
			run: () => Promise.resolve({exitCode: 0, stdout: '', stderr: ''}),
			openEditor: () => Promise.resolve(),
		},
		marketplace: marketplaceRuntime(),
	};
}

test('headless marketplace commands share repository, search, install, upgrade, and delete core flows', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const resources = execution(home);

	assert.match(await executeCommand(layout, {kind: 'repos-add', source: 'example/skills', branch: undefined}, undefined, resources), /Added example\/skills/u);
	assert.match(await executeCommand(layout, {kind: 'repos-list'}, undefined, resources), /example\/skills.*main.*1 Skill/u);
	assert.match(await executeCommand(layout, {kind: 'repos-disable', source: 'example/skills'}, undefined, resources), /Disabled/u);
	assert.match(await executeCommand(layout, {kind: 'repos-enable', source: 'example/skills'}, undefined, resources), /Enabled/u);
	assert.match(await executeCommand(layout, {kind: 'marketplace-search', query: 'alpha', source: undefined}, undefined, resources), /alpha.*example\/skills.*10/u);
	assert.match(await executeCommand(layout, {kind: 'install', source: 'example/skills', skill: 'alpha', branch: undefined}, undefined, resources), /Installed alpha/u);
	assert.match(await executeCommand(layout, {kind: 'upgrade', name: 'alpha'}, undefined, resources), /unchanged/u);
	assert.match(await executeCommand(layout, {kind: 'delete', name: 'alpha', confirmation: 'alpha'}, undefined, resources), /Permanently deleted alpha/u);
	assert.equal(await pathExists(layout.amc.skills), true);
	assert.equal(await pathExists(`${layout.amc.skills}/alpha`), false);
});

import assert from 'node:assert/strict';
import {join} from 'node:path';
import test from 'node:test';
import {createLayout, listSkills, setSkillEnabled} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

test('shared .agent and .agents Skills report effective Pi and Codex discovery without writes', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(join(home, '.agents', 'skills'), 'from-agents');
	await writeSkill(join(home, '.agent', 'skills'), 'from-agent');

	const result = await listSkills(layout);

	assert.deepEqual(result.skills, [
		{
			name: 'from-agent',
			canonical: false,
			states: {claude: 'disabled', pi: 'shared', codex: 'shared'},
		},
		{
			name: 'from-agents',
			canonical: false,
			states: {claude: 'disabled', pi: 'shared', codex: 'shared'},
		},
	]);
	assert.deepEqual(result.diagnostics, []);
	assert.equal(await pathExists(layout.amc.root), false);
});

test('source discovery is direct-child only and reports invalid top-level entries', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(join(layout.sources.agents, 'collection'), 'nested');

	const result = await listSkills(layout);

	assert.deepEqual(result.skills, []);
	assert.equal(result.diagnostics.length, 1);
	assert.match(result.diagnostics[0]?.path ?? '', /\.agents\/skills\/collection$/u);
	assert.equal(await pathExists(layout.amc.root), false);
});

test('prototype is a safe Skill name that can be enabled and disabled', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'prototype');

	await setSkillEnabled(layout, 'prototype', true, ['claude']);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'prototype')), join(layout.amc.skills, 'prototype'));

	await setSkillEnabled(layout, 'prototype', false, ['claude']);
	assert.equal(await resolvedLink(join(layout.amc.disabledLinks, 'claude', 'prototype')), join(layout.amc.skills, 'prototype'));
});

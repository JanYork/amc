import assert from 'node:assert/strict';
import {mkdir, symlink, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import test from 'node:test';
import {createLayout, listSkills, readSkillDetails, setSkillEnabled, targets} from '../src/core/index.js';
import {createTestHome, pathExists, resolvedLink, writeSkill} from './helpers.js';

test('createLayout maps the canonical store and all three Agent targets', () => {
	assert.deepEqual(createLayout('/tmp/amc-home'), {
		home: '/tmp/amc-home',
		amc: {
			root: '/tmp/amc-home/.amc',
			skills: '/tmp/amc-home/.amc/skills',
			backups: '/tmp/amc-home/.amc/backups',
			disabledLinks: '/tmp/amc-home/.amc/disabled-links',
			staging: '/tmp/amc-home/.amc/staging',
			failed: '/tmp/amc-home/.amc/failed',
		},
		targets: {
			claude: '/tmp/amc-home/.claude/skills',
			pi: '/tmp/amc-home/.pi/agent/skills',
			codex: '/tmp/amc-home/.codex/skills',
		},
	});
});

test('listSkills treats missing stores as empty and remains read-only', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);

	assert.deepEqual(await listSkills(layout), {skills: [], diagnostics: []});
	assert.equal(await pathExists(layout.amc.root), false);
	assert.equal(await pathExists(join(home, '.claude')), false);
	assert.equal(await pathExists(join(home, '.pi')), false);
	assert.equal(await pathExists(join(home, '.codex')), false);
});

test('listSkills returns the sorted union with independent target states', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const alpha = await writeSkill(layout.amc.skills, 'alpha', 'alpha canonical');
	await writeSkill(layout.amc.skills, 'delta', 'delta canonical');
	await mkdir(layout.targets.claude, {recursive: true});
	await symlink(alpha, join(layout.targets.claude, 'alpha'));
	await writeSkill(layout.targets.codex, 'alpha', 'alpha unmanaged');
	await writeSkill(layout.targets.pi, 'beta', 'beta unmanaged');
	const external = await writeSkill(join(home, 'external'), 'delta', 'delta external');
	await symlink(external, join(layout.targets.claude, 'delta'));
	await symlink(join(home, 'missing-skill'), join(layout.targets.pi, 'broken-only'));
	await writeFile(join(layout.targets.codex, 'junk'), 'not a Skill');

	const result = await listSkills(layout);

	assert.deepEqual(result.skills, [
		{
			name: 'alpha',
			canonical: true,
			states: {claude: 'enabled', pi: 'disabled', codex: 'unmanaged'},
		},
		{
			name: 'beta',
			canonical: false,
			states: {claude: 'disabled', pi: 'unmanaged', codex: 'disabled'},
		},
		{
			name: 'delta',
			canonical: true,
			states: {claude: 'unmanaged', pi: 'disabled', codex: 'disabled'},
		},
	]);
	assert.deepEqual(
		result.diagnostics.map(diagnostic => basename(diagnostic.path)).sort(),
		['broken-only', 'junk'],
	);
	assert.equal(await pathExists(layout.amc.backups), false);
});

test('readSkillDetails reads inline and block frontmatter descriptions', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha', `---
name: alpha
description: "Review code safely."
---
`);
	await writeSkill(layout.amc.skills, 'beta', `---
name: beta
description: |
  Build a plan first.
  Then execute it.
---
`);

	assert.deepEqual(await readSkillDetails(layout, 'alpha'), {
		name: 'alpha',
		description: 'Review code safely.',
		sourcePath: join(layout.amc.skills, 'alpha', 'SKILL.md'),
	});
	assert.equal(
		(await readSkillDetails(layout, 'beta')).description,
		'Build a plan first. Then execute it.',
	);
});

test('readSkillDetails falls back to body text and resolves an unmanaged source', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const source = await writeSkill(layout.targets.pi, 'gamma', `# Gamma

Summarize the current project.

## Instructions
Ignore this later section.
`);

	assert.deepEqual(await readSkillDetails(layout, 'gamma'), {
		name: 'gamma',
		description: 'Summarize the current project.',
		sourcePath: join(source, 'SKILL.md'),
	});
});

test('setSkillEnabled enables every target by default and repeated enable is a no-op', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha');

	const enabled = await setSkillEnabled(layout, 'alpha', true);

	assert.deepEqual(enabled.changes.map(change => [change.target, change.changed]), [
		['claude', true],
		['pi', true],
		['codex', true],
	]);
	for (const target of targets) {
		assert.equal(await resolvedLink(join(layout.targets[target], 'alpha')), canonical);
	}
	const repeated = await setSkillEnabled(layout, 'alpha', true);
	assert.equal(repeated.changes.every(change => !change.changed), true);
});

test('setSkillEnabled parks, restores, and scopes a managed link to one target', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha');
	await setSkillEnabled(layout, 'alpha', true);

	const disabled = await setSkillEnabled(layout, 'alpha', false, ['codex']);

	assert.deepEqual(disabled.changes, [
		{target: 'codex', before: 'enabled', after: 'disabled', changed: true},
	]);
	assert.equal(await pathExists(join(layout.targets.codex, 'alpha')), false);
	assert.equal(
		await resolvedLink(join(layout.amc.disabledLinks, 'codex', 'alpha')),
		canonical,
	);
	assert.equal(await resolvedLink(join(layout.targets.claude, 'alpha')), canonical);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), canonical);
	const repeated = await setSkillEnabled(layout, 'alpha', false, ['codex']);
	assert.equal(repeated.changes[0]?.changed, false);

	await setSkillEnabled(layout, 'alpha', true, ['codex']);
	assert.equal(await resolvedLink(join(layout.targets.codex, 'alpha')), canonical);
	assert.equal(await pathExists(join(layout.amc.disabledLinks, 'codex', 'alpha')), false);
});

test('setSkillEnabled aborts every selected target before writes on conflict', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha');
	const foreign = await writeSkill(join(home, 'foreign'), 'alpha');
	await mkdir(layout.targets.pi, {recursive: true});
	await symlink(foreign, join(layout.targets.pi, 'alpha'));

	await assert.rejects(setSkillEnabled(layout, 'alpha', true), {
		name: 'AmcError',
		code: 'TARGET_BLOCKED',
	});
	assert.equal(await pathExists(join(layout.targets.claude, 'alpha')), false);
	assert.equal(await resolvedLink(join(layout.targets.pi, 'alpha')), foreign);
	assert.equal(await pathExists(join(layout.targets.codex, 'alpha')), false);
});

test('setSkillEnabled detects every parking collision before disabling any target', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const canonical = await writeSkill(layout.amc.skills, 'alpha');
	await setSkillEnabled(layout, 'alpha', true);
	const collision = join(layout.amc.disabledLinks, 'pi', 'alpha');
	await mkdir(join(layout.amc.disabledLinks, 'pi'), {recursive: true});
	await writeFile(collision, 'preserve me');

	await assert.rejects(setSkillEnabled(layout, 'alpha', false), {
		name: 'AmcError',
		code: 'PARKING_BLOCKED',
	});
	for (const target of targets) {
		assert.equal(await resolvedLink(join(layout.targets[target], 'alpha')), canonical);
	}
	assert.equal(await pathExists(collision), true);
});

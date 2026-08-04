import assert from 'node:assert/strict';
import {mkdir, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {render} from 'ink-testing-library';
import {App} from '../src/tui/App.js';
import {createLayout, setSkillEnabled} from '../src/core/index.js';
import {createTestHome, resolvedLink, writeSkill} from './helpers.js';

async function waitForFrame(
	lastFrame: () => string | undefined,
	pattern: RegExp,
): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const frame = lastFrame() ?? '';
		if (pattern.test(frame)) {
			return frame;
		}
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
	assert.fail(`Timed out waiting for ${pattern}. Last frame:\n${lastFrame() ?? ''}`);
}

test('Ink TUI renders loading and empty states', async () => {
	const home = await createTestHome();
	const instance = render(<App layout={createLayout(home)}/>);

	assert.match(instance.frames[0] ?? '', /Loading Skills/);
	assert.match(await waitForFrame(instance.lastFrame, /No Skills found/), /AMC — Agent Management CLI/);
	instance.unmount();
});

test('Ink TUI navigates, confirms migration, and toggles one target through core', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha');
	await setSkillEnabled(layout, 'alpha', true, ['claude']);
	await writeSkill(layout.targets.pi, 'beta', 'migrate beta');
	const instance = render(<App layout={layout}/>);

	const list = await waitForFrame(instance.lastFrame, /alpha/);
	assert.match(list, /Skill\s+Claude\s+Pi\s+Codex/);
	assert.match(list, /› alpha/);
	instance.stdin.write('j');
	assert.match(await waitForFrame(instance.lastFrame, /› beta/), /\?/);

	instance.stdin.write('m');
	assert.match(await waitForFrame(instance.lastFrame, /Migrate beta\?/), /y confirm/);
	instance.stdin.write('y');
	assert.match(await waitForFrame(instance.lastFrame, /Migrated beta/), /●/);
	const canonical = join(layout.amc.skills, 'beta');
	assert.equal(await resolvedLink(join(layout.targets.pi, 'beta')), canonical);

	instance.stdin.write('3');
	assert.match(await waitForFrame(instance.lastFrame, /Enabled beta/), /codex=changed/);
	assert.equal(await resolvedLink(join(layout.targets.codex, 'beta')), canonical);
	instance.stdin.write('q');
});

test('Ink TUI exposes divergence choice and non-destructive conflict errors', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', 'claude');
	await writeSkill(layout.targets.pi, 'alpha', 'pi');
	const instance = render(<App layout={layout}/>);
	await waitForFrame(instance.lastFrame, /› alpha/);

	instance.stdin.write('m');
	assert.match(await waitForFrame(instance.lastFrame, /Choose source/), /1 Claude.*2 Pi.*3 Codex/);
	instance.stdin.write('2');
	assert.match(await waitForFrame(instance.lastFrame, /Source: pi/), /Migrate alpha\?/);
	instance.stdin.write('n');
	assert.match(await waitForFrame(instance.lastFrame, /Migration cancelled/), /› alpha/);
	instance.unmount();

	const conflictHome = await createTestHome();
	const conflictLayout = createLayout(conflictHome);
	await writeSkill(conflictLayout.amc.skills, 'delta');
	const foreign = await writeSkill(join(conflictHome, 'foreign'), 'delta');
	await mkdir(conflictLayout.targets.claude, {recursive: true});
	await symlink(foreign, join(conflictLayout.targets.claude, 'delta'));
	const conflicted = render(<App layout={conflictLayout}/>);
	await waitForFrame(conflicted.lastFrame, /› delta/);
	conflicted.stdin.write(' ');
	assert.match(await waitForFrame(conflicted.lastFrame, /TARGET_BLOCKED/), /!/);
	assert.equal(await resolvedLink(join(conflictLayout.targets.claude, 'delta')), foreign);
	conflicted.unmount();
});

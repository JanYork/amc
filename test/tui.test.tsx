import assert from 'node:assert/strict';
import {mkdir, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import test from 'node:test';
import {render} from 'ink-testing-library';
import {App, ManagedApp} from '../src/tui/App.js';
import {createLayout, setSkillEnabled} from '../src/core/index.js';
import type {ResourceRuntime} from '../src/core/resources.js';
import type {TerminalPresentation} from '../src/presentation/theme.js';
import {createTestHome, resolvedLink, writeSkill} from './helpers.js';

const darkPresentation: TerminalPresentation = {theme: 'dark', colorDepth: 24};

const resourceRuntime: ResourceRuntime = {
	run: (program, arguments_) => {
		void arguments_;
		if (program === 'claude') {
			return Promise.resolve({exitCode: 0, stdout: '[{"id":"review@official","enabled":true,"scope":"user"}]', stderr: ''});
		}
		return Promise.resolve({exitCode: 0, stdout: program === 'codex' ? '{"installed":[]}' : '', stderr: ''});
	},
	openEditor: () => Promise.resolve(),
};

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
	const instance = render(<App layout={createLayout(home)} presentation={darkPresentation}/>);

	assert.match(instance.frames[0] ?? '', /Loading Skills/);
	assert.match(await waitForFrame(instance.lastFrame, /No Skills found/), /AMC  0 Skills  ·  0 warnings/);
	instance.unmount();
});

test('managed TUI switches among Skills, Hooks, and Plugins with bounded resource actions', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await mkdir(join(home, '.claude'), {recursive: true});
	await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({
		hooks: {Stop: [{hooks: [{type: 'command'}]}]},
	}), 'utf8');
	let editedId: string | undefined;
	const instance = render(
		<ManagedApp
			layout={layout}
			presentation={darkPresentation}
			resources={{context: {home, cwd: home}, runtime: resourceRuntime}}
			windowSize={{columns: 90, rows: 16}}
			onHookEdit={id => {
				editedId = id;
			}}
		/>,
	);

	assert.match(await waitForFrame(instance.lastFrame, /No Skills found/), /Skills.*Hooks.*Plugins/);
	instance.stdin.write('\t');
	assert.match(await waitForFrame(instance.lastFrame, /Stop.*command/), /Hooks/);
	instance.stdin.write('\t');
	assert.match(await waitForFrame(instance.lastFrame, /review@official/), /native-headless/);
	instance.stdin.write('\t');
	await waitForFrame(instance.lastFrame, /No Skills found/);
	instance.stdin.write('\t');
	await waitForFrame(instance.lastFrame, /Stop.*command/);
	instance.stdin.write('e');
	assert.match(editedId ?? '', /^[a-f0-9]{16}$/u);
});

test('Ink TUI shows the selected Skill description and source path', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha', `---
name: alpha
description: Reviews code for correctness and maintainability.
---

# Alpha
`);
	await writeSkill(layout.amc.skills, 'beta', `# Beta

Creates a concise implementation plan.
`);
	const instance = render(
		<App layout={layout} presentation={darkPresentation} windowSize={{columns: 100, rows: 16}}/>,
	);

	const frame = await waitForFrame(instance.lastFrame, /Description\nReviews code/);
	assert.match(frame, /Source: .*alpha\/SKILL\.md/);
	assert.ok(frame.split('\n').length <= 16, frame);
	instance.stdin.write('j');
	const nextFrame = await waitForFrame(instance.lastFrame, /Description\nCreates a concise/);
	assert.match(nextFrame, /Source: .*beta\/SKILL\.md/);
	instance.unmount();
});

test('Ink TUI follows the selected scope for divergent Skill details', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', '# Alpha\n\nClaude description.\n');
	await writeSkill(layout.targets.pi, 'alpha', '# Alpha\n\nPi description.\n');
	const instance = render(
		<App layout={layout} presentation={darkPresentation} windowSize={{columns: 100, rows: 16}}/>,
	);

	await waitForFrame(instance.lastFrame, /Description\nClaude description/);
	instance.stdin.write('\u001B[C\u001B[C');
	const piFrame = await waitForFrame(instance.lastFrame, /Description\nPi description/);
	assert.match(piFrame, /Scope: Pi/);
	assert.match(piFrame, /Source:.*\.pi\/agent\/skills\/alpha\//);
	instance.unmount();
});

test('Ink TUI wraps a long description below its label without exceeding the viewport', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha', `---
name: alpha
description: Run read-only deep repository analysis and return a ranked synthesis with explicit confidence.
---
`);
	const instance = render(
		<App layout={layout} presentation={darkPresentation} windowSize={{columns: 60, rows: 16}}/>,
	);

	const frame = await waitForFrame(instance.lastFrame, /synthesis with explicit/);
	const lines = frame.split('\n');
	const labelIndex = lines.findIndex(line => line.trim() === 'Description');
	assert.notEqual(labelIndex, -1, frame);
	assert.match(lines[labelIndex + 1] ?? '', /^Run read-only deep repository analysis/u);
	assert.match(lines[labelIndex + 1] ?? '', /ranked$/u);
	assert.match(lines[labelIndex + 2] ?? '', /^synthesis with explicit/u);
	assert.match(lines[labelIndex + 3] ?? '', /^Source:/u);
	assert.ok(lines.length <= 16, frame);
	instance.unmount();
});

test('Ink TUI uses a one-cell focused fallback in mono mode', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha');
	await setSkillEnabled(layout, 'alpha', true, ['claude']);
	const presentation: TerminalPresentation = {theme: 'mono', colorDepth: 1};
	const instance = render(<App layout={layout} presentation={presentation}/>);
	await waitForFrame(instance.lastFrame, /› alpha/);
	instance.stdin.write('\u001B[C');
	const focused = await waitForFrame(instance.lastFrame, /Scope: Claude/);
	assert.match(focused, /◉/u);
	assert.doesNotMatch(focused, /⃝/u);
	instance.unmount();
});

test('Ink TUI navigates, confirms migration, and toggles one target through core', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha');
	await setSkillEnabled(layout, 'alpha', true, ['claude']);
	await writeSkill(layout.targets.pi, 'beta', 'migrate beta');
	const instance = render(<App layout={layout} presentation={darkPresentation}/>);

	const list = await waitForFrame(instance.lastFrame, /alpha/);
	assert.match(list, /Skill.*Claude.*Pi.*Codex/);
	assert.match(list, /┌.*┬.*┐/);
	assert.match(list, /├.*┼.*┤/);
	assert.match(list, /└.*┴.*┘/);
	assert.match(list, /› alpha/);
	instance.stdin.write('\u001B[C');
	const focused = await waitForFrame(instance.lastFrame, /Scope: Claude/);
	assert.match(focused, /◉/u);
	assert.doesNotMatch(focused, /⃝/u);
	instance.stdin.write('\u001B[D');
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

test('Ink TUI exposes divergence choice and blocks direct toggles of unmanaged entries', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.targets.claude, 'alpha', 'claude');
	await writeSkill(layout.targets.pi, 'alpha', 'pi');
	const instance = render(<App layout={layout} presentation={darkPresentation}/>);
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
	const conflicted = render(<App layout={conflictLayout} presentation={darkPresentation}/>);
	assert.match(await waitForFrame(conflicted.lastFrame, /› delta/), /› delta.*◇/);
	conflicted.stdin.write(' ');
	assert.match(await waitForFrame(conflicted.lastFrame, /TARGET_BLOCKED/), /Target claude is unmanaged/);
	assert.equal(await resolvedLink(join(conflictLayout.targets.claude, 'delta')), foreign);
	conflicted.unmount();
});

test('Ink TUI keeps a large list inside the terminal viewport while arrows and pages scroll', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	for (let index = 0; index < 30; index += 1) {
		await writeSkill(layout.amc.skills, `item-${String(index).padStart(2, '0')}`);
	}
	const instance = render(<App layout={layout} presentation={darkPresentation} windowSize={{columns: 80, rows: 12}}/>);

	const first = await waitForFrame(instance.lastFrame, /› item-00/);
	assert.equal(first.split('\n').filter(line => /item-\d{2}/u.test(line)).length, 2);
	assert.match(first, /1–2 \/ 30/);
	assert.match(first, /┌.*┬.*┐/);

	for (let step = 0; step < 6; step += 1) {
		instance.stdin.write('\u001B[B');
	}
	const scrolled = await waitForFrame(instance.lastFrame, /› item-06/);
	assert.equal(scrolled.split('\n').filter(line => /item-\d{2}/u.test(line)).length, 2);
	assert.doesNotMatch(scrolled, /item-00/);

	instance.stdin.write('\u001B[6~');
	assert.match(await waitForFrame(instance.lastFrame, /› item-08/), /↓ more/);
	instance.stdin.write('\u001B[H');
	assert.match(await waitForFrame(instance.lastFrame, /› item-00/), /1–2 \/ 30/);
	instance.stdin.write('\u001B[F');
	assert.match(await waitForFrame(instance.lastFrame, /› item-29/), /29–30 \/ 30/);
	instance.unmount();
});

test('Ink TUI supports live search, clear, scope arrows, and help without growing the frame', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	for (let index = 0; index < 30; index += 1) {
		await writeSkill(layout.amc.skills, `item-${String(index).padStart(2, '0')}`);
	}
	const instance = render(<App layout={layout} presentation={darkPresentation} windowSize={{columns: 80, rows: 12}}/>);
	await waitForFrame(instance.lastFrame, /› item-00/);

	instance.stdin.write('/');
	await waitForFrame(instance.lastFrame, /Search: —█/);
	instance.stdin.write('item-2');
	const searched = await waitForFrame(instance.lastFrame, /› item-20/);
	assert.match(searched, /Search: item-2/);
	assert.match(searched, /1–2 \/ 10/);
	assert.ok(searched.split('\n').length <= 12, searched);

	instance.stdin.write('\r');
	await waitForFrame(instance.lastFrame, /Ready\./);
	instance.stdin.write('\u001B');
	assert.match(await waitForFrame(instance.lastFrame, /Search: —/), /30 Skills/);

	instance.stdin.write('\u001B[C');
	assert.match(await waitForFrame(instance.lastFrame, /Scope: Claude/), /› item-20|› item-00/);
	instance.stdin.write('?');
	const help = await waitForFrame(instance.lastFrame, /Keyboard/);
	assert.match(help, /Page Up\/Down/);
	assert.ok(help.split('\n').length <= 12, help);
	instance.stdin.write('?');
	assert.doesNotMatch(await waitForFrame(instance.lastFrame, /› item-00/), /Keyboard/);
	instance.unmount();
});

test('Ink TUI truncates long rows and renders a bounded undersized-terminal message', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, `skill-${'long-name-'.repeat(10)}`);

	const compact = render(<App layout={layout} presentation={darkPresentation} windowSize={{columns: 44, rows: 10}}/>);
	const compactFrame = await waitForFrame(compact.lastFrame, /skill-/);
	assert.ok(compactFrame.split('\n').length <= 10, compactFrame);
	assert.match(compactFrame, /…/);
	compact.unmount();

	const small = render(<App layout={layout} presentation={darkPresentation} windowSize={{columns: 43, rows: 9}}/>);
	const smallFrame = await waitForFrame(small.lastFrame, /Terminal too small/);
	assert.match(smallFrame, /44×10/);
	assert.doesNotMatch(smallFrame, /skill-long-name/);
	assert.ok(smallFrame.split('\n').length <= 9, smallFrame);
	small.unmount();
});

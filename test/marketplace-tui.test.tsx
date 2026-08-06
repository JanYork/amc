import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {render} from 'ink-testing-library';
import {installMarketplaceSkill, type MarketplaceRuntime} from '../src/core/marketplace.js';
import {createLayout} from '../src/core/index.js';
import {MarketplaceView} from '../src/tui/MarketplaceView.js';
import {App} from '../src/tui/App.js';
import {createTestHome, pathExists, writeSkill} from './helpers.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function runtime(): MarketplaceRuntime {
	const commit = '0123456789abcdef0123456789abcdef01234567';
	const manifest = '---\nname: alpha\ndescription: TUI skill.\n---\n# Alpha\n';
	return {get: url => {
		const responses: Readonly<Record<string, Uint8Array>> = {
			'https://skills.sh/api/skills/all-time/0': json({skills: [{skillId: 'alpha', name: 'alpha', source: 'example/skills', installs: 10}], page: 0, total: 1, hasMore: false}),
			'https://skills.sh/api/search?q=alpha&limit=20': json({skills: [{id: 'example/skills/alpha', skillId: 'alpha', name: 'alpha', source: 'example/skills', installs: 10}]}),
			'https://api.github.com/repos/example/skills': json({private: false, default_branch: 'main'}),
			'https://api.github.com/repos/example/skills/git/ref/heads/main': json({object: {sha: commit}}),
			[`https://api.github.com/repos/example/skills/git/trees/${commit}?recursive=1`]: json({truncated: false, tree: [{path: 'skills/alpha/SKILL.md', type: 'blob', mode: '100644', size: text(manifest).length}]}),
			[`https://raw.githubusercontent.com/example/skills/${commit}/skills/alpha/SKILL.md`]: text(manifest),
		};
		const body = responses[url];
		return Promise.resolve(body === undefined ? {status: 404, url, body: text('missing')} : {status: 200, url, body});
	}};
}

function manyRuntime(): MarketplaceRuntime {
	const leads = Array.from({length: 15}, (_, index) => ({
		id: `missing/skills/many-${String(index + 1).padStart(2, '0')}`,
		skillId: `many-${String(index + 1).padStart(2, '0')}`,
		name: `many-${String(index + 1).padStart(2, '0')}`,
		source: 'missing/skills',
		installs: 15 - index,
	}));
	return {get: url => Promise.resolve(url === 'https://skills.sh/api/search?q=many&limit=20'
		? {status: 200, url, body: json({skills: leads})}
		: {status: 404, url, body: text('missing')})};
}

function pagedRuntime(): MarketplaceRuntime {
	const page = (start: number, count: number) => Array.from({length: count}, (_, index) => ({
		skillId: `popular-${start + index}`,
		name: `popular-${start + index}`,
		source: 'missing/skills',
		installs: 100 - start - index,
	}));
	return {get: url => {
		const responses: Readonly<Record<string, Uint8Array>> = {
			'https://skills.sh/api/skills/all-time/0': json({skills: page(1, 6), page: 0, total: 8, hasMore: true}),
			'https://skills.sh/api/skills/all-time/1': json({skills: page(7, 2), page: 1, total: 8, hasMore: false}),
		};
		const body = responses[url];
		return Promise.resolve(body === undefined ? {status: 404, url, body: text('missing')} : {status: 200, url, body});
	}};
}

async function waitFor(lastFrame: () => string | undefined, pattern: RegExp): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const frame = lastFrame() ?? '';
		if (pattern.test(frame)) return frame;
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
	assert.fail(`Timed out waiting for ${pattern}: ${lastFrame() ?? ''}`);
}

test('marketplace table follows the shared themed selection and state palette', async () => {
	const source = await readFile(resolve('src/tui/MarketplaceView.tsx'), 'utf8');
	assert.doesNotMatch(source, /inverse=/u);
	assert.match(source, /palette\.accent/u);
	assert.match(source, /palette\.enabled/u);
	assert.match(source, /palette\.muted/u);
});

test('marketplace TUI loads the skills.sh all-time leaderboard on first open', async () => {
	const home = await createTestHome();
	const instance = render(<MarketplaceView layout={createLayout(home)} runtime={runtime()} presentation={{theme: 'dark', colorDepth: 24}} windowSize={{columns: 120, rows: 24}}/>);
	const frame = await waitFor(instance.lastFrame, /TUI skill\./u);
	assert.match(frame, /Marketplace · 1 loaded \/ 1/u);
	assert.match(frame, /Skill.*Source.*Origin.*Installs.*Installed/su);
	assert.match(frame, /alpha.*example\/skills.*skills\.sh.*10.*○ No/su);
	assert.match(frame, /Loaded 1 of 1 popular Skills/u);
	instance.unmount();
});

test('marketplace TUI marks an existing canonical Skill as installed', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'alpha', 'already installed');
	const instance = render(<MarketplaceView layout={layout} runtime={runtime()} presentation={{theme: 'dark', colorDepth: 24}} windowSize={{columns: 120, rows: 24}}/>);
	const frame = await waitFor(instance.lastFrame, /● Yes/u);
	assert.match(frame, /alpha.*● Yes/su);
	instance.unmount();
});

test('marketplace TUI incrementally loads the next leaderboard page near the list end', async () => {
	const home = await createTestHome();
	const instance = render(<MarketplaceView layout={createLayout(home)} runtime={pagedRuntime()} presentation={{theme: 'dark', colorDepth: 24}} windowSize={{columns: 72, rows: 15}}/>);
	await waitFor(instance.lastFrame, /6 loaded \/ 8/u);
	instance.stdin.write('\u001B[B');
	const loaded = await waitFor(instance.lastFrame, /8 loaded \/ 8/u);
	assert.match(loaded, /Loaded 8 of 8 popular Skills/u);
	for (let index = 0; index < 6; index += 1) instance.stdin.write('\u001B[B');
	assert.match(await waitFor(instance.lastFrame, /popular-8/u), /6–8 \/ 8/u);
	instance.unmount();
});

test('marketplace TUI searches registry leads and installs the selected Skill', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const instance = render(<MarketplaceView layout={layout} runtime={runtime()} presentation={{theme: 'dark', colorDepth: 24}} windowSize={{columns: 120, rows: 24}}/>);
	instance.stdin.write('/');
	await waitFor(instance.lastFrame, /Search: █/u);
	instance.stdin.write('alpha');
	await waitFor(instance.lastFrame, /Search: alpha█/u);
	instance.stdin.write('\r');
	await waitFor(instance.lastFrame, /1 results\./u);
	const table = await waitFor(instance.lastFrame, /TUI skill\./u);
	assert.match(table, /Marketplace · 1 result/u);
	assert.match(table, /┌.*Skill.*Source.*Origin.*Installs.*├.*alpha.*example\/skills.*skills\.sh.*10.*└/su);
	assert.match(table, /Description\s+TUI skill\./su);
	assert.match(table, /Path: skills\/alpha · Branch: main · Live/u);
	instance.stdin.write('i');
	assert.match(await waitFor(instance.lastFrame, /Installed alpha/u), /Providers remain disabled/u);
	assert.match(await waitFor(instance.lastFrame, /● Yes/u), /alpha/u);
	assert.equal(await pathExists(`${layout.amc.skills}/alpha`), true);
	instance.unmount();
});

test('marketplace table hides the Origin column when terminal width is constrained', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const instance = render(<MarketplaceView layout={layout} runtime={runtime()} presentation={{theme: 'dark', colorDepth: 24}} windowSize={{columns: 72, rows: 20}}/>);
	instance.stdin.write('/');
	await waitFor(instance.lastFrame, /Search: █/u);
	instance.stdin.write('alpha');
	await waitFor(instance.lastFrame, /Search: alpha█/u);
	instance.stdin.write('\r');
	const frame = await waitFor(instance.lastFrame, /TUI skill\./u);
	assert.match(frame, /Skill.*Source.*Installs.*Installed/u);
	assert.doesNotMatch(frame, /Origin/u);
	instance.unmount();
});

test('marketplace table sizes its result window from terminal height and reports unavailable descriptions', async () => {
	const home = await createTestHome();
	const instance = render(<MarketplaceView layout={createLayout(home)} runtime={manyRuntime()} presentation={{theme: 'dark', colorDepth: 24}} windowSize={{columns: 72, rows: 15}}/>);
	instance.stdin.write('/');
	await waitFor(instance.lastFrame, /Search: █/u);
	instance.stdin.write('many');
	await waitFor(instance.lastFrame, /Search: many█/u);
	instance.stdin.write('\r');
	const first = await waitFor(instance.lastFrame, /Description unavailable:/u);
	assert.match(first, /many-01.*many-02.*many-03/su);
	assert.doesNotMatch(first, /many-04/u);
	assert.match(first, /1–3 \/ 15/u);
	instance.stdin.write('\u001B[B');
	instance.stdin.write('\u001B[B');
	instance.stdin.write('\u001B[B');
	const moved = await waitFor(instance.lastFrame, /3–5 \/ 15/u);
	assert.match(moved, /many-03.*many-04.*many-05/su);
	instance.unmount();
});

test('marketplace TUI lists, toggles, refreshes, and removes validated repositories', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	const instance = render(<MarketplaceView layout={layout} runtime={runtime()} presentation={{theme: 'dark', colorDepth: 24}}/>);
	instance.stdin.write('a');
	await waitFor(instance.lastFrame, /Repository: █/u);
	instance.stdin.write('example/skills');
	await waitFor(instance.lastFrame, /Repository: example\/skills█/u);
	instance.stdin.write('\r');
	await waitFor(instance.lastFrame, /Added example\/skills/u);
	instance.stdin.write('l');
	assert.match(await waitFor(instance.lastFrame, /Repositories.*example\/skills/su), /enabled/u);
	instance.stdin.write(' ');
	assert.match(await waitFor(instance.lastFrame, /Disabled example\/skills/u), /disabled/u);
	instance.stdin.write(' ');
	await waitFor(instance.lastFrame, /Enabled example\/skills/u);
	instance.stdin.write('r');
	await waitFor(instance.lastFrame, /Refreshed example\/skills/u);
	instance.stdin.write('x');
	assert.match(await waitFor(instance.lastFrame, /Removed example\/skills/u), /No configured repositories/u);
	instance.unmount();
});

test('Skills TUI explains persistent update marks after selection moves', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await writeSkill(layout.amc.skills, 'local-skill', 'local only');
	const instance = render(<App layout={layout} presentation={{theme: 'dark', colorDepth: 24}} marketplace={runtime()} windowSize={{columns: 140, rows: 24}}/>);
	await waitFor(instance.lastFrame, /local-skill/u);
	instance.stdin.write('c');
	const frame = await waitFor(instance.lastFrame, /Untracked: no Marketplace provenance/u);
	assert.match(frame, /local-skill —/u);
	assert.match(frame, /✓ current.*↑ update.*~ drift/su);
	assert.match(frame, /—/u);
	assert.match(frame, /untracked/u);
	assert.match(frame, /\? error/u);
	instance.unmount();
});

test('installed Skills TUI upgrades and permanently deletes through two confirmation stages', async () => {
	const home = await createTestHome();
	const layout = createLayout(home);
	await installMarketplaceSkill(layout, runtime(), {source: 'example/skills', skill: 'alpha'});
	const instance = render(<App layout={layout} presentation={{theme: 'dark', colorDepth: 24}} marketplace={runtime()}/>);
	await waitFor(instance.lastFrame, /alpha/u);
	instance.stdin.write('C');
	assert.match(await waitFor(instance.lastFrame, /Checked 1 applied Skills: 0 updates/u), /alpha ✓/u);
	instance.stdin.write('u');
	assert.match(await waitFor(instance.lastFrame, /Upgrade alpha: unchanged/u), /unchanged/u);
	instance.stdin.write('d');
	assert.match(await waitFor(instance.lastFrame, /PERMANENTLY delete alpha/u), /Press y/u);
	instance.stdin.write('y');
	await waitFor(instance.lastFrame, /Type alpha to confirm/u);
	instance.stdin.write('alpha');
	await waitFor(instance.lastFrame, /alpha█/u);
	instance.stdin.write('\r');
	assert.match(await waitFor(instance.lastFrame, /Permanently deleted alpha/u), /cannot be restored/u);
	assert.equal(await pathExists(`${layout.amc.skills}/alpha`), false);
	instance.unmount();
});

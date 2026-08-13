import assert from 'node:assert/strict';
import test from 'node:test';
import {createMarketplaceRuntime, createResourceRuntime, githubCliInstallGuide, parseEditorCommand, resolveEditorCommand} from '../src/runtime.js';

test('editor commands are tokenized without shell evaluation', () => {
	assert.deepEqual(parseEditorCommand('code --wait'), ['code', '--wait']);
	assert.deepEqual(parseEditorCommand("'/Applications/My Editor/bin/edit' --reuse-window"), [
		'/Applications/My Editor/bin/edit',
		'--reuse-window',
	]);
	assert.deepEqual(parseEditorCommand('vim "+set ft=json"'), ['vim', '+set ft=json']);
	assert.throws(() => parseEditorCommand(''), /EDITOR_NOT_CONFIGURED/u);
	assert.throws(() => parseEditorCommand("code 'unterminated"), /INVALID_EDITOR_COMMAND/u);
});

test('marketplace runtime bounds downloaded response bytes', async () => {
	const runtime = createMarketplaceRuntime();
	const response = await runtime.get('data:text/plain,hello', 5, 1_000);
	assert.equal(new TextDecoder().decode(response.body), 'hello');
	await assert.rejects(runtime.get('data:text/plain,hello!', 5, 1_000), /size limit/u);
});

test('marketplace runtime sends GitHub authentication only to api.github.com', async () => {
	const requests: Array<Readonly<{url: string; authorization: string | null}>> = [];
	const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		requests.push({url: String(input), authorization: headers.get('authorization')});
		return Promise.resolve(new Response('ok', {status: 200}));
	}) as typeof fetch;
	const runtime = createMarketplaceRuntime(() => Promise.resolve('github_pat_abcdefghijklmnopqrstuvwxyz'), fetcher);

	await runtime.get('https://api.github.com/rate_limit');
	await runtime.get('https://raw.githubusercontent.com/example/repo/commit/SKILL.md');
	await runtime.get('https://skills.sh/api/skills/all-time/0');

	assert.deepEqual(requests, [
		{url: 'https://api.github.com/rate_limit', authorization: 'Bearer github_pat_abcdefghijklmnopqrstuvwxyz'},
		{url: 'https://raw.githubusercontent.com/example/repo/commit/SKILL.md', authorization: null},
		{url: 'https://skills.sh/api/skills/all-time/0', authorization: null},
	]);
});

test('missing GitHub CLI guidance is actionable without installing software', () => {
	assert.match(githubCliInstallGuide('darwin'), /brew install gh.*amc auth github login.*token-stdin/su);
	assert.match(githubCliInstallGuide('linux'), /github\.com\/cli\/cli.*amc auth github login.*token-stdin/su);
});

test('editor selection honors configuration and has platform defaults', () => {
	assert.equal(resolveEditorCommand({VISUAL: 'code --wait', EDITOR: 'vim'}, 'darwin'), 'code --wait');
	assert.equal(resolveEditorCommand({VISUAL: '  ', EDITOR: 'vim'}, 'darwin'), 'vim');
	assert.equal(resolveEditorCommand({}, 'darwin'), 'vim');
	assert.equal(resolveEditorCommand({}, 'win32'), 'vim');
	assert.equal(resolveEditorCommand({}, 'linux'), 'vim');
});

test('editor completion settles only after the blocking editor process exits', async () => {
	await createResourceRuntime({VISUAL: 'true'}).openEditor('/tmp/amc-editor-fixture');
	await assert.rejects(createResourceRuntime({VISUAL: 'false'}).openEditor('/tmp/amc-editor-fixture'), /exited with code 1/u);
});

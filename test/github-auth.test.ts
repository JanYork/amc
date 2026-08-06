import assert from 'node:assert/strict';
import {stat} from 'node:fs/promises';
import test from 'node:test';
import {executeCommand} from '../src/cli/execute.js';
import {
	configureGitHubOAuth,
	configureGitHubToken,
	inspectGitHubAuthentication,
	resolveGitHubAuthentication,
	type GitHubAuthRuntime,
} from '../src/core/marketplace.js';
import {createLayout} from '../src/core/index.js';
import {createTestHome, pathExists} from './helpers.js';

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function authRuntime(overrides: Partial<GitHubAuthRuntime> = {}): GitHubAuthRuntime {
	return {
		login: overrides.login ?? (() => Promise.resolve()),
		token: overrides.token ?? (() => Promise.resolve('oauth_token_abcdefghijklmnopqrstuvwxyz')),
		rateLimit: overrides.rateLimit ?? (() => Promise.resolve({
			status: 200,
			url: 'https://api.github.com/rate_limit',
			body: json({resources: {core: {limit: 5000, remaining: 4321, reset: 1_800_000_000}}}),
		})),
	};
}

test('persistent GitHub token uses owner-only files and never accepts malformed secrets', async () => {
	const layout = createLayout(await createTestHome());
	await assert.rejects(configureGitHubToken(layout, 'short'), /GitHub token/u);
	assert.equal(await pathExists(layout.amc.githubToken), false);

	const secret = 'github_pat_abcdefghijklmnopqrstuvwxyz123456';
	await configureGitHubToken(layout, `  ${secret}\n`);
	assert.equal((await stat(layout.amc.credentials)).mode & 0o777, 0o700);
	assert.equal((await stat(layout.amc.githubToken)).mode & 0o777, 0o600);
	assert.equal((await stat(layout.amc.githubAuth)).mode & 0o777, 0o600);
	assert.deepEqual(await resolveGitHubAuthentication(layout, {}, authRuntime()), {method: 'token', token: secret});
});

test('GitHub OAuth delegates login and keeps the credential in gh', async () => {
	const layout = createLayout(await createTestHome());
	let logins = 0;
	let tokenReads = 0;
	const runtime = authRuntime({
		login: () => { logins += 1; return Promise.resolve(); },
		token: () => { tokenReads += 1; return Promise.resolve('oauth_token_abcdefghijklmnopqrstuvwxyz'); },
	});

	await configureGitHubOAuth(layout, runtime);
	assert.equal(logins, 1);
	assert.equal(await pathExists(layout.amc.githubToken), false);
	assert.deepEqual(await resolveGitHubAuthentication(layout, {}, runtime), {
		method: 'oauth', token: 'oauth_token_abcdefghijklmnopqrstuvwxyz',
	});
	assert.equal(tokenReads, 1);
});

test('GitHub auth CLI reads Token only from non-TTY stdin and never echoes it', async () => {
	const layout = createLayout(await createTestHome());
	const secret = 'github_pat_cli_abcdefghijklmnopqrstuvwxyz';
	const runtime = authRuntime();
	const resources = {
		context: {home: layout.home, cwd: layout.home},
		runtime: {
			run: () => Promise.resolve({exitCode: 0, stdout: '', stderr: ''}),
			openEditor: () => Promise.resolve(),
		},
		githubAuth: {
			runtime,
			environment: {},
			readStdin: () => Promise.resolve(`${secret}\n`),
			stdinIsTTY: false,
		},
	};
	const configured = await executeCommand(layout, {kind: 'github-auth-token'}, undefined, resources);
	assert.equal(configured, 'GitHub Token configured.');
	assert.equal(configured.includes(secret), false);
	const status = await executeCommand(layout, {kind: 'github-auth-status'}, undefined, resources);
	assert.match(status, /Method: token.*Status: valid.*4321 \/ 5000/su);
	assert.equal(status.includes(secret), false);

	await assert.rejects(executeCommand(layout, {kind: 'github-auth-token'}, undefined, {
		...resources,
		githubAuth: {...resources.githubAuth, stdinIsTTY: true},
	}), /Refusing to read an echoed Token/u);
});

test('GITHUB_TOKEN overrides persisted preference and status exposes only rate metadata', async () => {
	const layout = createLayout(await createTestHome());
	const persisted = 'github_pat_persisted_abcdefghijklmnopqrstuvwxyz';
	const environment = 'github_pat_environment_abcdefghijklmnopqrstuvwxyz';
	await configureGitHubToken(layout, persisted);
	const runtime = authRuntime({rateLimit: token => {
		assert.equal(token, environment);
		return Promise.resolve({
			status: 200,
			url: 'https://api.github.com/rate_limit',
			body: json({resources: {core: {limit: 5000, remaining: 4999, reset: 1_800_000_000}}}),
		});
	}});

	assert.deepEqual(await resolveGitHubAuthentication(layout, {GITHUB_TOKEN: environment}, runtime), {
		method: 'environment', token: environment,
	});
	const status = await inspectGitHubAuthentication(layout, {GITHUB_TOKEN: environment}, runtime);
	assert.deepEqual(status, {method: 'environment', valid: true, limit: 5000, remaining: 4999, reset: 1_800_000_000});
	assert.equal(JSON.stringify(status).includes(environment), false);
	assert.equal(JSON.stringify(status).includes(persisted), false);
});

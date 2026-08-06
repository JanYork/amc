import {chmod, mkdir, readFile, stat} from 'node:fs/promises';
import type {Layout} from '../model.js';
import {atomicReplace} from '../resources/persistence.js';
import type {MarketplaceResponse} from './model.js';

export type GitHubAuthMethod = 'environment' | 'oauth' | 'token';

export type GitHubAuthRuntime = Readonly<{
	login: () => Promise<void>;
	token: () => Promise<string>;
	rateLimit: (token: string) => Promise<MarketplaceResponse>;
}>;

export type ResolvedGitHubAuthentication = Readonly<{
	method: GitHubAuthMethod;
	token: string;
}>;

export type GitHubAuthStatus = Readonly<{
	method: GitHubAuthMethod | 'none';
	valid: boolean;
	limit?: number;
	remaining?: number;
	reset?: number;
}>;

type StoredMethod = 'oauth' | 'token';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	if (!isRecord(error)) return undefined;
	const code = error['code'];
	return typeof code === 'string' ? code : undefined;
}

function normalizeToken(input: string): string {
	const token = input.trim();
	if (token.length < 20 || token.length > 255 || /\s|[\u0000-\u001f\u007f]/u.test(token)) {
		throw new Error('GitHub token must be 20-255 non-whitespace characters.');
	}
	return token;
}

async function writeMethod(layout: Layout, method: StoredMethod): Promise<void> {
	await atomicReplace(layout.amc.githubAuth, `${JSON.stringify({schemaVersion: 1, method})}\n`, 0o600);
}

async function readMethod(layout: Layout): Promise<StoredMethod | undefined> {
	let text: string;
	try {
		text = await readFile(layout.amc.githubAuth, 'utf8');
	} catch (error: unknown) {
		if (errorCode(error) === 'ENOENT') return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(text);
	if (!isRecord(value)) throw new Error('GitHub authentication configuration is invalid.');
	const record = value;
	if (record['schemaVersion'] !== 1 || (record['method'] !== 'oauth' && record['method'] !== 'token')) {
		throw new Error('GitHub authentication configuration is invalid.');
	}
	return record['method'];
}

async function readStoredToken(layout: Layout): Promise<string> {
	const metadata = await stat(layout.amc.githubToken);
	if ((metadata.mode & 0o077) !== 0) throw new Error('Stored GitHub token permissions must be 0600.');
	return normalizeToken(await readFile(layout.amc.githubToken, 'utf8'));
}

export async function configureGitHubToken(layout: Layout, input: string): Promise<void> {
	const token = normalizeToken(input);
	await mkdir(layout.amc.credentials, {recursive: true, mode: 0o700});
	await chmod(layout.amc.credentials, 0o700);
	await atomicReplace(layout.amc.githubToken, `${token}\n`, 0o600);
	await writeMethod(layout, 'token');
}

export async function configureGitHubOAuth(layout: Layout, runtime: GitHubAuthRuntime): Promise<void> {
	await runtime.login();
	await writeMethod(layout, 'oauth');
}

export async function resolveGitHubAuthentication(
	layout: Layout,
	environment: Readonly<Record<string, string | undefined>>,
	runtime: GitHubAuthRuntime,
): Promise<ResolvedGitHubAuthentication | undefined> {
	const environmentToken = environment['GITHUB_TOKEN'];
	if (environmentToken !== undefined && environmentToken.trim().length > 0) {
		return {method: 'environment', token: normalizeToken(environmentToken)};
	}
	const method = await readMethod(layout);
	if (method === undefined) return undefined;
	return method === 'token'
		? {method, token: await readStoredToken(layout)}
		: {method, token: normalizeToken(await runtime.token())};
}

function safeInteger(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export async function inspectGitHubAuthentication(
	layout: Layout,
	environment: Readonly<Record<string, string | undefined>>,
	runtime: GitHubAuthRuntime,
): Promise<GitHubAuthStatus> {
	const authentication = await resolveGitHubAuthentication(layout, environment, runtime);
	if (authentication === undefined) return {method: 'none', valid: false};
	const response = await runtime.rateLimit(authentication.token);
	if (response.url !== 'https://api.github.com/rate_limit' || response.status < 200 || response.status >= 300) {
		return {method: authentication.method, valid: false};
	}
	const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(response.body));
	if (!isRecord(value)) return {method: authentication.method, valid: false};
	const resources = value['resources'];
	if (!isRecord(resources)) return {method: authentication.method, valid: false};
	const core = resources['core'];
	if (!isRecord(core)) return {method: authentication.method, valid: false};
	const record = core;
	const limit = safeInteger(record['limit']);
	const remaining = safeInteger(record['remaining']);
	const reset = safeInteger(record['reset']);
	return limit === undefined || remaining === undefined || reset === undefined
		? {method: authentication.method, valid: false}
		: {method: authentication.method, valid: true, limit, remaining, reset};
}

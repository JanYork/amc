import {execFile, spawn} from 'node:child_process';
import type {GitHubAuthRuntime, MarketplaceRuntime} from './core/marketplace.js';
import type {ResourceRuntime} from './core/resources.js';

export function createMarketplaceRuntime(
	githubToken?: () => Promise<string | undefined>,
	fetcher: typeof fetch = fetch,
): MarketplaceRuntime {
	let resolvedToken: Promise<string | undefined> | undefined;
	return {
		get: async (url, maximumBytes = 1024 * 1024, timeoutMs = 10_000) => {
			const parsedUrl = new URL(url);
			const token = parsedUrl.hostname === 'api.github.com' && githubToken !== undefined
				? await (resolvedToken ??= githubToken())
				: undefined;
			const response = await fetcher(url, {
				redirect: 'follow',
				signal: AbortSignal.timeout(timeoutMs),
				headers: {
					'user-agent': 'AMC/0.1',
					accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
					...(token === undefined ? {} : {authorization: `Bearer ${token}`}),
				},
			});
			const chunks: Uint8Array[] = [];
			let size = 0;
			if (response.body !== null) {
				const reader = response.body.getReader();
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					size += next.value.length;
					if (size > maximumBytes) {
						await reader.cancel();
						throw new Error(`Remote response exceeds the ${maximumBytes} byte size limit`);
					}
					chunks.push(next.value);
				}
			}
			const body = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.length;
			}
			return {status: response.status, url: response.url, body};
		},
	};
}

export function githubCliInstallGuide(platform: NodeJS.Platform): string {
	const install = platform === 'darwin'
		? 'Install with Homebrew:\n  brew install gh'
		: platform === 'linux'
			? 'Install instructions:\n  https://github.com/cli/cli/blob/trunk/docs/install_linux.md'
			: 'Install instructions:\n  https://github.com/cli/cli#installation';
	return [
		'GitHub CLI (gh) is required for OAuth.',
		install,
		'Then rerun:\n  amc auth github login',
		'Alternative Token setup:\n  amc auth github set --token-stdin',
	].join('\n\n');
}

export function createGitHubAuthRuntime(): GitHubAuthRuntime {
	return {
		login: () => new Promise<void>((resolve, reject) => {
			const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'], {stdio: 'inherit'});
			child.once('error', error => reject(new Error(error.message.includes('ENOENT') ? githubCliInstallGuide(process.platform) : error.message)));
			child.once('exit', code => code === 0 ? resolve() : reject(new Error(`gh auth login failed with exit code ${code ?? 'unknown'}.`)));
		}),
		token: async () => {
			const result = await run('gh', ['auth', 'token', '--hostname', 'github.com']);
			if (result.exitCode !== 0) throw new Error(result.stderr.includes('ENOENT') ? githubCliInstallGuide(process.platform) : 'GitHub CLI OAuth credential is unavailable.');
			return result.stdout.trim();
		},
		rateLimit: token => createMarketplaceRuntime(() => Promise.resolve(token)).get('https://api.github.com/rate_limit', 1024 * 1024, 10_000),
	};
}

function run(program: string, arguments_: ReadonlyArray<string>): Promise<Readonly<{
	exitCode: number;
	stdout: string;
	stderr: string;
}>> {
	return new Promise(resolve => {
		execFile(program, [...arguments_], {encoding: 'utf8', timeout: 10_000}, (error, stdout, stderr) => {
			resolve({
				exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
				stdout,
				stderr: stderr.length > 0 ? stderr : error?.message ?? '',
			});
		});
	});
}

export function parseEditorCommand(value: string): ReadonlyArray<string> {
	const tokens: string[] = [];
	let token = '';
	let quote: 'single' | 'double' | undefined;
	let escaped = false;
	for (const character of value.trim()) {
		if (escaped) {
			token += character;
			escaped = false;
			continue;
		}
		if (character === '\\' && quote !== 'single') {
			escaped = true;
			continue;
		}
		if (character === "'" && quote !== 'double') {
			quote = quote === 'single' ? undefined : 'single';
			continue;
		}
		if (character === '"' && quote !== 'single') {
			quote = quote === 'double' ? undefined : 'double';
			continue;
		}
		if (/\s/u.test(character) && quote === undefined) {
			if (token.length > 0) {
				tokens.push(token);
				token = '';
			}
			continue;
		}
		token += character;
	}
	if (escaped || quote !== undefined) {
		throw new Error('INVALID_EDITOR_COMMAND: unmatched quote or escape.');
	}
	if (token.length > 0) {
		tokens.push(token);
	}
	if (tokens.length === 0) {
		throw new Error('EDITOR_NOT_CONFIGURED: set $VISUAL or $EDITOR.');
	}
	return tokens;
}

export function resolveEditorCommand(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
	const visual = environment['VISUAL']?.trim();
	if (visual !== undefined && visual.length > 0) {
		return visual;
	}
	const editor = environment['EDITOR']?.trim();
	if (editor !== undefined && editor.length > 0) {
		return editor;
	}
	return platform === 'darwin' ? 'open -t' : platform === 'win32' ? 'notepad' : 'vi';
}

function openEditor(command: ReadonlyArray<string>, path: string): Promise<void> {
	const program = command[0];
	if (program === undefined) {
		return Promise.reject(new Error('EDITOR_NOT_CONFIGURED: set $VISUAL or $EDITOR.'));
	}
	return new Promise((resolve, reject) => {
		const child = spawn(program, [...command.slice(1), path], {stdio: 'inherit'});
		child.once('error', reject);
		child.once('exit', code => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Editor exited with code ${code ?? 'unknown'}.`));
			}
		});
	});
}

export function createResourceRuntime(environment: NodeJS.ProcessEnv): ResourceRuntime {
	const editor = resolveEditorCommand(environment, process.platform);
	return {run, openEditor: path => openEditor(parseEditorCommand(editor), path)};
}

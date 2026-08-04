import {execFile, spawn} from 'node:child_process';
import type {ResourceRuntime} from './core/resources.js';

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
	const editor = environment['VISUAL'] ?? environment['EDITOR'] ?? '';
	return {run, openEditor: path => openEditor(parseEditorCommand(editor), path)};
}

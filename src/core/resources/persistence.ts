import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {copyFile, mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {Target} from '../model.js';
import type {McpTransport, ResourceDiagnostic, ResourceScope} from './model.js';

export type JsonObject = Readonly<Record<string, unknown>>;

export function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is ReadonlyArray<unknown> {
	return Array.isArray(value);
}

export function stringField(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === 'string' ? value : undefined;
}

export function booleanField(object: JsonObject, key: string): boolean | undefined {
	const value = object[key];
	return typeof value === 'boolean' ? value : undefined;
}

export function scopeField(value: unknown): ResourceScope | undefined {
	switch (value) {
		case 'user':
		case 'project':
		case 'local':
			return value;
		default:
			return value === undefined ? undefined : 'unknown';
	}
}

export function transportField(value: unknown): McpTransport {
	switch (value) {
		case 'stdio':
			return 'stdio';
		case 'http':
		case 'streamable-http':
			return 'http';
		case 'sse':
			return 'sse';
		default:
			return 'unknown';
	}
}

export function parseJson(text: string): unknown {
	return JSON.parse(text);
}


export function pluginDiagnostic(provider: Target, message: string): ResourceDiagnostic {
	return {provider, path: provider, message};
}


function tomlString(value: string): string {
	return JSON.stringify(value);
}

function tomlSectionHeader(group: string, name: string): string {
	return `[${group}.${tomlString(name)}]`;
}

function updateTomlBoolean(text: string, group: string, name: string, enabled: boolean): string {
	const lines = text.split('\n');
	const quotedHeader = tomlSectionHeader(group, name);
	const bareHeader = `[${group}.${name}]`;
	const sectionStart = lines.findIndex(line => line.trim() === quotedHeader || line.trim() === bareHeader);
	const setting = `enabled = ${enabled ? 'true' : 'false'}`;
	if (sectionStart === -1) {
		const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
		return `${text}${separator}${quotedHeader}\n${setting}\n`;
	}
	const nextSection = lines.findIndex((line, index) => index > sectionStart && /^\s*\[/u.test(line));
	const sectionEnd = nextSection === -1 ? lines.length : nextSection;
	const enabledIndex = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && /^\s*enabled\s*=/u.test(line));
	if (enabledIndex === -1) {
		lines.splice(sectionStart + 1, 0, setting);
	} else {
		lines[enabledIndex] = setting;
	}
	return lines.join('\n');
}

export async function atomicReplace(path: string, contents: string, mode: number): Promise<void> {
	await mkdir(dirname(path), {recursive: true});
	const temporaryPath = `${path}.amc-${randomUUID()}.tmp`;
	await writeFile(temporaryPath, contents, {encoding: 'utf8', flag: 'wx', mode});
	await rename(temporaryPath, path);
}

export async function replaceWithBackupAndConfirmation(
	path: string,
	original: string,
	next: string,
	errorCode: string,
	confirm: () => Promise<boolean>,
): Promise<void> {
	const fileMode = (await stat(path)).mode & 0o777;
	const backupPath = `${path}.amc-backup-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
	await copyFile(path, backupPath, constants.COPYFILE_EXCL);
	if (await readFile(path, 'utf8') !== original) {
		throw new Error(`${errorCode}: config changed while AMC was preparing the update. Backup: ${backupPath}`);
	}
	await atomicReplace(path, next, fileMode);
	let confirmationFailure: string | undefined;
	try {
		if (await confirm()) {
			return;
		}
	} catch (error: unknown) {
		confirmationFailure = error instanceof Error ? error.message : 'verification failed';
	}
	try {
		await atomicReplace(path, original, fileMode);
	} catch (error: unknown) {
		throw new Error(`${errorCode}: restore from ${backupPath}; ${error instanceof Error ? error.message : 'rollback failed'}`);
	}
	throw new Error(`${errorCode}: original config restored${confirmationFailure === undefined ? '' : ` after ${confirmationFailure}`}. Backup: ${backupPath}`);
}

export async function updateTomlBooleanWithConfirmation(
	path: string,
	group: string,
	name: string,
	enabled: boolean,
	confirm: () => Promise<boolean>,
): Promise<void> {
	const original = await readFile(path, 'utf8');
	await replaceWithBackupAndConfirmation(
		path,
		original,
		updateTomlBoolean(original, group, name, enabled),
		'CONFIG_CONFIRMATION_FAILED',
		confirm,
	);
}

export async function readJsonObject(path: string, provider: Target): Promise<Readonly<{
	value: JsonObject | undefined;
	diagnostic: ResourceDiagnostic | undefined;
}>> {
	try {
		const value = parseJson(await readFile(path, 'utf8'));
		return isObject(value)
			? {value, diagnostic: undefined}
			: {value: undefined, diagnostic: {provider, path, message: 'expected a JSON object'}};
	} catch (error: unknown) {
		if (hasErrorCode(error, 'ENOENT')) {
			return {value: undefined, diagnostic: undefined};
		}
		return {value: undefined, diagnostic: {provider, path, message: error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error ? error.message : 'read failed'}};
	}
}

export function stringArray(value: unknown): ReadonlyArray<string> {
	return isUnknownArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}


export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

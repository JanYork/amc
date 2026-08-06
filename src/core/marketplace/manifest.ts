import type {SkillManifest} from './model.js';

function yamlString(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || /^(?:null|true|false|[-+]?\d+(?:\.\d+)?)$/iu.test(trimmed)) {
		return undefined;
	}
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			return typeof parsed === 'string' && parsed.trim().length > 0 ? parsed.trim() : undefined;
		} catch {
			return undefined;
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
		const parsed = trimmed.slice(1, -1).replaceAll("''", "'").trim();
		return parsed.length > 0 ? parsed : undefined;
	}
	if (/^[[{&*!]/u.test(trimmed)) {
		return undefined;
	}
	return trimmed;
}

function blockValue(lines: ReadonlyArray<string>, start: number): string | undefined {
	const values: string[] = [];
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		if (line.length > 0 && !/^\s/u.test(line)) {
			break;
		}
		values.push(line.trim());
	}
	const value = values.join(' ').replaceAll(/\s+/gu, ' ').trim();
	return value.length > 0 ? value : undefined;
}

export function parseSkillManifest(content: string): SkillManifest | undefined {
	const lines = content.replace(/^\uFEFF/u, '').split(/\r?\n/u);
	if (lines[0]?.trim() !== '---') {
		return undefined;
	}
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
	if (end < 2) {
		return undefined;
	}
	let name: string | undefined;
	let description: string | undefined;
	for (let index = 1; index < end; index += 1) {
		const match = /^(name|description):\s*(.*)$/u.exec(lines[index] ?? '');
		if (match === null) {
			continue;
		}
		const key = match[1];
		const raw = match[2] ?? '';
		const value = /^[>|][+-]?$/u.test(raw.trim())
			? blockValue(lines.slice(0, end), index + 1)
			: yamlString(raw);
		if (key === 'name') {
			if (name !== undefined || value === undefined) return undefined;
			name = value;
		} else {
			if (description !== undefined || value === undefined) return undefined;
			description = value;
		}
	}
	return name === undefined || description === undefined ? undefined : {name, description};
}

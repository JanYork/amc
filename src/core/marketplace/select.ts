import type {RemoteSkill} from './model.js';

function hiddenPath(path: string): boolean {
	return path.split('/').some(part => part !== '.' && part.startsWith('.'));
}

export function selectRemoteSkill(
	skills: ReadonlyArray<RemoteSkill>,
	requested: string,
	label = 'Skill',
	relativePath?: string,
): RemoteSkill {
	const normalized = requested.toLowerCase();
	const matches = skills.filter(skill => skill.name.toLowerCase() === normalized
		|| skill.relativePath.split('/').at(-1)?.toLowerCase() === normalized);
	if (relativePath !== undefined) {
		const exact = matches.filter(skill => skill.relativePath === relativePath);
		if (exact.length === 1 && exact[0] !== undefined) return exact[0];
	}
	if (matches.length === 1 && matches[0] !== undefined) return matches[0];
	for (const path of [`skills/${normalized}`, normalized]) {
		const conventional = matches.filter(skill => skill.relativePath.toLowerCase() === path);
		if (conventional.length === 1 && conventional[0] !== undefined) return conventional[0];
	}
	const visible = matches.filter(skill => !hiddenPath(skill.relativePath));
	if (visible.length === 1 && visible[0] !== undefined) return visible[0];
	throw new Error(matches.length === 0 ? `${label} not found: ${requested}` : `${label} is ambiguous: ${requested}`);
}

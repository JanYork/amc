import assert from 'node:assert/strict';
import test from 'node:test';
import {parseEditorCommand} from '../src/runtime.js';

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

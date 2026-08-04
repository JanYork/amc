import assert from 'node:assert/strict';
import test from 'node:test';
import {createLayout} from '../src/core/index.js';

test('createLayout maps the canonical store and all three Agent targets', () => {
	assert.deepEqual(createLayout('/tmp/amc-home'), {
		home: '/tmp/amc-home',
		amc: {
			root: '/tmp/amc-home/.amc',
			skills: '/tmp/amc-home/.amc/skills',
			backups: '/tmp/amc-home/.amc/backups',
			disabledLinks: '/tmp/amc-home/.amc/disabled-links',
			staging: '/tmp/amc-home/.amc/staging',
			failed: '/tmp/amc-home/.amc/failed',
		},
		targets: {
			claude: '/tmp/amc-home/.claude/skills',
			pi: '/tmp/amc-home/.pi/agent/skills',
			codex: '/tmp/amc-home/.codex/skills',
		},
	});
});

// A Claude Code session belongs to the owner of the agent it runs under (docs/standalone.md): the SessionStart hook
// records it as Claude Code runs the hook, and the plugin moves it to where the owner's daily improvement reads it.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./load-ts.cjs');

const { attributeSessions } = loadTs('server/session-owners.ts');
const hook = path.resolve(__dirname, '..', 'hooks', 'session-start.mts');

test('a session goes to its agent\'s owner, waits while the agent has none, and is dropped when the agent is gone', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  const start = (sessionId, agentId, cwd = '/work/paseo') => execFileSync(process.execPath, [hook], {
    env: { HOME: home, ...(agentId ? { PASEO_AGENT_ID: agentId } : {}) },
    input: JSON.stringify({ session_id: sessionId, transcript_path: `/t/${sessionId}.jsonl`, cwd, source: 'startup', hook_event_name: 'SessionStart' }),
  });
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  start(ids[0], 'agent-nam');
  start(ids[0], 'agent-an', '/elsewhere'); // The same session again never replaces its record.
  start(ids[1], 'agent-unclaimed');
  start(ids[2], 'agent-gone');
  start('44444444-4444-4444-8444-444444444444', null); // Not under a Paseo agent: nothing to record.

  const pendingDir = path.join(home, '.paseo', 'chat', 'sessions-pending');
  const usageDir = path.join(home, '.paseo', 'session-usage');
  const owners = { 'agent-nam': { found: true, owner: 'nam' }, 'agent-unclaimed': { found: true, owner: null } };
  await attributeSessions({ pendingDir, usageDir, ownerOfAgent: async id => owners[id] ?? { found: false }, log: () => {} });

  const moved = JSON.parse(fs.readFileSync(path.join(usageDir, 'nam', `${ids[0]}.json`), 'utf8'));
  assert.deepEqual({ ...moved, startedAt: 'at' }, {
    sessionId: ids[0], transcriptPath: `/t/${ids[0]}.jsonl`, cwd: '/work/paseo', source: 'startup', startedAt: 'at', agentIds: ['agent-nam'],
  });
  assert.deepEqual(fs.readdirSync(pendingDir), [`${ids[1]}.json`], 'only the session whose agent has no owner yet waits');

  // Its workspace is claimed later: the next pass finds the owner.
  owners['agent-unclaimed'] = { found: true, owner: 'an' };
  await attributeSessions({ pendingDir, usageDir, ownerOfAgent: async id => owners[id] ?? { found: false }, log: () => {} });
  assert.deepEqual(fs.readdirSync(path.join(usageDir, 'an')), [`${ids[1]}.json`]);
  assert.deepEqual(fs.readdirSync(pendingDir), []);
});

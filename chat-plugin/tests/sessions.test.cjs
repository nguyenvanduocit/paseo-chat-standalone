// A Claude Code session belongs to the owner of the agent Paseo runs it under (docs/standalone.md): the plugin records
// it where the owner's daily improvement reads it, once its transcript exists.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./load-ts.cjs');

const { sessionLedger } = loadTs('server/session-owners.ts');

test('an agent\'s sessions go to its owner: the first counts from the agent\'s creation, a later one from when it is seen', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  const usageDir = path.join(root, 'session-usage');
  const transcriptsDir = path.join(root, 'projects');
  const transcript = (cwd, id) => {
    const dir = path.join(transcriptsDir, cwd.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '');
    return path.join(dir, `${id}.jsonl`);
  };
  const read = (owner, id) => JSON.parse(fs.readFileSync(path.join(usageDir, owner, `${id}.json`), 'utf8'));
  const agent = { agentId: 'agent-1', cwd: '/work/paseo.web', createdAt: '2026-11-07T01:00:00.000Z', owner: 'nam' };

  const ledger = sessionLedger({ usageDir, transcriptsDir });
  await ledger.record([{ ...agent, sessionId: 's1' }], '2026-11-07T02:00:00.000Z');
  assert.equal(fs.existsSync(path.join(usageDir, 'nam', 's1.json')), false, 'no transcript yet, nothing to read');

  const first = transcript(agent.cwd, 's1');
  await ledger.record([{ ...agent, sessionId: 's1' }], '2026-11-07T02:00:05.000Z');
  assert.deepEqual(read('nam', 's1'), {
    sessionId: 's1', transcriptPath: first, cwd: agent.cwd, source: 'fork', startedAt: agent.createdAt, agentIds: ['agent-1'],
  });

  // The agent resumes on a new session; a restarted plugin still knows the agent had one before.
  transcript(agent.cwd, 's2');
  await sessionLedger({ usageDir, transcriptsDir }).record([{ ...agent, sessionId: 's2' }], '2026-11-07T03:00:00.000Z');
  assert.deepEqual([read('nam', 's2').source, read('nam', 's2').startedAt], ['resume', '2026-11-07T03:00:00.000Z']);
  assert.equal(read('nam', 's1').startedAt, agent.createdAt, 'a record is never replaced');

  // A turn ending while every agent is being recorded: one of the two is the agent's first session, not both.
  const other = { ...agent, agentId: 'agent-2', owner: 'an' };
  transcript(agent.cwd, 's3');
  transcript(agent.cwd, 's4');
  const both = sessionLedger({ usageDir, transcriptsDir });
  await Promise.all([both.record([{ ...other, sessionId: 's3' }], 'now'), both.record([{ ...other, sessionId: 's4' }], 'now')]);
  assert.deepEqual([read('an', 's3').source, read('an', 's4').source].sort(), ['fork', 'resume']);
});

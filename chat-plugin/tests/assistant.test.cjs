// The AI Assistant's relay against the real chat broker (tests/chat-broker.cjs) and a fake Paseo daemon.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { loadTs } = require('./load-ts.cjs');

const mocks = {
  '@getpaseo/plugin': { ...require('@getpaseo/plugin'), defineRpc: value => value, defineSettings: value => value },
  '@getpaseo/plugin/server': { defineAgentTool: value => value },
};
const { startChatBroker } = require('./chat-broker.cjs');
const { assistantRelay, quietMs } = loadTs('server/assistant.ts', mocks);
const taste = loadTs('server/taste.ts', mocks);
const { personaStore } = loadTs('server/persona.ts', mocks);
const { workerStore } = loadTs('server/workers.ts', mocks);
const { attentionStore } = loadTs('server/attention.ts', mocks);

// bob on the daemon: the chat broker, a clock the test moves, bob's assistant and persona directories.
async function setup() {
  const broker = await startChatBroker({ at: Date.parse('2026-11-05T09:00:00Z') });
  const { clock, as } = broker;
  const root = broker.scratch;
  const listening = await broker.wire('bob');
  let n = 0;
  // A message is said once bob's daemon has heard of it, as it would before its next tick.
  const say = async (handle, conversation, body, extra) => {
    clock.at += 1000;
    const { message } = await as(handle).send(conversation, `msg-${String(++n).padStart(4, '0')}`, body, [], extra);
    await broker.heard(conversation, message.key);
    return message;
  };
  // The plugin lists its host's person when it starts, so room mentions of them reach them.
  const ready = as('bob').register();
  const store = taste.tasteStore(taste.tastePaths(path.join(root, 'taste'), path.join(root, 'persona'), { usage: path.join(root, 'session-usage'), transcripts: path.join(root, 'claude', 'projects') }));
  const persona = personaStore(store.paths.persona, store.paths.history, store.paths.delegation);
  const workers = workerStore(path.join(root, 'taste', 'workers.json'));
  const attention = attentionStore(path.join(root, 'taste', 'attention.json'), () => clock.at);
  // A relay is what one daemon run of bob's host holds; a new one is a restart. It hears the broker's events as
  // index.server.ts wires them. `chat` and `log` stand in for bob's chat client and the daemon's log.
  const relay = ({ chat = async () => as('bob'), log = () => {} } = {}) => {
    const relay = assistantRelay({ chat, taste: store, persona, workers, attention, now: () => clock.at, log });
    listening.on(event => relay.notice(event, 'bob'));
    return relay;
  };
  const quiet = () => { clock.at += quietMs; };
  return { ready, clock, say, quiet, attention, relay, cleanup: broker.stop };
}

// The daemon's agent API as the relay uses it: labelled agents, created as tabs of a workspace, prompted, archived and
// reloaded, and the one workspace of a directory. Sending to an archived agent wakes it, as Paseo's sendPromptToAgent
// does; reloading one un-archives it with its context, as refresh_agent_request does. An agent reports the Claude Code
// session it runs under `persistence` once it has one.
function fakePaseo(clock) {
  const agents = [];
  const opened = [];
  const matches = (agent, labels) => Object.entries(labels ?? {}).every(([key, value]) => agent.labels[key] === value);
  // An agent as the daemon keeps it, with what its handle does.
  const add = fields => {
    const agent = {
      status: 'idle', archivedAt: null, createdAt: new Date(clock.at).toISOString(), updatedAt: new Date(clock.at).toISOString(), persistence: null, prompts: [], reloads: 0, ...fields,
      current() { return this; },
      async send(text, sendOptions) { this.archivedAt = null; this.prompts.push({ text, ...sendOptions }); },
      async archive() { this.archivedAt = new Date(clock.at).toISOString(); this.status = 'closed'; },
      async reload() { this.archivedAt = null; this.status = 'idle'; this.reloads += 1; return { agent: this, project: null }; },
      async refresh() { return { agent: this, project: null }; },
    };
    agents.push(agent);
    return agent;
  };
  return {
    agents: {
      all: agents,
      add,
      // Paseo deletes an agent for good: it is not listed again, archived or not.
      delete: agent => agents.splice(agents.indexOf(agent), 1),
      async list({ filter }) {
        const listed = agents.filter(agent => (filter?.includeArchived || !agent.archivedAt) && matches(agent, filter?.labels));
        return { entries: listed.map(agent => ({ agent })), pageInfo: { nextCursor: null } };
      },
      ref: id => agents.find(agent => agent.id === id),
    },
    workspaces: {
      opened,
      async open(directory) {
        assert.ok(fs.statSync(directory).isDirectory(), 'the directory exists before it is opened');
        opened.push(directory);
        return { id: 'ws-assistant' };
      },
      ref: workspaceId => ({
        agents: {
          async create(options) {
            return add({
              id: `tab-${agents.length + 1}`, workspaceId, status: 'running',
              labels: options.labels, title: options.title, config: options.config, prompts: [{ text: options.prompt }],
            });
          },
        },
      }),
    },
  };
}

test('a request sent through an agent reaches the router, and assistants answering each other are slowed down, not stopped', async () => {
  const s = await setup();
  await s.ready;
  const paseo = fakePaseo(s.clock);
  const relay = s.relay();
  const dm = { members: ['bob', 'erin'] };
  const viaAgent = { via: { agent: 'Có những tool gì ở đây' } };
  const viaAssistant = { via: { agent: 'AI Assistant' } };
  const routed = () => paseo.agents.all.filter(agent => agent.labels['chat.assistant-router'] === 'bob').flatMap(agent => agent.prompts.map(prompt => prompt.text)).join('\n');

  // The assistant reads from its first tick on.
  await relay.tick(paseo);
  await s.say('erin', dm, 'lượt 1: MCP public URL là gì?', viaAgent);
  s.quiet();
  await relay.tick(paseo);
  assert.match(routed(), /erin \(via agent "Có những tool gì ở đây"\): lượt 1: MCP public URL là gì\?/);

  // The two assistants answer each other a second apart: the broker takes twenty, then tells the next to slow down.
  for (let n = 2; n <= 20; n++) await s.say(n % 2 ? 'erin' : 'bob', dm, `lượt ${n}`, n % 2 ? viaAgent : viaAssistant);
  await assert.rejects(s.say('erin', dm, 'lượt 21', viaAgent), { code: 'slow_down' });
  s.clock.at += 30_000;
  await s.say('erin', dm, 'lượt 21', viaAgent);
  s.quiet();
  await relay.tick(paseo);
  assert.match(routed(), /: lượt 19\n/);
  assert.match(routed(), /: lượt 21\b/);
  assert.doesNotMatch(routed(), /bob \(via agent/, 'what bob\'s own assistant sent is never routed back');
  assert.deepEqual((await s.attention.read()).filter(item => item.kind === 'blocker'), []);
  await s.cleanup();
});

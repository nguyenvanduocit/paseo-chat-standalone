// The chat tools an agent gets, against the real chat broker (tests/chat-broker.cjs), acting for the agent's owner.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const { loadTs } = require('./load-ts.cjs');
const { startChatBroker } = require('./chat-broker.cjs');

const mocks = {
  '@getpaseo/plugin': { ...require('@getpaseo/plugin'), defineRpc: value => value, defineSettings: value => value },
  '@getpaseo/plugin/server': { defineAgentTool: value => value },
};
const { chatAgentTools } = loadTs('server/agent-tools.ts', mocks);

test('chat_send says where a request stands, and a message that closes one waits for nothing', async () => {
  const broker = await startChatBroker({ at: Date.parse('2026-11-04T09:00:00Z') });
  // Each tool acts for the owner of the calling agent, as index.server.ts resolves it (server/daemon.ts `ownerOf`).
  const owners = { 'a-1': 'bob', 'b-1': 'alice' };
  const tools = chatAgentTools(async context => broker.as(owners[context.agent.id]), os.tmpdir(), 'delegation.md');
  const call = async (handle, agent, name, input) => {
    assert.equal(owners[agent], handle);
    const tool = tools.find(each => each.name === name);
    return tool.execute(await tool.input.parseAsync(input), { agent: { id: agent, title: 'test agent' } });
  };
  const asked = await call('bob', 'a-1', 'chat_send', { conversation: 'dm:alice,bob', body: 'deploy xong chưa?' });
  const key = asked.text.match(/key (\S+);/)[1];
  assert.match(asked.text, new RegExp(`opens request ${key}: open\\)\\. Replies will arrive`));
  const closed = await call('alice', 'b-1', 'chat_send', { conversation: 'dm:alice,bob', body: 'xong rồi', replyTo: key, status: 'completed' });
  assert.match(closed.text, new RegExp(`in request ${key}: completed, this message says completed\\)\\.$`));
  const outside = await call('alice', 'b-1', 'chat_send', { conversation: 'dm:alice,bob', body: 'x', status: 'completed', replyTo: key.replace(/-.*/, '-nothere00') });
  assert.equal(outside.isError, true);
  const read = await call('alice', 'b-1', 'chat_read', { conversation: 'dm:alice,bob' });
  assert.match(read.text, /opens request [^:]+: completed\)/);
  assert.match(read.text, /\] [^ ]+ alice \(via agent "test agent"/, 'the reply is written as the owner of the agent that sent it');
  await broker.stop();
});

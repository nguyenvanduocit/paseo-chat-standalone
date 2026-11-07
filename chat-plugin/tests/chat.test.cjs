// The plugin's chat client against the real chat broker (tests/chat-broker.cjs): one daemon's people, each by handle.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadTs } = require('./load-ts.cjs');
const { startChatBroker } = require('./chat-broker.cjs');

const mocks = { '@getpaseo/plugin': { defineRpc: value => value, defineSettings: value => value } };
const shared = loadTs('shared/chat.ts', mocks);

// A fresh broker with a clock the test moves by hand; `chat` speaks as bob.
async function setup(options = {}) {
  const broker = await startChatBroker({ at: Date.parse('2026-09-29T09:00:00Z'), ...options });
  return { ...broker, chat: broker.as('bob'), open: handle => broker.as(handle) };
}

test('a direct message is read and written only by its members', async () => {
  const s = await setup();
  try {
    const dm = shared.dmOf(['bob', 'alice']);
    await s.chat.send(dm, 'dm-00001', 'riêng', []);
    assert.deepEqual((await s.open('alice').latest(dm, 10)).messages.map(m => m.body), ['riêng']);
    await assert.rejects(s.open('dave').latest(dm, 10), /không ở trong cuộc trò chuyện/);
    await assert.rejects(s.open('dave').send(dm, 'dm-00002', 'chen vào', []), /không ở trong cuộc trò chuyện/);
  } finally {
    await s.stop();
  }
});

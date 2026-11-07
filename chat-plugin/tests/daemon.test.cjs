// One daemon, several people (docs/standalone.md): whom an agent acts for, who owns a workspace, whose a chat tab is.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./load-ts.cjs');

const mocks = { '@getpaseo/plugin': { ...require('@getpaseo/plugin'), defineRpc: value => value, defineSettings: value => value } };
const { daemonStore, ownedAgent, ownerOf, withClaim, withPerson } = loadTs('server/daemon.ts', mocks);
const { tabOfModel, modelIdOf } = loadTs('server/provider.ts', mocks);

test('an agent acts for its labelled person, else its workspace owner, else its parent\'s; none says, no one; a workspace is claimed only from no one', async () => {
  const store = daemonStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), 'daemon.json'));
  await store.change(state => withPerson(withPerson(state, 'nam'), 'an'));
  const { workspaces } = await store.change(state => withClaim(state, 'ws-nam', 'nam', true));
  await assert.rejects(store.change(state => withClaim(state, 'ws-nam', 'an', true)), /Workspace này là của nam/);
  assert.deepEqual(await store.read(), { people: ['an', 'nam'], workspaces: { 'ws-nam': 'nam' } });

  const agents = new Map([
    ['router-an', ownedAgent({ id: 'router-an', workspaceId: 'ws-nam', labels: { 'chat.assistant-of': 'an' } })],
    ['mine', ownedAgent({ id: 'mine', workspaceId: 'ws-nam' })],
    ['child', ownedAgent({ id: 'child', workspaceId: 'ws-other', labels: { 'paseo.parent-agent-id': 'mine' } })],
    ['stray', ownedAgent({ id: 'stray', workspaceId: 'ws-other' })],
  ]);
  const owner = id => ownerOf(agents.get(id), workspaces, async parent => agents.get(parent) ?? null);
  assert.equal(await owner('router-an'), 'an', 'a label wins over the workspace');
  assert.equal(await owner('mine'), 'nam');
  assert.equal(await owner('child'), 'nam', 'a subagent acts for its parent\'s owner');
  assert.equal(await owner('stray'), null);

  // Letting go leaves the workspace to whoever claims it next.
  const released = await store.change(state => withClaim(state, 'ws-nam', 'nam', false));
  assert.deepEqual(released.workspaces, {});
});

test('a chat tab is one person\'s: its model carries the handle with the conversation', () => {
  const room = { project: 'paseo/web', room: 'chung' };
  assert.deepEqual(tabOfModel(modelIdOf('nam', room)), { as: 'nam', conversation: room });
  assert.notEqual(modelIdOf('nam', room), modelIdOf('an', room));
  assert.equal(tabOfModel('c-bad'), null);
});

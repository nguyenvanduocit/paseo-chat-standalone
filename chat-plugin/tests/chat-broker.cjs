// Starts the real chat broker (chat-broker/, built with its `harness` feature) with the daemon's key, so a test drives
// the plugin against the server it talks to. The clock is a file both sides read: moving
// `clock.at` moves the broker's time (message keys, presence, rate limits) and the plugin's `now`. Without `at` the
// broker runs on real time until a test sets `clock.at`.
// Set CHAT_BROKER_BIN to use a built harness binary instead of building it with cargo.
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./load-ts.cjs');

const crate = path.resolve(__dirname, '../../chat-broker');
let built = null;
// Every broker a test file started stops with the file, also when a failing test never reached its own stop.
const running = new Set();
require('node:test').after(async () => { for (const broker of [...running]) await broker.stop(); });

function harnessBinary() {
  if (process.env.CHAT_BROKER_BIN) return process.env.CHAT_BROKER_BIN;
  if (built) return built;
  const cargo = fs.existsSync(path.join(os.homedir(), '.cargo/bin/cargo')) ? path.join(os.homedir(), '.cargo/bin/cargo') : 'cargo';
  const binary = path.join(crate, 'target/debug/chat-broker-harness');
  const build = () => execFileSync(cargo, ['build', '--quiet', '--locked', '--features', 'harness', '--bin', 'chat-broker-harness'], { cwd: crate, stdio: 'inherit' });
  const empty = () => fs.statSync(binary).size === 0;
  build();
  // A link on the NFS workspace has left an empty file that cargo then counts as fresh, and an empty file "runs" and
  // exits 0, so every test would fail with "chat broker exited (0)". The binary is a hard link of cargo's own output
  // in deps/; with both gone cargo links again.
  if (empty()) {
    const deps = path.join(crate, 'target/debug/deps');
    for (const name of fs.readdirSync(deps)) {
      const file = path.join(deps, name);
      if (name.startsWith('chat_broker_harness-') && !name.endsWith('.d') && fs.statSync(file).size === 0) fs.rmSync(file);
    }
    fs.rmSync(binary);
    build();
    if (empty()) throw new Error(`cargo built an empty ${binary}`);
  }
  built = binary;
  return built;
}

// The daemon's key (`CHAT_BROKER_KEY`), which the broker and the plugin share.
const key = 'daemon-key-0123456789';

// `openRouter` is where the broker classifies new messages (an OpenRouter the test fakes); without it, none are.
async function startChatBroker({ at, dataDir, maxImageStoreBytes, openRouter } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-broker-'));
  const data = dataDir ?? path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  // A directory of the test's own, removed with the broker (tab folders, homes).
  const scratch = path.join(root, 'scratch');
  fs.mkdirSync(scratch);
  const clockFile = path.join(root, 'clock');
  let now = at;
  if (at !== undefined) fs.writeFileSync(clockFile, String(at));
  const clock = {
    get at() { return now ?? Date.now(); },
    set at(ms) { now = ms; fs.writeFileSync(clockFile, String(ms)); },
  };
  const child = spawn(harnessBinary(), [], {
    env: {
      ...process.env, PORT: '0', BIND: '127.0.0.1', CHAT_BROKER_DATA_DIR: data, CHAT_INT_CLOCK_FILE: clockFile,
      CHAT_BROKER_KEY: key,
      ...maxImageStoreBytes === undefined ? {} : { CHAT_BROKER_MAX_IMAGE_STORE_BYTES: String(maxImageStoreBytes) },
      ...openRouter === undefined ? {} : { OPENROUTER_KEY: 'test', OPENROUTER_URL: openRouter },
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const url = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => {
      out += chunk;
      const match = /listening on (\S+:\d+)/.exec(out);
      if (match) resolve(`http://${match[1]}`);
    });
    child.on('exit', code => reject(new Error(`chat broker exited (${code}): ${logs.join('')}`)));
  });

  const { openChatClient } = loadTs('server/chat.ts');
  const clients = new Map();
  // One client per handle, speaking with the daemon's key as the plugin does for each person.
  const as = handle => {
    if (!clients.has(handle)) clients.set(handle, openChatClient({ url, key, handle }, { log: () => {} }));
    return clients.get(handle);
  };
  // A handle's event stream, wired the way index.server.ts wires it; `on` adds a listener (replies, assistant).
  const wired = new Map();
  async function wire(handle) {
    if (wired.has(handle)) return wired.get(handle);
    const listeners = new Set();
    const entry = { keys: new Set(), on: listener => { listeners.add(listener); } };
    wired.set(handle, entry);
    await new Promise(resolve => as(handle).subscribe(event => {
      if (event.type === 'message') entry.keys.add(event.key);
      for (const listener of listeners) listener(event);
      if (event.type === 'ready') resolve();
    }));
    return entry;
  }
  // Resolves once every wired handle that may read the conversation has heard of the message.
  const heard = (conversation, key) => until(() => [...wired].every(([handle, { keys }]) =>
    (conversation.members && !conversation.members.includes(handle)) || keys.has(key)));

  let stopped = false;
  const broker = {
    url, data, scratch, clock, as, wire, heard, logs,
    async stop() {
      if (stopped) return;
      stopped = true;
      running.delete(broker);
      for (const client of clients.values()) client.close();
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  running.add(broker);
  return broker;
}

// Resolves once `check` holds, for what arrives through the event stream.
async function until(check, { timeoutMs = 3_000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the chat broker');
    await new Promise(resolve => setTimeout(resolve, everyMs));
  }
}

module.exports = { startChatBroker, until };

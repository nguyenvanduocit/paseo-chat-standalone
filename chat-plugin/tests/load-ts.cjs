// Loads a TypeScript module from this package without a build step. Relative imports load the same
// way; `mocks` replaces bare package ids.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadTs(file, mocks = {}, logs = [], cache = new Map()) {
  const full = path.resolve(__dirname, '..', file);
  if (cache.has(full)) return cache.get(full).exports;
  const module = { exports: {} };
  cache.set(full, module);
  const code = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const requireFrom = id => {
    if (id in mocks) return mocks[id];
    if (id.startsWith('.')) return loadTs(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(full), `${id}.ts`)), mocks, logs, cache);
    return require(id);
  };
  vm.runInThisContext(`(function(module, exports, require, console) { ${code}\n})`, { filename: full })(
    module, module.exports, requireFrom, { error: (...args) => logs.push(args), log: console.log });
  return module.exports;
}

module.exports = { loadTs };

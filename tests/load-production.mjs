import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
// Execute the real source modules, with optional boundary mocks; no copied domain logic.
export function productionLoader(mocks = {}, globals = {}) {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(file);
    if (Object.hasOwn(mocks, absolute)) return mocks[absolute];
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const localRequire = id => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (!id.startsWith('.')) return require(id);
      const target = path.resolve(path.dirname(absolute), id);
      return load(['', '.ts', '.tsx'].map(ext => target+ext).find(p => fs.existsSync(p)));
    };
    const execute = vm.runInNewContext(`(function(require,module,exports){${output}\n})`, {console, ...globals}, {filename:absolute});
    execute(localRequire,module,module.exports);
    return module.exports;
  }
  return load;
}

/**
 * Test-infra guard for `convert-source-map`.
 *
 * `convert-source-map` throws a SyntaxError when a file contains text that its
 * multiline comment regex misreads as an inline `sourceMappingURL=data:...`
 * comment but the payload is not valid JSON. The known offender is tsx's dist
 * bundles, whose source contains a multi-line template literal like
 *
 *     Pe=`
 *     //# sourceMappingURL=data:application/json;base64,`,I=o(...)
 *
 * Vitest's `extractSourcemapFromFile` (used when it renders an error stack)
 * calls these entry points with no try/catch, so one such file turns an
 * otherwise fully green suite into an unhandled "Unexpected token '�', \"�\"
 * is not valid JSON" error and a non-zero exit.
 *
 * This module wraps the public entry points: valid sourcemaps resolve exactly
 * as before; parse failures degrade to `null` (no sourcemap) instead of
 * crashing the reporter. It is injected by `scripts/run-tests.mjs` via
 * `--require` (Vitest main process) and NODE_OPTIONS (forked workers and
 * helper processes); loading it twice is a no-op.
 */
'use strict';

let patched = false;

function install() {
  if (patched) return;
  patched = true;

  // eslint-disable-next-line global-require -- resolve against repo node_modules
  const convertSourceMap = require('convert-source-map');
  for (const name of [
    'fromSource',
    'fromMapFileSource',
    'fromComment',
    'fromMapFileComment',
  ]) {
    const original = convertSourceMap[name];
    if (typeof original !== 'function') continue;
    convertSourceMap[name] = function guarded(...args) {
      try {
        return original.apply(this, args);
      } catch {
        return null;
      }
    };
  }
}

try {
  install();
} catch {
  // convert-source-map is not installed in this context — nothing to guard.
}

module.exports = { install };

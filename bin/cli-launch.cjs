/**
 * Windows-aware CLI launch resolution for `bin/` connector adapters.
 *
 * Why this exists: `bin/tencent-meeting-mcp-server.cjs` spawns a provider CLI (`tmeet`) as a child
 * process. On Windows an npm-global install lands as a `tmeet.cmd` shim, and CreateProcess cannot
 * execute a `.cmd`/`.bat` directly — `execFile`/`spawn` fail with ENOENT unless the call is routed
 * through `ComSpec`. Routing model-supplied arguments through a shell is its own hazard: cmd.exe
 * treats `&`, `|`, `%`, `<`, `>` and friends as syntax, so an unescaped `meeting_id` would be
 * executable. The preferred path therefore resolves the shim to the Node script it wraps and runs
 * that with our own Node runtime, with no shell involved at all. Only when the shim cannot be
 * parsed do we fall back to `ComSpec`, and then every argument is escaped.
 *
 * This mirrors `src/main/features/local_agents/spawn-command.ts::resolveCliCommand`, which main
 * uses for local-agent CLIs. That module is TypeScript behind the app's tsx hook, and an adapter
 * child is spawned as plain `node` with no hook, so it cannot be imported here. Keep the two in
 * step — a divergence means Windows behaves differently depending on which layer launches a CLI.
 *
 * Every platform decision is injectable so the Windows branches are testable off-Windows; without
 * that, the `.cmd` path can only be exercised by Windows CI, which is how the gap this module
 * closes went unnoticed.
 */
'use strict';

const fs = require('node:fs');
const nodePath = require('node:path');

const WINDOWS_COMMAND_SCRIPT_RE = /\.(?:cmd|bat)$/i;
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

/** npm / pnpm / yarn shims re-parse their `%*` payload once more, so meta characters need a second
 *  pass of escaping. Mirrors the detection in `spawn-command.ts`. */
const DOUBLE_ESCAPE_RE = /(?:node_modules[\\/]\.bin|AppData[\\/]Roaming[\\/]npm)[\\/][^\\/]+\.cmd$/i;

function isWindowsCommandScript(binPath) {
  return WINDOWS_COMMAND_SCRIPT_RE.test(String(binPath || ''));
}

function escapeCmdCommand(value) {
  return String(value).replace(CMD_META_RE, '^$1');
}

// Based on the quoting rules used by cross-spawn. A command script must run through cmd.exe on
// Windows; passing raw user/model arguments through a shell would make `&`, `|`, `%` and friends
// executable shell syntax.
function escapeCmdArgument(value, doubleEscapeMetaChars) {
  // cmd.exe parses CR/LF as command separators even inside the /c payload.
  // Flatten them before quoting so later prompt/history lines stay in the
  // same inert argv value instead of being truncated or executed.
  let escaped = String(value).replace(/\r\n?|\n/g, ' ');
  escaped = escaped.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_RE, '^$1');
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META_RE, '^$1');
  return escaped;
}

function expandShimPath(value, shimDir, pathModule) {
  const expanded = String(value).replace(/%~?dp0%?/ig, `${shimDir}\\`);
  if (/%[^%]+%/.test(expanded)) return null;
  return pathModule.win32.normalize(expanded);
}

/**
 * Read an npm-style `.cmd`/`.bat` shim and find the script or executable it ultimately invokes.
 * Returns `null` for anything that is not a recognizable shim, so the caller falls back to
 * `ComSpec` rather than guessing.
 *
 * @returns {{kind: 'node'|'exe', target: string} | null}
 */
function parseShimTarget(source, shimDir, options = {}) {
  const pathModule = options.pathModule || nodePath;
  const statSync = options.statSync || fs.statSync;
  const tokens = [...String(source).matchAll(/"([^"\r\n]+)"/g)].map((match) => match[1]);

  // A Node shim names its script in a `%~dp0`-relative quoted token. Search from the end because
  // npm appends the script reference last.
  const scriptToken = tokens.slice().reverse()
    .find((token) => /%~?dp0/i.test(token) && /\.(?:cjs|mjs|js)$/i.test(token));
  if (scriptToken) {
    const target = expandShimPath(scriptToken, shimDir, pathModule);
    if (target && _isFile(target, statSync)) return { kind: 'node', target };
  }

  // A native shim (e.g. a Go/Rust CLI) names an .exe instead, and needs no runtime.
  const executableToken = tokens.slice().reverse()
    .find((token) => /%~?dp0/i.test(token) && /\.(?:exe|com)$/i.test(token));
  if (executableToken) {
    const target = expandShimPath(executableToken, shimDir, pathModule);
    if (target && _isFile(target, statSync)) return { kind: 'exe', target };
  }

  return null;
}

function _isFile(target, statSync) {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Decide how to launch `bin` with `args`.
 *
 * Off Windows, and for anything that is not a command script, this is the identity: the caller's
 * own command and argv are returned unchanged.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [options] Injectable seams — tests use them to exercise the Windows branches on
 *   a non-Windows runner. Production callers pass nothing.
 * @returns {{command: string, args: string[], envPatch?: Record<string,string>,
 *   windowsVerbatimArguments?: boolean}}
 */
function resolveCliLaunch(bin, args, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const execPath = options.execPath || process.execPath;
  const readFileSync = options.readFileSync || fs.readFileSync;
  const statSync = options.statSync || fs.statSync;
  const pathModule = options.pathModule || nodePath;
  const argv = Array.isArray(args) ? args.map(String) : [];

  if (platform !== 'win32' || !isWindowsCommandScript(bin)) {
    return { command: bin, args: argv };
  }

  const normalized = pathModule.win32.normalize(bin);

  let source = null;
  try {
    source = readFileSync(normalized, 'utf8');
  } catch {
    // Unreadable shim (missing, or a permission problem) — the ComSpec fallback below still gives
    // a real launch attempt, and a failure there names the path the user configured.
  }

  if (source !== null) {
    const shim = parseShimTarget(source, pathModule.win32.dirname(normalized), { pathModule, statSync });
    if (shim && shim.kind === 'node') {
      // No shell: this is the branch that removes the injection surface entirely.
      return {
        command: execPath,
        args: [shim.target, ...argv],
        envPatch: { ELECTRON_RUN_AS_NODE: '1' },
      };
    }
    if (shim && shim.kind === 'exe') {
      return { command: shim.target, args: argv };
    }
  }

  const doubleEscape = DOUBLE_ESCAPE_RE.test(normalized);
  const shellCommand = [
    escapeCmdCommand(normalized),
    ...argv.map((arg) => escapeCmdArgument(arg, doubleEscape)),
  ].join(' ');
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}

module.exports = {
  resolveCliLaunch,
  parseShimTarget,
  isWindowsCommandScript,
  escapeCmdCommand,
  escapeCmdArgument,
};

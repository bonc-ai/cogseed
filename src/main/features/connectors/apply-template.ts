/**
 * Materialize a concrete `Transport` from a catalog entry's `transport_template` + an OAuth grant.
 *
 * Called at install time AND at every reconnect after a refresh so the spawned MCP server
 * always sees the *current* access_token. The template's `oauth_env_key` / `oauth_header_key` /
 * `env_synthesizer` decides how the token shows up in the spawn env.
 *
 * Validation lives here because catalog entries don't know whether a token is still valid;
 * throw on missing pieces, the caller surfaces the error.
 *
 * Token ownership varies by template. A template that names `oauth_env_key` / `env_synthesizer`
 * (stdio) or carries a Bearer header (streamable-http) is credential-forwarding: CogSeed holds
 * the grant and hands the token to the child, so a missing token is a real error. A stdio
 * template that names neither (see `auth_mode: 'local_cli'`) is credential-owning: the child
 * resolves its own account (e.g. reading an OS keychain via its own CLI) and CogSeed must not
 * require, hold, or forward any token. `grant` is therefore nullable, and the token assertion
 * below fires only for the credential-forwarding shapes.
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from '../../paths';
import type { CatalogEntry, OAuthGrant, Transport } from './types';

type EnvSynth = (access_token: string) => Record<string, string>;

// Cache the Electron-as-Node values once per process — `process.execPath` and PC_ROOT are
// immutable at runtime. Lazy because `app` is undefined in vitest paths that pull this module
// without an Electron context.
let _electronAsNode: { node: string; pcDir: string } | null = null;
function _electronAsNodeVars(): { node: string; pcDir: string } {
  if (_electronAsNode) return _electronAsNode;
  const isPackaged = !!app && app.isPackaged;
  // Packaged builds: rewrite `app.asar` → `app.asar.unpacked` so the spawned child can read the
  // adapter script as a real file on disk (asar contents aren't visible to a child process that
  // doesn't have the asar mount logic). Mirrors `client.ts::buildSkillSandboxEnv`.
  const pcDir = isPackaged
    ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked')
    : paths.PC_ROOT;
  _electronAsNode = { node: process.execPath, pcDir };
  return _electronAsNode;
}

/** Resolve `${COGSEED_NODE}` / `${COGSEED_PC_DIR}` placeholders inside a stdio template's
 *  command / args. Lets connector catalog entries reference our adapter scripts by symbolic
 *  path without hard-coding absolute paths at catalog-author time. Unknown placeholders throw
 *  to surface typos at install — silent passthrough would let `${ORKS_NODE}` slip through and
 *  spawn a literal-named binary that doesn't exist. */
function _resolvePlaceholders(s: string): string {
  const vars = _electronAsNodeVars();
  return s.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, key) => {
    if (key === 'COGSEED_NODE') return vars.node;
    if (key === 'COGSEED_PC_DIR') return vars.pcDir;
    throw new Error(`unknown placeholder \${${key}} in transport template`);
  });
}

function _hasElectronAsNodePlaceholder(tpl: { command: string; args: string[] }): boolean {
  if (/\$\{COGSEED_NODE\}/.test(tpl.command)) return true;
  return tpl.args.some((a) => /\$\{COGSEED_NODE\}/.test(a) || /\$\{COGSEED_PC_DIR\}/.test(a));
}

const _SYNTHESIZERS: Record<string, EnvSynth> = {
  // Notion OAuth: the official @notionhq/notion-mcp-server reads `OPENAPI_MCP_HEADERS`, a JSON
  // blob holding the Authorization + Notion-Version headers.
  notion_oauth_headers(access_token) {
    if (!access_token) throw new Error('notion_oauth_headers: missing access_token');
    return {
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${access_token}`,
        'Notion-Version': '2022-06-28',
      }),
    };
  },
};

/** The only shape this function reads. `interactive_token` entries forward a bare user-supplied
 *  credential, which has no refresh token, scopes or expiry — requiring a whole `OAuthGrant`
 *  would force callers to fabricate those fields. */
export type TemplateToken = { access_token?: string } | null;

export function applyTemplate(entry: CatalogEntry, grant: TemplateToken): Transport {
  if (!entry.transport_template) {
    throw new Error('connector not installable (no transport_template)');
  }
  const tpl = entry.transport_template;
  const token = grant?.access_token || '';
  if (tpl.kind === 'stdio') {
    let env: Record<string, string> = {};
    if (tpl.env_synthesizer) {
      if (!token) throw new Error('OAuth grant has no access_token');
      const synth = _SYNTHESIZERS[tpl.env_synthesizer];
      if (!synth) throw new Error(`unknown env_synthesizer: ${tpl.env_synthesizer}`);
      env = { ...synth(token) };
    } else if (tpl.oauth_env_key) {
      if (!token) throw new Error('OAuth grant has no access_token');
      env[tpl.oauth_env_key] = token;
    }
    // No `else` throw: a stdio template that names neither forwarding key is credential-owning,
    // not misconfigured. The child resolves its own account, so there is nothing to synthesize.

    // Electron-as-Node injection: templates pointing at our own bundled adapter scripts (e.g.
    // `${COGSEED_NODE}` + `${COGSEED_PC_DIR}/bin/gmail-mcp-server.cjs`) need `ELECTRON_RUN_AS_NODE=1`
    // in the child env so Electron boots as plain Node. Same pattern as `client.ts::
    // buildSkillSandboxEnv`. We only inject these when the template actually uses a
    // placeholder — third-party stdio servers like the legacy `npx @modelcontextprotocol/server-X`
    // pattern stay env-clean.
    if (_hasElectronAsNodePlaceholder(tpl)) {
      const vars = _electronAsNodeVars();
      // Adapter entrypoints are unpacked, while their npm dependencies remain
      // in app.asar. Node does not search the sibling archive automatically.
      // Use the canonical app root, never an inherited user NODE_PATH.
      env = { ...env, ELECTRON_RUN_AS_NODE: '1', COGSEED_NODE: vars.node, COGSEED_PC_DIR: vars.pcDir,
        NODE_PATH: path.join(paths.PC_ROOT, 'node_modules') };
    }
    if (entry.id === 'tencent-meeting') {
      const bundled = paths.tencentMeetingBinaryPath();
      if (process.env.COGSEED_TMEET_BIN) env.COGSEED_TMEET_BIN = process.env.COGSEED_TMEET_BIN;
      else if (bundled && fs.existsSync(bundled)) env.COGSEED_TMEET_BIN = bundled;
    }
    return {
      kind: 'stdio',
      command: _resolvePlaceholders(tpl.command),
      args: tpl.args.map((a) => _resolvePlaceholders(a)),
      env,
      ...(tpl.proxy_target_url ? { proxyTargetUrl: tpl.proxy_target_url } : {}),
    };
  }
  // streamable-http
  if (!token) throw new Error('OAuth grant has no access_token');
  const headers: Record<string, string> = {};
  const headerName = tpl.oauth_header_key || 'Authorization';
  // Always send `Bearer` per RFC 6750 — `grant.token_type` is descriptive metadata from the
  // provider (Slack returns "bot", Notion sometimes returns "bearer" lowercase), NOT a wire
  // hint for the HTTP Authorization header. Every MCP server we target treats anything but
  // the literal "Bearer" prefix as missing/invalid token (Slack rejects "bot" with
  // `missing_token`, Notion rejected lowercase "bearer" with `invalid_token`). If we ever
  // need a non-Bearer scheme, add `oauth_header_scheme?: string` to the transport template
  // and default to Bearer.
  //
  // That escape hatch now exists and Tencent Docs uses it: its guide specifies
  // `"Authorization": "<token>"` and the published `qqdocs` client sends the token unprefixed, so
  // the default would have authenticated as nothing.
  const scheme = tpl.oauth_header_scheme === undefined ? 'Bearer' : tpl.oauth_header_scheme;
  // A header value must be Latin-1. Field report: a credential that had picked up a page label got
  // as far as the transport and surfaced as
  //   Cannot convert argument to a ByteString because the character at index 58 has a value of 19979
  // — an engine internal naming a character code. Fail here instead, with a code the renderer
  // localises into "paste only the token". The credential itself is never echoed.
  if (/[^\x20-\x7e]/.test(token)) {
    throw Object.assign(new Error('connector credential is not header-safe'), { code: 'credential_not_a_token' });
  }
  headers[headerName] = scheme ? `${scheme} ${token}` : token;
  return {
    kind: 'streamable-http',
    url: tpl.url,
    headers,
  };
}

/** The CLI owns encryption; both auth and tool connections use the active user's local roots. */
export function scopeTencentMeetingTransport(userId: string, transport: Transport): Transport {
  if (!userId) throw new Error('uid required');
  if (transport.kind !== 'stdio') throw new Error('Tencent Meeting requires stdio');
  return { ...transport, env: { ...transport.env,
    TMEET_CLI_CONFIG_DIR: paths.userTencentMeetingConfigDir(userId),
    TMEET_CLI_DATA_DIR: paths.userTencentMeetingDataDir(userId),
  } };
}

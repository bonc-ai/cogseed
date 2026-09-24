#!/usr/bin/env node
/**
 * Write `.build/build-info.json` — the metadata a packaged app reads back via
 * `src/main/util/build-identity.ts`.
 *
 * Besides channel/commit/dirty/builtAt this bakes the **service origin** the
 * package should talk to. The source tree cannot carry one (open-source
 * publication removed non-owned domains — see the #5 blocker in
 * `docs/release-scan-remediation-20260923.md`), and a double-clicked `.app`
 * inherits no environment, so package time is the only place the real value
 * can enter a release build.
 *
 * Usage:
 *   node scripts/write-build-info.cjs --channel=release
 *   node scripts/write-build-info.cjs --channel=release --hub-api-base=https://hub.acme.test
 *   COGSEED_HUB_API_BASE=https://hub.acme.test node scripts/write-build-info.cjs --channel=release
 *
 * A `--channel=release` build with no origin **fails** rather than silently
 * baking the placeholder: shipping an installer whose account, marketplace and
 * update endpoints are unreachable is worse than not shipping. Set
 * `COGSEED_ALLOW_PLACEHOLDER_HUB=1` to opt out deliberately (e.g. a local
 * layout check).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Normalize `raw` to a clean HTTPS origin, or return null when unusable.
 * Mirrors `src/main/util/https-origin.ts` — the runtime keeps the same rule so
 * a value that passes here can never be rejected (and silently ignored) later.
 */
function normalizeHttpsOrigin(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:'
    || !!url.username
    || !!url.password
    || !!url.search
    || !!url.hash
  ) {
    return null;
  }
  return url.toString().replace(/\/$/, '');
}

/**
 * Decide which origin this build bakes in.
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
function resolveHubApiBaseForBuild({ channel, raw, allowPlaceholder = false } = {}) {
  const value = String(raw ?? '').trim();
  if (!value) {
    if (channel === 'release' && !allowPlaceholder) {
      return {
        ok: false,
        error: [
          'release builds must bake a service origin, but none was provided.',
          'Pass --hub-api-base=<https origin> or set COGSEED_HUB_API_BASE.',
          'The repository variable is COGSEED_HUB_API_BASE_URL (release.yml / build-macos-signed.yml).',
          'Set COGSEED_ALLOW_PLACEHOLDER_HUB=1 only for a deliberate local layout check.',
        ].join(' '),
      };
    }
    return { ok: true, value: '' };
  }
  const normalized = normalizeHttpsOrigin(value);
  if (!normalized) {
    return {
      ok: false,
      error: `COGSEED_HUB_API_BASE must be a clean HTTPS origin without credentials, query, or fragment (got: ${value})`,
    };
  }
  return { ok: true, value: normalized };
}

function argValue(name, argv = process.argv) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

function main(argv = process.argv, env = process.env, root = path.resolve(__dirname, '..')) {
  const channel = argValue('channel', argv) || env.COGSEED_BUILD_CHANNEL || 'packaged-dev';
  const rawBase = argValue('hub-api-base', argv) ?? env.COGSEED_HUB_API_BASE ?? '';
  const decision = resolveHubApiBaseForBuild({
    channel,
    raw: rawBase,
    allowPlaceholder: env.COGSEED_ALLOW_PLACEHOLDER_HUB === '1',
  });
  if (!decision.ok) {
    process.stderr.write(`[build-info] ${decision.error}\n`);
    return 1;
  }
  const info = {
    channel,
    commit: git(root, ['rev-parse', 'HEAD']),
    dirty: git(root, ['status', '--porcelain']).length > 0,
    builtAt: new Date().toISOString(),
  };
  if (decision.value) info.hubApiBase = decision.value;
  const outFile = argValue('out', argv) || path.join(root, '.build', 'build-info.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(info)}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { normalizeHttpsOrigin, resolveHubApiBaseForBuild, main };

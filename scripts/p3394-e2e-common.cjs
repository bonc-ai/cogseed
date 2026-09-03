#!/usr/bin/env node
/**
 * Shared binary-resolution helper for the real-environment P3394 E2E
 * scripts. The E2E scripts used to hard-code macOS install paths; this
 * resolver keeps those as darwin-only defaults, lets an env override win,
 * and falls back to a PATH scan. On Windows the scan is PATHEXT-aware so
 * `.cmd` / `.bat` / `.exe` npm shims resolve like the app's own which.ts.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Resolve the active CogSeed runtime variant used for state files. */
function cogseedRuntimeVariant() {
  const raw = process.env.COGSEED_RUNTIME_VARIANT || process.env.COGSEED_SOURCE_RUNTIME_VARIANT || 'cogseed';
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) && !raw.includes('..') ? raw : 'cogseed';
}

/** Absolute path of a CogSeed runtime state file for the active variant. */
function cogseedStateFilePath(name) {
  return path.join(os.homedir(), '.cogseed', 'runtime-variants', cogseedRuntimeVariant(), name);
}

/** Read the P3394 bridge token ('' when the state file is absent). */
function readCogseedBridgeToken() {
  try {
    return JSON.parse(fs.readFileSync(cogseedStateFilePath('p3394-bridge.json'), 'utf8')).token || '';
  } catch {
    return '';
  }
}

function pathCandidates(name) {
  const pathValue = process.env.PATH || process.env.Path || '';
  const dirs = pathValue.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map((s) => s.trim()).filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * Resolve a CLI binary for a P3394 real E2E script.
 *
 * Priority: explicit env override > darwin default path > PATH scan.
 * `envKey` defaults to `P3394_E2E_<NAME>_BIN`; explicit absolute paths must
 * exist, bare names are resolved through PATH.
 */
function resolveE2eBin(name, opts = {}) {
  const envKey = opts.envKey || `P3394_E2E_${name.toUpperCase()}_BIN`;
  const explicit = process.env[envKey];
  if (explicit && explicit.trim()) {
    const value = explicit.trim();
    if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
      return fs.existsSync(value) ? value : null;
    }
    return pathCandidates(value) || null;
  }
  if (process.platform === 'darwin' && opts.macDefault && fs.existsSync(opts.macDefault)) {
    return opts.macDefault;
  }
  return pathCandidates(name);
}

module.exports = { resolveE2eBin, cogseedRuntimeVariant, cogseedStateFilePath, readCogseedBridgeToken };

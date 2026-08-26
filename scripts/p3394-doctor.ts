#!/usr/bin/env tsx
/**
 * P3394 doctor CLI.
 *
 * Reads the real local node state when available:
 *
 * - P3394_AGENT_HOME (or <cwd>/.p3394-agent-home) manifest.json and
 *   peers/registry.json;
 * - P3394_MANIFEST path override;
 * - P3394_RUNTIME_ADAPTER_BOUND=1 marks the real CogSeed runtime binding.
 *
 * Human-readable by default; --json emits the raw report.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runP3394BridgeDoctor } from '../src/main/features/p3394_bridge/doctor';

function resolveAgentHome(): string | null {
  const explicit = process.env.P3394_AGENT_HOME;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = path.join(process.cwd(), '.p3394-agent-home');
  return fs.existsSync(local) ? local : null;
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const home = resolveAgentHome();
const manifestPath = process.env.P3394_MANIFEST
  ?? (home ? path.join(home, 'manifest.json') : null);
const registryPath = home ? path.join(home, 'peers', 'registry.json') : null;

const manifest = manifestPath ? readJson(manifestPath) : undefined;
const registry = registryPath ? readJson(registryPath) : undefined;
const registryPersisted = registry !== null && typeof registry === 'object'
  && Array.isArray((registry as { peers?: unknown }).peers);
const agentHomeExists = home !== null;
const runtimeAdapterBound = process.env.P3394_RUNTIME_ADAPTER_BOUND === '1';

const report = runP3394BridgeDoctor({
  manifest,
  registryPersisted,
  agentHomeExists,
  runtimeAdapterBound,
});

const json = process.argv.includes('--json');
if (json) {
  process.stdout.write(`${JSON.stringify(report)}\\n`);
} else {
  process.stdout.write('P3394 bridge doctor\n');
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'ok' : check.status === 'warn' ? '!!' : 'FAIL';
    process.stdout.write(`  [${mark}] ${check.name}${check.reason ? ' — ' + check.reason : ''}\\n`);
  }
  process.stdout.write(`result: ${report.ok ? 'pass' : 'FAIL'}\\n`);
}
process.exit(report.ok ? 0 : 1);

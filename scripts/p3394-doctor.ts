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
import * as os from 'node:os';
import * as path from 'node:path';
import { buildP3394WiringDoctorInput, runP3394BridgeDoctor, type P3394WiringDoctorFacts } from '../src/main/features/p3394_bridge/doctor';

/** 运行时导出的 wiring 事实位置（应用启动时 exportP3394DoctorState 写出）。
 *  variant 来自环境变量，白名单校验防止 ../ 路径穿越。 */
function variantStateFile(name: string): string {
  const raw = process.env.COGSEED_RUNTIME_VARIANT || process.env.COGSEED_SOURCE_RUNTIME_VARIANT || 'cogseed';
  const variant = /^[A-Za-z0-9._-]{1,64}$/.test(raw) && !raw.includes('..') ? raw : 'cogseed';
  return path.join(os.homedir(), '.cogseed', 'runtime-variants', variant, name);
}

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

const json = process.argv.includes('--json');
// 优先级 1：运行时导出的 wiring 事实（与 app 内 doctor 同源，14 项完整）。
const runtimeState = readJson(variantStateFile('p3394-doctor-state.json'));
let report;
let sourceLabel = 'disk layout — app runtime export not found';
if (runtimeState && typeof runtimeState === 'object' && (runtimeState as { facts?: unknown }).facts) {
  report = runP3394BridgeDoctor(buildP3394WiringDoctorInput((runtimeState as { facts: P3394WiringDoctorFacts }).facts));
  const exportedAt = typeof (runtimeState as { exported_at?: unknown }).exported_at === 'string'
    ? (runtimeState as { exported_at: string }).exported_at
    : '';
  sourceLabel = 'runtime-exported wiring facts' + (exportedAt ? ', exported ' + exportedAt : '');
} else {
  // 优先级 2：Agent Home 磁盘布局（无运行时导出时的回退）。
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

  report = runP3394BridgeDoctor({
    manifest,
    registryPersisted,
    agentHomeExists,
    runtimeAdapterBound,
  });
}

if (json) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write(`P3394 bridge doctor (${sourceLabel})\n`);
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'ok' : check.status === 'warn' ? '!!' : 'FAIL';
    process.stdout.write(`  [${mark}] ${check.name}${check.reason ? ' — ' + check.reason : ''}\n`);
  }
  process.stdout.write(`result: ${report.ok ? 'pass' : 'FAIL'}\n`);
}
process.exit(report.ok ? 0 : 1);

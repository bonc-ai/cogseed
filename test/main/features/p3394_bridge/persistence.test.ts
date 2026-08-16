import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  P3394PeerRegistry,
} from '../../../../src/main/features/p3394_bridge/registry';
import {
  P3394AuditJournal,
} from '../../../../src/main/features/p3394_bridge/audit-journal';
import {
  runP3394BridgeDoctor,
} from '../../../../src/main/features/p3394_bridge/doctor';

let tmpDir: string;
let counter = 0;

function tmpFile(prefix: string): string {
  counter += 1;
  return path.join(tmpDir, `${prefix}-${counter}.json`);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-persist-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function manifestFor(id: string) {
  return {
    spec_version: 'p3394/1.0',
    identity: { agent_id: id, display_name: id },
    runtime: { kind: 'in_process' },
    capability_profile: { agent_id: id, runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request', 'response', 'inform', 'accept', 'reject', 'cancel', 'error', 'negotiate'], supports_streaming: false, supports_artifacts: false },
    channels: [{ id: 'local-agent-bridge', kind: 'local', direction: 'inbound-outbound' }],
    session: { scope: 'per-conversation', requires_session_id: true },
    security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true },
    conformance: { level: 'bridge-phase-1', registry: false, agent_home: false, runtime_adapter: false },
  } as never;
}

describe('P3394 Phase 1 persistence hardening', () => {
  it('persists the peer registry and restores it in a new instance', async () => {
    const file = tmpFile('registry');
    const registry = new P3394PeerRegistry({ filePath: file });
    registry.register({ identity: { agent_id: 'peer-a', display_name: 'A' }, manifest: manifestFor('peer-a') });
    registry.register({ identity: { agent_id: 'peer-b', display_name: 'B' }, aliases: ['@bee'], manifest: manifestFor('peer-b') });
    expect(fs.existsSync(file)).toBe(true);

    const restored = new P3394PeerRegistry({ filePath: file });
    expect(restored.list().map((p) => p.identity.agent_id).sort()).toEqual(['peer-a', 'peer-b']);
    const resolved = restored.resolve('@bee');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.identity.agent_id).toBe('peer-b');
  });

  it('reflects revoke in the persisted registry', async () => {
    const file = tmpFile('registry-revoke');
    const registry = new P3394PeerRegistry({ filePath: file });
    registry.register({ identity: { agent_id: 'peer-x', display_name: 'X' }, manifest: manifestFor('peer-x') });
    registry.revoke('peer-x');
    const restored = new P3394PeerRegistry({ filePath: file });
    expect(restored.list()).toEqual([]);
  });

  it('appends audit records to the JSONL journal with secret redaction', async () => {
    const file = tmpFile('audit') + '.jsonl';
    const journal = new P3394AuditJournal({ filePath: file });
    journal.append({ event: 'bridge.send', actor_id: 'a', status: 'accepted', metadata: { api_key: 'super-secret', message_id: 'm1' } });
    // Wait for the async append to land.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { metadata: { api_key: string; message_id: string } };
    expect(parsed.metadata.api_key).toBe('[REDACTED]');
    expect(parsed.metadata.message_id).toBe('m1');
  });

  it('tolerates a missing state file on startup', () => {
    const registry = new P3394PeerRegistry({ filePath: path.join(tmpDir, 'does-not-exist.json') });
    expect(registry.list()).toEqual([]);
  });

  it('doctor reports pass/fail/warn for persistence and runtime binding', () => {
    const report = runP3394BridgeDoctor({
      registryPersisted: true,
      agentHomeExists: true,
      runtimeAdapterBound: true,
    });
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => [c.name, c.status])).toEqual(expect.arrayContaining([
      ['registry', 'pass'],
      ['agent-home', 'pass'],
      ['runtime-adapter', 'pass'],
    ]));

    const missing = runP3394BridgeDoctor({
      registryPersisted: false,
      agentHomeExists: false,
      runtimeAdapterBound: false,
    });
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((c) => c.name === 'registry')?.status).toBe('fail');
  });

  it('doctor checks replay, audit, policy and resource bindings', () => {
    const complete = runP3394BridgeDoctor({
      replayProtectionBound: true,
      idempotencyBound: true,
      auditJournalBound: true,
      policyBound: true,
      resourceLimitsMissing: [],
    });
    expect(complete.ok).toBe(true);
    expect(complete.checks.filter((check) => ['replay-protection', 'idempotency', 'audit-journal', 'policy', 'resource-limits'].includes(check.name)).every((check) => check.status === 'pass')).toBe(true);

    const incomplete = runP3394BridgeDoctor({ resourceLimitsMissing: ['rate', 'concurrency'] });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.checks.find((check) => check.name === 'resource-limits')).toMatchObject({ status: 'fail', reason: 'missing resource limits: rate, concurrency' });

    const unreported = runP3394BridgeDoctor({});
    expect(unreported.checks.find((check) => check.name === 'policy')?.status).toBe('warn');
  });

  it('doctor keeps warn defaults without breaking ok on manifest-only input', () => {
    const report = runP3394BridgeDoctor({ manifest: manifestFor('a') });
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'manifest')?.status).toBe('pass');
    expect(report.checks.find((c) => c.name === 'registry')?.status).toBe('warn');
  });

  it('doctor reports the required channel capability gate (SDK §5.4 startup refusal)', () => {
    const ok = runP3394BridgeDoctor({ channelAdapterBound: true, channelCapabilitiesMissing: [] });
    expect(ok.checks.find((c) => c.name === 'channel-capabilities')?.status).toBe('pass');
    const refused = runP3394BridgeDoctor({ channelAdapterBound: true, channelCapabilitiesMissing: ['cancellation', 'identity_proof:bearer-token'] });
    expect(refused.ok).toBe(false);
    expect(refused.checks.find((c) => c.name === 'channel-capabilities')).toMatchObject({
      status: 'fail',
      reason: 'channel cannot carry required semantics: cancellation, identity_proof:bearer-token',
    });
    const unreported = runP3394BridgeDoctor({});
    expect(unreported.checks.find((c) => c.name === 'channel-capabilities')?.status).toBe('warn');
  });
});

describe('P3394 adapter mapping persistence', () => {
  it('restores session/task mappings in a fresh adapter instance after restart', async () => {
    const previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
    process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
    const { createMateRuntimeController } = await import('../../../../src/main/features/cogseed_backend/runtime-controller');
    const { P3394CogseedRuntimeAdapter } = await import('../../../../src/main/features/p3394_bridge/cogseed-runtime-adapter');
    const UID = 'p3394-persist-adapter-user';
    const stateFile = tmpFile('adapter-state');
    const runtime = { shutdown: async () => {}, run: async function* () {
      yield { type: 'result', status: 'completed', text: 'done', metadata: {} };
    } };
    try {
      const controller = createMateRuntimeController({ runtime });
      const adapter = new P3394CogseedRuntimeAdapter({ userId: () => UID, controller, pollIntervalMs: 20, stateFile });
      const binding = await adapter.openSession({ session_id: 'ses-persist-1', agent_id: 'cogseed-agent' });
      const { task_id } = await adapter.deliver({
        message_id: 'msg-persist-1', session_id: 'ses-persist-1', kind: 'task', performative: 'request',
        sender: { agent_id: 'remote' }, recipients: [{ agent_id: 'cogseed-agent' }],
        payload: { parts: [{ type: 'text', text: 'persist me' }] }, idempotency_key: 'idem-persist-1',
      } as never);
      expect(fs.existsSync(stateFile)).toBe(true);

      // Fresh adapter on the same state file reuses the CogSeed session.
      const controller2 = createMateRuntimeController({ runtime });
      const adapter2 = new P3394CogseedRuntimeAdapter({ userId: () => UID, controller: controller2, pollIntervalMs: 20, stateFile });
      const binding2 = await adapter2.openSession({ session_id: 'ses-persist-1', agent_id: 'cogseed-agent' });
      expect(binding2.native_session_id).toBe(binding.native_session_id);
      const { task_id: task2 } = await adapter2.deliver({
        message_id: 'msg-persist-2', session_id: 'ses-persist-1', kind: 'task', performative: 'request',
        sender: { agent_id: 'remote' }, recipients: [{ agent_id: 'cogseed-agent' }],
        payload: { parts: [{ type: 'text', text: 'persist me again' }] }, idempotency_key: 'idem-persist-2',
      } as never);
      // A second deliver creates a fresh task on the same restored session.
      expect(task2).not.toBe(task_id);
      const snapshot = await adapter2.snapshot('ses-persist-1');
      const tasks = (snapshot.state as { tasks: unknown[] }).tasks;
      expect(tasks.length).toBe(2);
    } finally {
      if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
      else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
    }
  });
});

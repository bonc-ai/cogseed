import { describe, expect, it } from 'vitest';
import type { Agent } from '../../../../src/main/features/agents';
import { buildP3394BridgeManifest, P3394PeerRegistry } from '../../../../src/main/features/p3394';

function agent(id = 'agent-registry-1', name = 'Registry Agent'): Agent {
  return { agent_id: id, name, description_zh: '', description_en: '', workflow: 'Work.', category: 'general' } as Agent;
}

function manifest(id = 'agent-registry-1') {
  const result = buildP3394BridgeManifest(agent(id));
  if (!result.ok) throw new Error(result.error.message);
  return result.manifest;
}

describe('P3394 peer and alias registry', () => {
  it('registers and resolves peers by identity and alias', () => {
    const registry = new P3394PeerRegistry();
    const registered = registry.register({ identity: { agent_id: 'agent-registry-1', display_name: 'A' }, aliases: ['@a'], manifest: manifest('agent-registry-1'), now: 't' });
    expect(registered.ok).toBe(true);
    expect(registry.resolve('agent-registry-1')).toMatchObject({ ok: true, value: { identity: { agent_id: 'agent-registry-1' } } });
    expect(registry.resolve('@a')).toMatchObject({ ok: true, value: { identity: { agent_id: 'agent-registry-1' } } });
  });

  it('rejects alias equal to identity and conflicting aliases', () => {
    const registry = new P3394PeerRegistry();
    expect(registry.register({ identity: { agent_id: 'agent-a', display_name: 'A' }, aliases: ['agent-a'], manifest: manifest('agent-a') })).toMatchObject({ ok: false, error: { reason: 'alias_equals_identity' } });
    expect(registry.register({ identity: { agent_id: 'agent-a', display_name: 'A' }, aliases: ['@same'], manifest: manifest('agent-a') }).ok).toBe(true);
    expect(registry.register({ identity: { agent_id: 'agent-b', display_name: 'B' }, aliases: ['@same'], manifest: manifest('agent-b') })).toMatchObject({ ok: false, error: { reason: 'alias_conflict' } });
  });

  it('rejects manifest identity mismatch', () => {
    const registry = new P3394PeerRegistry();
    expect(registry.register({ identity: { agent_id: 'agent-a', display_name: 'A' }, manifest: manifest('agent-b') })).toMatchObject({ ok: false, error: { reason: 'identity_mismatch' } });
  });

  it('stores capabilities / locality / trust policy / expected identity and resolves by capability local-first', () => {
    const registry = new P3394PeerRegistry();
    const far = registry.register({
      identity: { agent_id: 'reviewer-external', display_name: '外部审核' },
      manifest: manifest('reviewer-external'),
      capabilities: ['contract.clause-risk-review'],
      locality: 'external',
      trust_policy: 'verify-manifest',
      expected_identity: 'did:web:reviewer.example:agent',
    });
    expect(far.ok).toBe(true);
    const local = registry.register({
      identity: { agent_id: 'reviewer-local', display_name: '本地审核' },
      manifest: manifest('reviewer-local'),
      capabilities: ['contract.clause-risk-review'],
      locality: 'same_host',
    });
    expect(local.ok).toBe(true);

    // capability resolution ranks local-first
    const byCapability = registry.findByCapability('contract.clause-risk-review');
    expect(byCapability).toMatchObject({ ok: true, value: { identity: { agent_id: 'reviewer-local' } } });

    // persisted fields survive re-resolution
    const farResolved = registry.resolve('reviewer-external');
    expect(farResolved).toMatchObject({
      ok: true,
      value: {
        capabilities: ['contract.clause-risk-review'],
        locality: 'external',
        trust_policy: 'verify-manifest',
        expected_identity: 'did:web:reviewer.example:agent',
      },
    });

    // unknown capability fails explicitly
    expect(registry.findByCapability('no.such.capability')).toMatchObject({ ok: false, error: { reason: 'peer_not_found' } });

    // disabled peers never win capability resolution
    registry.disable('reviewer-local');
    const fallback = registry.findByCapability('contract.clause-risk-review');
    expect(fallback).toMatchObject({ ok: true, value: { identity: { agent_id: 'reviewer-external' } } });
  });

  it('persists peers to the registry file and restores them (ECS restart stability)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'p3394-registry-test-'));
    const file = join(dir, 'peers.json');
    const registry = new P3394PeerRegistry({ filePath: file });
    registry.register({
      identity: { agent_id: 'cell-a', display_name: 'Cell A' },
      manifest: manifest('cell-a'),
      capabilities: ['review'],
      locality: 'same_host',
      endpoints: ['http://127.0.0.1:9000'],
    });
    // 模拟重启：新实例从同一文件恢复
    const restored = new P3394PeerRegistry({ filePath: file });
    expect(restored.resolve('cell-a')).toMatchObject({
      ok: true,
      value: { identity: { agent_id: 'cell-a' }, capabilities: ['review'], locality: 'same_host' },
    });
    expect(restored.findByCapability('review')).toMatchObject({ ok: true, value: { identity: { agent_id: 'cell-a' } } });
    rmSync(dir, { recursive: true, force: true });
  });

  it('touches last_seen_at for liveness (ECS online state)', () => {
    const registry = new P3394PeerRegistry();
    registry.register({ identity: { agent_id: 'cell-b', display_name: 'B' }, manifest: manifest('cell-b') });
    expect(registry.touch('cell-b', '2026-08-15T10:00:00.000Z')).toBe(true);
    expect(registry.resolve('cell-b')).toMatchObject({ ok: true, value: { last_seen_at: '2026-08-15T10:00:00.000Z' } });
    expect(registry.touch('unknown')).toBe(false);
  });

  it('stores node_kind, profiles, channels and policies (guide §7.2 RegisteredNode)', () => {
    const registry = new P3394PeerRegistry();
    const r = registry.register({
      identity: { agent_id: 'forge-1', display_name: 'Forge' },
      manifest: manifest('forge-1'),
      capabilities: ['contract.clause-risk-review'],
      node_kind: 'task_agent',
      supported_profiles: ['p3394-session/1.0', 'p3394-artifact/1.0'],
      preferred_channels: ['p3394+https'],
      data_policy: 'internal',
      cost_policy: 'enterprise-quota',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toMatchObject({
      node_kind: 'task_agent',
      supported_profiles: ['p3394-session/1.0', 'p3394-artifact/1.0'],
      preferred_channels: ['p3394+https'],
      data_policy: 'internal',
      cost_policy: 'enterprise-quota',
    });
    expect(registry.resolve('forge-1')).toMatchObject({ ok: true, value: { node_kind: 'task_agent' } });
  });

  it('rejects autonomous-agent on reduced node kinds (capability/model_runtime)', () => {
    const registry = new P3394PeerRegistry();
    expect(registry.register({
      identity: { agent_id: 'mcp-cap', display_name: 'Cap' },
      manifest: manifest('mcp-cap'),
      capabilities: ['autonomous-agent', 'research.web-analysis'],
      node_kind: 'capability',
    })).toMatchObject({ ok: false, error: { reason: 'capability_profile_mismatch' } });
    expect(registry.register({
      identity: { agent_id: 'model', display_name: 'Model' },
      manifest: manifest('model'),
      capabilities: ['model.text-generation'],
      node_kind: 'model_runtime',
    }).ok).toBe(true);
  });

  it('filters capability resolution by required profile and data classification', () => {
    const registry = new P3394PeerRegistry();
    registry.register({
      identity: { agent_id: 'local-reviewer', display_name: 'LR' },
      manifest: manifest('local-reviewer'),
      capabilities: ['review'],
      supported_profiles: ['p3394-session/1.0'],
      data_policy: 'internal',
      locality: 'same_host',
    });
    registry.register({
      identity: { agent_id: 'cloud-reviewer', display_name: 'CR' },
      manifest: manifest('cloud-reviewer'),
      capabilities: ['review'],
      supported_profiles: ['p3394-session/0.9'],
      data_policy: 'internal',
      locality: 'external',
    });
    // no filter: local-first wins
    expect(registry.findByCapability('review')).toMatchObject({ ok: true, value: { identity: { agent_id: 'local-reviewer' } } });
    // profile filter excludes the external node's old profile
    expect(registry.findByCapability('review', { requiredProfile: 'p3394-session/1.0' })).toMatchObject({ ok: true, value: { identity: { agent_id: 'local-reviewer' } } });
    // strict data classification: a peer without a matching policy is skipped
    expect(registry.findByCapability('review', { dataClassification: 'secret' })).toMatchObject({ ok: false, error: { reason: 'peer_not_found' } });
    expect(registry.findByCapability('review', { dataClassification: 'internal' })).toMatchObject({ ok: true, value: { identity: { agent_id: 'local-reviewer' } } });
  });

  it('prefers session-scoped alias resolution and rejects disabled or revoked peers', () => {
    const registry = new P3394PeerRegistry();
    registry.register({ identity: { agent_id: 'agent-a', display_name: 'A' }, aliases: ['@helper'], manifest: manifest('agent-a') });
    registry.register({ identity: { agent_id: 'agent-b', display_name: 'B' }, aliases: ['@other'], manifest: manifest('agent-b') });
    expect(registry.resolve('@helper', { sessionAliases: { '@helper': 'agent-b' } })).toMatchObject({ ok: true, value: { identity: { agent_id: 'agent-b' } } });
    expect(registry.disable('agent-b').ok).toBe(true);
    expect(registry.resolve('agent-b')).toMatchObject({ ok: false, error: { reason: 'peer_disabled' } });
    expect(registry.revoke('agent-a').ok).toBe(true);
    expect(registry.resolve('@helper')).toMatchObject({ ok: false, error: { reason: 'peer_not_found' } });
  });
});

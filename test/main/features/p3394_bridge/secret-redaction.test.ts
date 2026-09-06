/**
 * §17.1 Secret Redaction 缺口断言：
 *  - manifest 的 runtime.custom_args 不得携带 secret 形态值（桥 token
 *    p3394-<slug>-<slug> 或 32+ 高熵 [A-Za-z0-9] blob）——manifest 会被
 *    协商交换/落盘，secret 必须走独立通道（validate + build 两条路径）；
 *  - KSTAR episode 落盘经 canonical redact 后不含裸桥 token（result 带
 *    p3394-token 也必须被打码），关联 id 保持可追溯。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildP3394BridgeManifest, validateP3394BridgeManifest } from '../../../../src/main/features/p3394_bridge/manifest';
import { recordP3394Episode } from '../../../../src/main/features/p3394_bridge/kstar-episodes';
import { redactP3394Secrets } from '../../../../src/main/features/p3394_bridge/secrets';

const SCRATCH_VARIANT = 'p3394-secret-redaction-' + Math.random().toString(36).slice(2, 8);
process.env.COGSEED_RUNTIME_VARIANT = SCRATCH_VARIANT;

afterEach(() => {
  fs.rmSync(path.join(os.homedir(), '.cogseed', 'runtime-variants', SCRATCH_VARIANT), { recursive: true, force: true });
});

function manifestWithCustomArgs(customArgs: string[]) {
  return {
    spec_version: 'p3394/1.0',
    identity: { agent_id: 'agent-secret-1', display_name: 'S' },
    runtime: { kind: 'cli', cli: 'claude', custom_args: customArgs },
    capability_profile: { agent_id: 'agent-secret-1', runtime_kind: 'cogseed-native', capabilities: ['handle_message'], supported_performatives: ['request', 'response', 'inform', 'accept', 'reject', 'cancel', 'error', 'negotiate'], supports_streaming: false, supports_artifacts: false },
    channels: [{ id: 'local-agent-bridge', kind: 'local', direction: 'inbound-outbound' }],
    session: { scope: 'per-conversation', requires_session_id: true },
    security: { identity_source: 'cogseed-agent', renderer_identity_source: false, model_profile_separate_from_agent_id: true },
    conformance: { level: 'bridge-phase-1', registry: false, agent_home: false, runtime_adapter: false },
  } as never;
}

describe('P3394 secret redaction (§17.1)', () => {
  it('validateP3394BridgeManifest rejects bridge-token-shaped custom_args', () => {
    const result = validateP3394BridgeManifest(manifestWithCustomArgs([
      '--verbose',
      'p3394-abcdefgh12345678-ijklmnop12345678',
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_runtime');
      expect(result.error.field).toBe('runtime.custom_args[1]');
      expect(result.error.message).toContain('secret-shaped');
    }
  });

  it('validateP3394BridgeManifest rejects high-entropy custom_args blobs', () => {
    const result = validateP3394BridgeManifest(manifestWithCustomArgs([
      '--api-key',
      'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6',
    ]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_runtime');
      expect(result.error.field).toBe('runtime.custom_args[1]');
    }
  });

  it('normal CLI flags and bounded values still pass validation', () => {
    const ok = validateP3394BridgeManifest(manifestWithCustomArgs([
      '--verbose', '--model=claude-3-5-sonnet', '--max-turns=20', 'plain-input.txt',
    ]));
    expect(ok.ok).toBe(true);
  });

  it('buildP3394BridgeManifest refuses agent configs whose custom_args carry secrets', () => {
    const agent = {
      agent_id: 'agent-secret-2', name: 'S2', description_zh: '', description_en: '', workflow: '', category: 'general',
      runtime: { kind: 'cli', cli: 'codex', custom_args: ['p3394-token12345678-tokensegment1'] },
    } as never;
    const result = buildP3394BridgeManifest(agent);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_runtime');
      expect(result.error.field).toBe('runtime.custom_args[0]');
    }
  });

  it('kstar episodes never persist a raw bridge token from the result payload', () => {
    const token = 'p3394-abcdefgh12345678-ijklmnop12345678';
    const file = recordP3394Episode({
      session_id: 'ses-secret-1',
      task_id: 'tsk-secret-1',
      goal: '验证 token 不落盘',
      agent_id: 'hermes',
      status: 'completed',
      actions: [
        { sequence: 1, kind: 'delta', at: new Date().toISOString(), text: 'dial used ' + token },
        { sequence: 2, kind: 'completed', at: new Date().toISOString() },
      ],
      result: 'task finished with token ' + token + ' in output',
    });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(token);
    expect(text).toContain('P3394_TOKEN');
    // 关联 id 保持可追溯（redact 不吞掉 trace 键）。
    const record = JSON.parse(text) as { session_id: string; task_id: string; agent_id: string };
    expect(record.session_id).toBe('ses-secret-1');
    expect(record.task_id).toBe('tsk-secret-1');
    expect(record.agent_id).toBe('hermes');
  });

  it('redactP3394Secrets masks token-shaped substrings anywhere in a blob', () => {
    expect(redactP3394Secrets('Bearer p3394-abcdefgh12345678-ijklmnop12345678 end')).not.toContain('abcdefgh12345678');
    expect(redactP3394Secrets('plain text')).toBe('plain text');
  });
});

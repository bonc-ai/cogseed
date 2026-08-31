import { describe, it, expect } from 'vitest';
// gateway.cjs 顶层即起 HTTP 服务，不能整体 require——探测/解析/偏好纯函数
// 抽在 p3394-gateway/models-probe.cjs（依赖注入版），这里直接测模块本体。
import {
  executionPrefsFor,
  extractClaudeResultUsage,
  normalizeClaudeInit,
  claudeModelsCache,
  probeClaudeModels,
  probeSubcommandModels,
  INSPECT_SUBCOMMANDS,
} from '../../../../p3394-gateway/models-probe.cjs';

/** fake 子进程：脚本化 stdout/stderr 推送 + close 触发，不需要真 CLI。 */
function fakeChild(script: { emit?: Array<[string, string]>; closeWith?: number; failSpawn?: Error }) {
  const listeners: Record<string, Array<(v: unknown) => void>> = {};
  return {
    on(event: string, cb: (v: unknown) => void) { (listeners[event] ??= []).push(cb); return this; },
    kill() { return true; },
    stdout: { on(event: string, cb: (v: unknown) => void) { (listeners['stdout:' + event] ??= []).push(cb); return this; } },
    stderr: { on(event: string, cb: (v: unknown) => void) { (listeners['stderr:' + event] ??= []).push(cb); return this; } },
    run() {
      for (const [stream, data] of script.emit ?? []) {
        for (const cb of listeners[stream + ':data'] ?? []) cb(data);
      }
      if (script.failSpawn) {
        for (const cb of listeners.error ?? []) cb(script.failSpawn);
        return;
      }
      for (const cb of listeners.close ?? []) cb(script.closeWith ?? 0);
    },
  };
}

const SPAWN_FN = (script: Parameters<typeof fakeChild>[0]) => () => {
  const child = fakeChild(script);
  // spawn 后异步跑脚本（对齐真实子进程的事件时序）。
  queueMicrotask(() => child.run());
  return child;
};

const CLI_MODEL_REPLY = JSON.stringify({
  result: 'Current model: Sonnet 5 (effort: xhigh)\nUsage: /model <name>. '
    + 'Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.',
});

describe('gateway executionPrefsFor — model + effort passthrough', () => {
  const run = (ext: unknown) => executionPrefsFor({ extensions: ext });

  it('parses model + effort together', () => {
    expect(run({ execution_prefs: { reasoning_effort: 'low', model: 'sonnet' } }))
      .toEqual({ maxThinkingTokens: '8192', reasoningEffort: 'low', model: 'sonnet' });
  });

  it('model alone still travels (no effort)', () => {
    expect(run({ execution_prefs: { model: 'gpt-5.6-sol' } })).toEqual({ model: 'gpt-5.6-sol' });
  });

  it('unknown effort + no model → null (follow CLI defaults)', () => {
    expect(run({ execution_prefs: { reasoning_effort: 'banana' } })).toBeNull();
    expect(run({})).toBeNull();
    expect(run({ execution_prefs: {} })).toBeNull();
    expect(executionPrefsFor(null)).toBeNull();
  });

  it('caps oversized model ids instead of dropping them', () => {
    const prefs = run({ execution_prefs: { model: 'a'.repeat(500) } }) as { model: string };
    expect(prefs.model.length).toBe(200);
  });
});

describe('gateway extractClaudeResultUsage — reply-envelope usage payload', () => {
  it('maps claude result-frame fields to the wire shape', () => {
    expect(extractClaudeResultUsage({
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 200,
      },
      total_cost_usd: 0.05,
      model: 'claude-sonnet-5[1M]',
    })).toEqual({
      input: 100, output: 30, cacheRead: 1_000, cacheCreate: 200,
      costUsd: 0.05, model: 'claude-sonnet-5[1M]',
    });
  });

  it('prefers message.model over the root model field (direct-backend parity)', () => {
    // 真机验证发现的口径差：result 帧的模型名在 message.model，根级可能缺省。
    const out = extractClaudeResultUsage({
      usage: { input_tokens: 1 },
      message: { model: 'claude-opus-5-20260101' },
    }) as { model?: string };
    expect(out.model).toBe('claude-opus-5-20260101');
  });

  it('returns undefined without a usage object (legacy frames)', () => {
    expect(extractClaudeResultUsage({ total_cost_usd: 0.01 })).toBeUndefined();
    expect(extractClaudeResultUsage(undefined)).toBeUndefined();
  });

  it('drops non-numeric costUsd instead of poisoning the envelope', () => {
    const out = extractClaudeResultUsage({ usage: { input_tokens: 1 }, total_cost_usd: 'nope' }) as Record<string, unknown>;
    expect(out.input).toBe(1);
    expect('costUsd' in out).toBe(false);
  });
});

describe('gateway normalizeClaudeInit — init-frame model capture', () => {
  it('normalizes value/displayName rows and captures the current model', () => {
    expect(normalizeClaudeInit({
      type: 'system', subtype: 'init', model: 'claude-sonnet-5[1M]',
      models: [
        { value: 'sonnet', displayName: 'Sonnet' },
        { value: 'opus', displayName: 'Opus' },
        { value: '', displayName: 'bad row' },
        'not an object',
      ],
    })).toEqual({
      models: [
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' },
      ],
      current: 'claude-sonnet-5[1M]',
    });
  });

  it('returns null when the frame carries no usable list', () => {
    expect(normalizeClaudeInit({ type: 'system', subtype: 'init', model: 'x' })).toBeNull();
    expect(normalizeClaudeInit({ models: [] })).toBeNull();
    expect(normalizeClaudeInit(null)).toBeNull();
  });
});

describe('gateway probeClaudeModels — /model local-command probe (injected spawn)', () => {
  it('parses the real /model reply shape into ids and current display name', async () => {
    claudeModelsCache.clear();
    const result = await probeClaudeModels({
      cli: 'claude',
      spawnFn: SPAWN_FN({ emit: [['stdout', CLI_MODEL_REPLY]] }),
      env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { status: string; models: Array<{ id: string }>; current: string };
    expect(result.status).toBe('ready');
    // 尾注 "or a full model ID" 必须被滤掉（含空格）。
    expect(result.models.map((m) => m.id)).toEqual([
      'sonnet', 'opus', 'haiku', 'fable', 'best',
      'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan', 'default',
    ]);
    expect(result.current).toBe('Sonnet 5');
    // 成功探测会填充 init 缓存（current 用 full id 补全的源头）。
    expect(claudeModelsCache.get()?.models.length).toBe(10);
  });

  it('keeps the cached full-id current when a probe re-runs', async () => {
    claudeModelsCache.set({ models: [{ id: 'sonnet', label: 'sonnet' }], current: 'claude-sonnet-5[1M]' });
    const result = await probeClaudeModels({
      cli: 'claude',
      spawnFn: SPAWN_FN({ emit: [['stdout', CLI_MODEL_REPLY]] }),
      env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { current: string };
    expect(result.current).toBe('claude-sonnet-5[1M]');
    claudeModelsCache.clear();
  });

  it('reports unavailable with a reason when the CLI errors out', async () => {
    const result = await probeClaudeModels({
      cli: 'claude',
      spawnFn: SPAWN_FN({ emit: [['stdout', 'not json at all']] }),
      env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { status: string; reason: string };
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('parse_failed');
  });

  it('surfaces spawn failures (CLI missing) as unavailable, not a crash', async () => {
    const result = await probeClaudeModels({
      cli: 'no-such-cli',
      spawnFn: SPAWN_FN({ failSpawn: new Error('ENOENT') }),
      env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { status: string; reason: string };
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('spawn_failed');
  });
});

describe('gateway probeSubcommandModels — per-line enumeration (opencode style)', () => {
  it('parses provider/model lines and strips the provider prefix for labels', async () => {
    const result = await probeSubcommandModels({
      cli: 'opencode',
      presetName: 'opencode',
      spawnFn: SPAWN_FN({ emit: [['stdout', 'opencode/big-pickle\nopencode/claude-opus-5\n\nsome help text line\n']] }),
      env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { status: string; models: Array<{ id: string; label: string }> };
    expect(result.status).toBe('ready');
    expect(result.models).toEqual([
      { id: 'opencode/big-pickle', label: 'big-pickle' },
      { id: 'opencode/claude-opus-5', label: 'claude-opus-5' },
    ]);
  });

  it('returns no_inspect_command for CLIs without a registered subcommand', async () => {
    const result = await probeSubcommandModels({
      cli: 'hermes', presetName: 'hermes',
      spawnFn: SPAWN_FN({}), env: {},
    }) as { status: string; reason: string };
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('no_inspect_command');
    expect(INSPECT_SUBCOMMANDS).toEqual({ opencode: 'models' });
  });
});

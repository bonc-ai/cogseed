import { describe, it, expect } from 'vitest';
// gateway.cjs 顶层即起 HTTP 服务，不能整体 require——探测/解析/偏好纯函数
// 抽在 p3394-gateway/models-probe.cjs（依赖注入版），这里直接测模块本体。
import {
  executionPrefsFor,
  extractClaudeResultUsage,
  estimateOutputTokens,
  normalizeClaudeInit,
  claudeModelsCache,
  probeClaudeModels,
  probeSubcommandModels,
  probeInspectCommand,
  probeStreamJsonInitModel,
  probeCodexConfigModel,
  probeConfigModels,
  createClaudeStreamEventClassifier,
  effortArgsFor,
  effortLevelFor,
  INSPECT_SUBCOMMANDS,
  modelArgsFor,
  modelControllableFor,
  splitModelArgs,
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

describe('gateway executionPrefsFor — model + effort passthrough', () => {  const run = (ext: unknown) => executionPrefsFor({ extensions: ext });

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

  it('forwards an explicit off effort (hermes/openclaw channels) without claude tokens', () => {
    // off 档只透传 reasoningEffort——claude 的 maxThinkingTokens 无 off
    // 语义（CLI 无禁用入口），不产出；参数模板通道（--reasoning none /
    // --thinking off）由 effortArgsFor 消费。
    expect(run({ execution_prefs: { reasoning_effort: 'off' } })).toEqual({ reasoningEffort: 'off' });
  });
});

describe('gateway effort channel — effortArgsFor / effortLevelFor', () => {
  it('resolves the template from the preset, overridable via env', () => {
    const hermesPreset = { effortArgs: '--reasoning {effort}' };
    expect(effortArgsFor(hermesPreset, {})).toBe('--reasoning {effort}');
    expect(effortArgsFor(hermesPreset, { P3394_AGENT_EFFORT_ARGS: '--level {effort}' })).toBe('--level {effort}');
    expect(effortArgsFor({}, {})).toBeNull();
  });

  it('maps CogSeed levels onto CLI vocabularies (identity unless declared)', () => {
    const hermesPreset = { effortLevels: { off: 'none' } };
    expect(effortLevelFor(hermesPreset, 'off')).toBe('none');
    expect(effortLevelFor(hermesPreset, 'low')).toBe('low');
    expect(effortLevelFor(hermesPreset, 'high')).toBe('high');
    // openclaw 的 off|low|high 与 CogSeed 档位同名——无需声明映射。
    expect(effortLevelFor({}, 'off')).toBe('off');
    // 未知档位不映射（null = 不下发，跟随 CLI 默认）。
    expect(effortLevelFor(hermesPreset, 'medium')).toBeNull();
    expect(effortLevelFor(hermesPreset, '')).toBeNull();
  });

  it('opencode --variant / workbuddy --effort channels (flag-verified)', () => {
    // opencode run --help: "--variant model variant (provider-specific
    // reasoning effort, e.g., high, max, minimal)"；off 无真关档 → minimal。
    const opencodePreset = { effortArgs: '--variant {effort}', effortLevels: { off: 'minimal' } };
    expect(effortArgsFor(opencodePreset, {})).toBe('--variant {effort}');
    expect(effortLevelFor(opencodePreset, 'off')).toBe('minimal');
    expect(effortLevelFor(opencodePreset, 'low')).toBe('low');
    expect(effortLevelFor(opencodePreset, 'high')).toBe('high');
    // workbuddy（codebuddy）--help: "--effort <level> (minimal, low, medium,
    // high, xhigh, max)"；同样 off→minimal。
    const workbuddyPreset = { effortArgs: '--effort {effort}', effortLevels: { off: 'minimal' } };
    expect(effortArgsFor(workbuddyPreset, {})).toBe('--effort {effort}');
    expect(effortLevelFor(workbuddyPreset, 'high')).toBe('high');
    expect(effortLevelFor(workbuddyPreset, 'off')).toBe('minimal');
  });
});

describe('gateway estimateOutputTokens — measured output-token heuristic', () => {
  it('counts CJK as ~1 token/char and the rest as ~1 token/4 chars', () => {
    expect(estimateOutputTokens('好')).toBe(1);
    expect(estimateOutputTokens('回复一个字：好')).toBe(7);
    expect(estimateOutputTokens('')).toBe(0);
    expect(estimateOutputTokens(undefined)).toBe(0);
    // 英文 8 字符 → 2 token
    expect(estimateOutputTokens('abcdefgh')).toBe(2);
    // 混合：3 个中文 + 4 个英文 → 3 + 1
    expect(estimateOutputTokens('你好呀abcd')).toBe(4);
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

  it('falls back to modelUsage.canonicalModel (new claude result frames)', () => {
    // 新版 claude：result 帧根级/ message.model 均不再携带模型名，per-model
    // 用量挪进 modelUsage（canonicalModel 是规范名）。真机捕获的形状：
    // modelUsage: { 'claude-sonnet-5[1M]': { canonicalModel: 'claude-sonnet-5', ... } }
    const out = extractClaudeResultUsage({
      usage: { input_tokens: 2790, output_tokens: 9444 },
      total_cost_usd: 0.1756,
      modelUsage: { 'claude-sonnet-5[1M]': { canonicalModel: 'claude-sonnet-5', inputTokens: 2790 } },
    }) as { model?: string; input?: number };
    expect(out.model).toBe('claude-sonnet-5');
    expect(out.input).toBe(2790);
    // 旧字段仍在时优先旧路径（message.model > 根级 model > canonicalModel）。
    const legacyFirst = extractClaudeResultUsage({
      usage: { input_tokens: 1 },
      model: 'claude-opus-5',
      modelUsage: { x: { canonicalModel: 'claude-sonnet-5' } },
    }) as { model?: string };
    expect(legacyFirst.model).toBe('claude-opus-5');
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
    // /model 输出的 effort 副信息一并解析（菜单显示「CLI 当前强度」）。
    expect((result as { current_effort?: string }).current_effort).toBe('xhigh');
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

  it('reports unavailable with a reason when the CLI output is unparseable', async () => {
    const result = await probeClaudeModels({
      cli: 'claude',
      spawnFn: SPAWN_FN({ emit: [['stdout', 'not json at all']] }),
      env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { status: string; reason: string };
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('no_model_list');
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

describe('gateway model-args channel — universal model control declaration', () => {
  it('resolves the template from env override first, then the preset declaration', () => {
    expect(modelArgsFor({ modelArgs: '--model {model}' })).toBe('--model {model}');
    expect(modelArgsFor({ modelArgs: '--model {model}' }, { P3394_AGENT_MODEL_ARGS: '-m {model}' })).toBe('-m {model}');
    // 自定义智能体（无预设）经 env 声明即可控。
    expect(modelArgsFor(null, { P3394_AGENT_MODEL_ARGS: '--model {model}' })).toBe('--model {model}');
    expect(modelArgsFor(null)).toBeNull();
    expect(modelArgsFor({})).toBeNull();
  });

  it('marks controllable when a template or a dedicated channel exists (codex)', () => {
    expect(modelControllableFor({ modelArgs: '-m {model}' })).toBe(true);
    expect(modelControllableFor({ modelControllable: true })).toBe(true); // codex thread 参数通道
    expect(modelControllableFor(null, { P3394_AGENT_MODEL_ARGS: '--model {model}' })).toBe(true);
    expect(modelControllableFor({})).toBe(false);
    expect(modelControllableFor(null)).toBe(false);
  });

  it('expands the {model} placeholder with quote-aware splitting', () => {
    expect(splitModelArgs('--model {model}', 'gpt-5.6-sol')).toEqual(['--model', 'gpt-5.6-sol']);
    expect(splitModelArgs('-m {model}', 'sonnet[1m]')).toEqual(['-m', 'sonnet[1m]']);
    expect(splitModelArgs('--model "{model}" --strict', 'my model')).toEqual(['--model', 'my model', '--strict']);
    expect(splitModelArgs('', 'x')).toEqual([]);
  });
});

describe('gateway probeInspectCommand — declared parsers (universal enumeration)', () => {
  it('parses the workbuddy --help disclosure (help-model-list)', async () => {
    const helpText = [
      '  --include-partial-messages  Output raw SSE',
      '  --model <model>  Model for the current session. Currently supported: (auto, hy4-preview, hy3, glm-5.3, deepseek-v4-pro, custom-local:deepseek-v4-flash)',
      '  --text-to-image-model <model>  for images',
    ].join('\n');
    const result = await probeInspectCommand({
      cli: 'codebuddy',
      args: ['--help'],
      parser: 'help-model-list',
      spawnFn: SPAWN_FN({ emit: [['stdout', helpText]] }),
      env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { status: string; models: Array<{ id: string }> };
    expect(result.status).toBe('ready');
    expect(result.models.map((m) => m.id)).toEqual([
      'auto', 'hy4-preview', 'hy3', 'glm-5.3', 'deepseek-v4-pro', 'custom-local:deepseek-v4-flash',
    ]);
  });

  it('reports unavailable when no parser is declared for the CLI', async () => {
    const result = await probeInspectCommand({
      cli: 'custom-agent', args: ['--models'], parser: 'nope',
      spawnFn: SPAWN_FN({}), env: {},
    }) as { status: string; reason: string };
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('no_inspect_declared');
  });
});

describe('gateway probeStreamJsonInitModel — claude-compatible init-frame current model', () => {
  it('captures init.model and kills the child before any model call', async () => {
    const child = {
      stdinWrites: [] as string[],
      killed: false,
      on() { return this; },
      kill() { this.killed = true; return true; },
      stdout: { on(event: string, cb: (v: unknown) => void) { (this as unknown as { cbs: Array<(v: unknown) => void> }).cbs = ((this as unknown as { cbs?: Array<(v: unknown) => void> }).cbs || []); (this as unknown as { cbs: Array<(v: unknown) => void> }).cbs.push(cb); return this; } },
      stderr: { on() { return this; } },
    } as unknown as { stdout: { cbs: Array<(v: Buffer) => void> }; stdinWrites: string[]; killed: boolean };
    const spawnFn = () => {
      const c = child as unknown as { stdout: { cbs: Array<(v: Buffer) => void> }; stdin: { write: (s: string) => void } };
      c.stdin = { write: (s: string) => { child.stdinWrites.push(s); } };
      // spawn 后异步推 init 帧（模拟 codebuddy：model 有值、models 数组无）。
      queueMicrotask(() => {
        for (const cb of c.stdout.cbs || []) {
          cb(Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', model: 'auto' }) + '\n'));
        }
      });
      return child;
    };
    const result = await probeStreamJsonInitModel({
      cli: 'codebuddy', args: ['-p'], spawnFn, env: { P3394_INSPECT_TIMEOUT_MS: '2000' },
    }) as { current: string | null; models: Array<unknown> | null };
    expect(result?.current).toBe('auto');
    expect(result?.models).toBeNull(); // codebuddy init 不披露清单（实测）
    expect(child.killed).toBe(true);   // init 一到即杀（零模型调用）
    expect(child.stdinWrites).toHaveLength(1); // 触发 init 的 user 消息
  });

  it('returns null on timeout / child exit without init', async () => {
    const r = await probeStreamJsonInitModel({
      cli: 'x', args: [], spawnFn: SPAWN_FN({ closeWith: 1 }), env: { P3394_INSPECT_TIMEOUT_MS: '500' },
    });
    expect(r).toBeNull();
  });
});

describe('gateway probeCodexConfigModel — config.toml current model', () => {
  it('reads the model= line from CODEX_HOME config.toml', async () => {
    const fsLike = {
      readFileSync: () => 'model_provider = "custom"\nmodel = "gpt-5.6-luna"\nnotify = []\n',
    };
    const byEnv = probeCodexConfigModel(fsLike, { CODEX_HOME: '/tmp/any' });
    expect(byEnv).toBe('gpt-5.6-luna');
  });

  it('returns null when the file or the field is missing', () => {
    const fsLike = { readFileSync: () => 'model_provider = "custom"\n' };
    expect(probeCodexConfigModel(fsLike, { CODEX_HOME: '/tmp/any' })).toBeNull();
    const fsMissing = { readFileSync: () => { throw new Error('ENOENT'); } };
    expect(probeCodexConfigModel(fsMissing, {})).toBeNull();
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

describe('gateway probeConfigModels — declared-config enumeration (hermes/openclaw)', () => {
  const HERMES_YAML = [
    'model:',
    '  default: deepseek-v4-flash',
    '  provider: opencode-go',
    '  base_url: \'\'',
    'providers:',
    '  agnes:',
    '    base_url: https://apihub.agnes-ai.com/v1',
    '    default_model: agnes-2.0-flash',
    '    models:',
    '      - agnes-2.0-flash',
  ].join('\n');
  const HERMES_CACHE = JSON.stringify({
    agnes: { fp: 'x', at: 1, models: ['agnes-2.0-flash'] },
    'opencode-go': { fp: 'y', at: 2, models: ['minimax-m3', 'kimi-k3', 'deepseek-v4-flash'] },
  });

  it('enumerates the ACTIVE provider models + current default from hermes config', () => {
    const result = probeConfigModels({
      configModels: 'hermes',
      env: { HOME: '/fake-home' },
      readFileSync: (p: string) => {
        if (p === '/fake-home/.hermes/config.yaml') return HERMES_YAML;
        if (p === '/fake-home/.hermes/provider_models_cache.json') return HERMES_CACHE;
        throw new Error('ENOENT: ' + p);
      },
    }) as { status: string; current: string; models: Array<{ id: string }> };
    expect(result.status).toBe('ready');
    expect(result.current).toBe('deepseek-v4-flash');
    // 只取当前 provider（opencode-go）的清单——那是 CLI 实际会用的模型集。
    expect(result.models.map((m) => m.id)).toEqual(['minimax-m3', 'kimi-k3', 'deepseek-v4-flash']);
  });

  it('enumerates provider models with metadata + the default primary from openclaw config', () => {
    const OPENCLAW_JSON = JSON.stringify({
      models: { mode: 'merge', providers: {
        minimax: { baseUrl: 'x', api: 'anthropic-messages', models: [
          { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', reasoning: true, contextWindow: 204800 },
        ] },
        agnes: { api: 'openai-completions', models: [{ id: 'agnes-2.5-flash' }] },
      } },
      agents: { defaults: { model: { primary: 'agnes/agnes-2.5-flash' } }, list: [] },
    });
    const result = probeConfigModels({
      configModels: 'openclaw',
      env: { HOME: '/fake-home' },
      readFileSync: (p: string) => {
        if (p === '/fake-home/.openclaw/openclaw.json') return OPENCLAW_JSON;
        throw new Error('ENOENT: ' + p);
      },
    }) as { status: string; current: string; models: Array<{ id: string; label: string; contextWindow?: number }> };
    expect(result.status).toBe('ready');
    expect(result.models).toEqual([
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7', contextWindow: 204800 },
      { id: 'agnes-2.5-flash', label: 'agnes-2.5-flash' },
    ]);
    // primary 的 provider/ 前缀剥掉，与清单 id 同口径（isCurrent 命中）。
    expect(result.current).toBe('agnes-2.5-flash');
  });

  it('returns no_config_probe for unknown config keys', () => {
    const unknown = probeConfigModels({ configModels: 'nope', env: {}, readFileSync: () => '' }) as { status: string; reason: string };
    expect(unknown.status).toBe('unavailable');
    expect(unknown.reason).toBe('no_config_probe');
  });
  it('degrades honestly when config files are missing or carry no models', () => {
    const missing = probeConfigModels({
      configModels: 'hermes', env: { HOME: '/fake-home' },
      readFileSync: () => { throw new Error('ENOENT'); },
    }) as { status: string; reason: string };
    expect(missing.status).toBe('unavailable');
    expect(missing.reason).toBe('config_read_failed');

    const empty = probeConfigModels({
      configModels: 'openclaw', env: { HOME: '/fake-home' },
      readFileSync: () => JSON.stringify({ models: { providers: {} }, agents: {} }),
    }) as { status: string; reason: string };
    expect(empty.status).toBe('unavailable');
    expect(empty.reason).toBe('config_no_models');

    const unknown = probeConfigModels({ configModels: 'nope', env: {}, readFileSync: () => '' }) as { status: string; reason: string };
    expect(unknown.status).toBe('unavailable');
    expect(unknown.reason).toBe('no_config_probe');
  });
});

describe('gateway createClaudeStreamEventClassifier — 过程帧结构化', () => {
  const se = (event: unknown) => ({ type: 'stream_event', event });
  const classifyAll = (lines: unknown[]) => {
    const classify = createClaudeStreamEventClassifier();
    return lines.map((l) => classify(l)).filter(Boolean);
  };

  it('emits structured tool start/end from content_block frames', () => {
    const events = classifyAll([
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls ~/.pi' } } }),
      se({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } }),
      se({ type: 'content_block_stop', index: 1 }),
      se({ type: 'content_block_stop', index: 0 }),
    ]) as Array<{ stream: string; data: Record<string, unknown> }>;
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ stream: 'tool', data: { name: 'Bash', phase: 'start', arguments: { command: 'ls ~/.pi' } } });
    expect(events[1]).toEqual({ stream: 'tool', data: { name: 'Bash', phase: 'end' } });
  });

  it('emits reasoning start/end around thinking blocks', () => {
    const events = classifyAll([
      se({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      se({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me check' } }),
      se({ type: 'content_block_stop', index: 0 }),
      se({ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } }),
      se({ type: 'content_block_stop', index: 1 }),
    ]) as Array<{ stream: string; data: Record<string, unknown> }>;
    expect(events.map((e) => `${e.stream}:${e.data.phase}`)).toEqual([
      'item:start', 'item:end', 'item:start', 'item:end',
    ]);
  });

  it('ignores plain deltas, non-stream lines and malformed json', () => {
    const classify = createClaudeStreamEventClassifier();
    expect(classify(se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }))).toBeNull();
    expect(classify({ type: 'assistant', message: {} })).toBeNull();
    expect(classify('not-json{')).toBeNull();
    expect(classify(null)).toBeNull();
  });
});

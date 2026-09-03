// Unified execution entry — renderer + wiring contract.
//
// Pins the acceptance-critical wiring as source contracts (DOM-free, same
// pattern as composer-controls.test.ts):
//   1. the recipient picker is AGENT-ONLY — models and their config belong
//      to the composer's exec-config chip on the right（验收修订：左侧只管
//      「谁执行」）；when a CLI agent is selected that same chip manages the
//      agent's runtime.model
//   2. the exec-config chip is TASK-scoped: it must not write the global
//      default entry (reorderEntries/updateEntryModel) or the global
//      thinking preference (setThinkingLevel); those live in settings
//   3. the send path attaches execution_config; persisted replies carry
//      exec_meta and bubbles render the meta row
//   4. locales expose every new key in all four languages

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const LOCALE_KEYS = [
  'exec_config.menu_title',
  'exec_config.section_model',
  'exec_config.section_effort',
  'exec_config.task_override_badge',
  'exec_config.effort_cli_note',
  'exec_config.effort_cli_forward_note',
  'exec_config.effort_cli_off_unavailable',
  'exec_config.no_reasoning_note',
  'chat.recipient_api_models',
  'chat.recipient_local_agents',
  'chat.recipient_cli_agents',
  'chat.recipient_cli_not_installed',
  'agent_picker.expand_models',
  'settings.thinking.title',
  'agents.exec_default_model',
  'agents.exec_default_thinking',
  'agents.exec_follow_global',
];

describe('unified execution entry — picker scope', () => {
  it('lists API models and local CLIs as recipient groups (masked-id routing)', () => {
    const agents = read('src/renderer/modules/agents.js');
    // 最终版（伪装模型 ID 路由）：@ 接收者选择器同时列「API 连接模型」与
    // 「本机 CLI」两组——伪装 ID cli/<type>@<model> 自带执行通道语义，出现
    // 在接收者列表自洽（化解 408957ef 回撤时「裸模型名属概念混淆」的顾虑）。
    expect(agents).toContain('_renderPickerModelGroup');
    expect(agents).toContain("t('chat.recipient_api_models')");
    expect(agents).toContain('_renderPickerCliGroup');
    expect(agents).toContain("t('chat.recipient_cli_agents')");
    expect(agents).toContain('_openPickerCliAgentModels');
    expect(agents).toContain("data-kind=\"cli-model\"");
    // 选中 CLI 模型 = agent 接收者 + 伪装全串覆盖；顺序必须先 recipient 后
    // override（setChatRecipient 换目标时会清空旧覆盖）。
    expect(agents).toMatch(/kind === 'cli-model'[\s\S]*?setChatRecipient\(target,[\s\S]*?kind: 'agent'[\s\S]*?setExecOverride\(target,[\s\S]*?model: masked/);
    // auto 弹窗维持 agent-only 契约：两类模型分支都直拒 auto 锚点。
    expect(agents).toMatch(/kind === 'model'[\s\S]*?auto-recipient-chip'\) return/);
    expect(agents).toMatch(/kind === 'cli-model'[\s\S]*?anchorId === 'auto-recipient-chip'\) return/);
    // D4 诚实降级：未装 CLI 的行置灰不可选（is-disabled + aria-disabled +
    // 「未检测到」副标 + 无下钻 chevron），检测数据与 chip 未装警示共用
    // cliExecControl.loadCliAvailability（单一数据源，无第二份缓存）；
    // 检测未决保持可选，绝不固化置灰。
    const ctl = read('src/renderer/modules/cli-exec-control.js');
    expect(ctl).toContain('loadCliAvailability');
    expect(ctl).toContain('e.available === true');
    expect(ctl).toContain('cliAvailableFor');
    expect(agents).toContain('cliAvailableFor');
    expect(agents).toMatch(/installed \? '' : ' is-disabled'/);
    expect(agents).toMatch(/aria-disabled="true"/);
    expect(agents).toContain("t('chat.recipient_cli_not_installed'");
    expect(agents).toContain("kind === 'cli-unavailable'");
    // Commander + agents listing intact.
    expect(agents).toContain('__commander__');
    expect(agents).toMatch(/data-kind="agent"/);
  });

  it('masked agent-model routing — bus contract (D6 red line)', () => {
    const bus = read('src/main/features/group_chat/bus.ts');
    const routing = read('src/main/model/agent_model_routing.ts');
    // 前缀与枚举同源（LOCAL_CLI_TYPES），全串两段格式。
    expect(routing).toContain("AGENT_MODEL_PREFIX = 'cli/'");
    expect(routing).toContain('LOCAL_CLI_TYPES');
    // CLI 通道消费前解码一次：resolve 必须出现在两个 CLI 消费点（网关
    // isP3394Gateway 分流、_runCliAgentTurn 的 cliModelForTurn）之前。
    const resolveIdx = bus.indexOf('resolveMaskedCliExecConfig(item.execConfig)');
    const gatewayIdx = bus.indexOf('const isP3394Gateway = agentsFeat.isP3394GatewayAgent');
    const cliModelIdx = bus.indexOf('opts.item.execConfig?.model || runtime.model');
    expect(resolveIdx).toBeGreaterThan(-1);
    expect(gatewayIdx).toBeGreaterThan(resolveIdx);
    expect(cliModelIdx).toBeGreaterThan(resolveIdx);
    // D6 红线：in-process 防御（stripMaskedForInProcess）必须先于
    // turnModelOverride 组装（pickChatEntryGroupForModelOverride 的凭证
    // 过滤会吞伪 provider 并静默回退默认组——隐蔽假成功）。
    const stripIdx = bus.indexOf('stripMaskedForInProcess(item.execConfig)');
    const overrideIdx = bus.indexOf('const turnModelOverride =');
    expect(stripIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeLessThan(overrideIdx);
    // exec_meta 存伪装全串（存储单一真相），回读比对用裸值。
    expect(bus).toContain('cliTransportModel || cliTurnModel');
  });

  it('external-agent control: CLI agents get a REAL model picker gated by the capability table', () => {
    const chip = read('src/renderer/modules/model-chip.js');
    const ctl = read('src/renderer/modules/cli-exec-control.js');
    const conv = read('src/renderer/modules/conversation.js');
    // 外接智能体执行控制（feat/external-agent-exec-control）+ 伪装模型 ID 路由
    // 字面步骤 5：_renderCliModelList 特殊分支已删，CLI 模型清单走
    // _openProviderModels 标准下钻的伪 provider 分支（清单=auth.listModels
    // ('cli-<type>') 全串出口；「跟随 CLI」行/手输/搜索/重扫都在该分支）。
    expect(chip).not.toContain('_renderCliModelList');
    expect(chip).toContain('_openProviderModels');
    expect(chip).toMatch(/provider: 'cli-' \+/);
    expect(chip).toContain("t('exec_config.cli_follow_default')");
    expect(chip).toContain('model-chip-menu-custom');
    expect(chip).toContain("t('exec_config.cli_model_custom_ph')");
    expect(chip).toContain("t('exec_config.cli_models_rescan')");
    expect(chip).toContain("t('exec_config.cli_models_search_ph')");
    // 扫描/手输记忆/能力协商数据源不变。
    expect(ctl).toContain("'p3394.external.listModels'");
    expect(ctl).toContain('execControlFor');
    expect(ctl).toContain('rememberCustomModel');
    expect(chip).not.toContain('CLI_EFFORT_SUPPORTED');
    expect(conv).toContain('window.cliExecControl.effortControllableFor(recipientAgent.runtime.cli)');
    expect(conv).not.toContain('cliExec && cliExec.model');
    expect(conv).not.toContain('cliExec && cliExec.effort');
    // 真开关保留：effort 分段仍在。
    expect(chip).toContain('model-chip-menu-segmented');
    expect(chip).toContain("t('exec_config.effort_cli_forward_note'");
    // 切到外接智能体时 chip 直接亮出 CLI 当前实际模型（扫描披露的
    // current），不是笼统的「CLI 默认」占位；recipient 变化触发后台扫描。
    expect(chip).toContain('effectiveModelLabel');
    expect(chip).toContain("t('exec_config.cli_models_loading')");
    expect(chip).toContain('modelIsCliCurrent');
    expect(chip).toContain('_scanCliCurrentForChips');
    expect(chip).toContain("t('exec_config.cli_current_model_title'");
    // D4 步骤 6 状态条：明确未装时 chip 警示（is-cli-missing + title），未决不警示。
    expect(chip).toContain("t('chat.recipient_cli_not_installed'");
    expect(chip).toContain("loadCliAvailability");
    expect(chip).toMatch(/cliInstalled === false/);
  });
});

describe('unified execution entry — task-scoped exec-config chip', () => {
  it('never writes the global default entry or thinking preference', () => {
    const chip = read('src/renderer/modules/model-chip.js');
    expect(chip).not.toContain('reorderEntries');
    expect(chip).not.toContain('updateEntryModel');
    // The global preference is read for display fallback ONLY.
    expect(chip).not.toContain('prefs.setThinkingLevel');
    expect(chip).toMatch(/prefs\.getThinkingLevel/);
    // Overrides go through the per-cid exec override store, not agent updates.
    expect(chip).toMatch(/setExecOverride\(/);
    expect(chip).not.toContain('agents.update');
  });

  it('resolves the effective config with the same priority as the main process', () => {
    const chip = read('src/renderer/modules/model-chip.js');
    // task override > agent default > global — mirrored from bus.ts.
    expect(chip).toMatch(/override\.provider && override\.model[\s\S]*?agentDefaultModel[\s\S]*?defaultEntry/);
    expect(chip).toMatch(/override\.effort \|\| agentDefaultEffort \|\| _modelChipGlobalEffort/);
    // CLI agents surface the CLI badge instead of an effort value.
    expect(chip).toContain("t('exec_config.cli_badge')");
    // Unsupported models disable the effort options with the reason shown.
    expect(chip).toMatch(/model_effort\.unsupported_hint/);
  });

  it('re-renders the anchor chip at menu-open so chip and menu can never disagree', () => {
    const chip = read('src/renderer/modules/model-chip.js');
    // chip 平时靠事件重渲染；事件丢失/时序错位会停在旧态（真机事故：
    // 接收者已是指挥官，chip 仍显示上一轮 CLI 智能体的「Sonnet 5 · CLI」，
    // 菜单却列 API 条目）。开菜单瞬间必须用当前状态同步重画锚点 chip——
    // 菜单与 chip 消费同一个 _effectiveExecConfig，同步重画后必然一致。
    expect(chip).toMatch(/_toggleExecConfigMenu\(anchor\) {[\s\S]*?_modelChipRenderChip\(anchor\);[\s\S]*?_renderExecConfigMenu\(menu, anchor\)/);
  });

  it('self-heals a null agents cache instead of silently degrading an agent recipient', () => {
    const chip = read('src/renderer/modules/model-chip.js');
    // 接收者是 agent 但缓存为 null（编辑流程置空后回填失败）时，
    // _recipientAgent 后台补拉 loadAgents——否则 chip/菜单静默滑到
    // 指挥官的 API 语义，用户对着 ClaudeCode 会话看到 deepseek 条目。
    expect(chip).toContain('void loadAgents(true)');
  });
});

describe('unified execution entry — send path and bubble meta', () => {
  it('attaches execution_config on every send path (direct, queued, new-chat)', () => {
    const conv = read('src/renderer/modules/conversation.js');
    expect(conv).toContain('function _executionConfigForSend');
    expect(conv.match(/execution_config: /g)?.length).toBeGreaterThanOrEqual(3);
    // API-model recipients arm the one-shot floor reset so the turn isn't
    // hijacked by whichever agent holds the floor.
    expect(conv).toMatch(/r\.kind === 'model'[\s\S]*?_pendingFloorResetByCid\.add/);
  });

  it('persists the per-cid override separately from the recipient map', () => {
    const conv = read('src/renderer/modules/conversation.js');
    expect(conv).toContain("localStorage.getItem(_EXEC_OVERRIDE_LS_KEY)");
    expect(conv).toContain("'chat.execOverrideByCid'");
    expect(conv).toContain("'chat.recipientByCid'");
  });

  it('renders the actual execution config on streaming placeholders and history', () => {
    const conv = read('src/renderer/modules/conversation.js');
    // Live: the execution process event fills the placeholder meta row…
    expect(conv).toMatch(/stream === 'execution'[\s\S]*?_setPlaceholderExecMeta/);
    // …persisted: exec_meta rides the message header on reload.
    expect(conv).toMatch(/gm\.exec_meta \? \{ exec_meta: gm\.exec_meta \}/);
    expect(conv).toMatch(/message\.exec_meta && _formatExecMetaText/);
    expect(conv).toContain('data-role="exec-meta"');
  });

  it('threads the config through the bus and persists it on the turn message', () => {
    const bus = read('src/main/features/group_chat/bus.ts');
    expect(bus).toContain('export interface TurnExecutionConfig');
    // effort priority: task override > agent default > global preference.
    expect(bus).toMatch(/item\.execConfig\?\.effort[\s\S]*?turnAgentSpec\?\.default_thinking[\s\S]*?thinkingLevelForRun\(\)/);
    // model override reaches streamChatWithModel…
    expect(bus).toMatch(/turnModelOverride \? \{ modelOverride: turnModelOverride \}/);
    // …CLI turns swap their model per task…
    expect(bus).toMatch(/opts\.item\.execConfig\?\.model \|\| runtime\.model/);
    // …and the end-of-turn message persists exec_meta.
    expect(bus).toMatch(/turnExecMeta \? \{ exec_meta: turnExecMeta \}/);
  });
});

describe('unified execution entry — agent defaults and settings', () => {
  it('exposes per-agent default model/thinking in the agent detail (custom in-process only)', () => {
    const agents = read('src/renderer/modules/agents.js');
    expect(agents).toContain('_renderAgentDetailExecDefaults');
    expect(agents).toMatch(/default_model: \{ provider: providerId, model: next \}/);
    expect(agents).toMatch(/default_thinking: null/);
  });

  it('moves the global thinking default into the settings page', () => {
    const settings = read('src/renderer/modules/settings.js');
    const html = read('src/renderer/index.html');
    expect(settings).toContain('prefs.setThinkingLevel');
    expect(html).toContain('settings-thinking-select');
  });
});

describe('unified execution entry — locales', () => {
  it('ships every new key in all four languages', () => {
    for (const lang of ['en', 'zh', 'ja', 'pt']) {
      const table = JSON.parse(read(`src/renderer/locales/${lang}.json`)) as Record<string, string>;
      for (const key of LOCALE_KEYS) {
        expect(table[key], `${lang} missing ${key}`).toBeTruthy();
      }
    }
  });
});

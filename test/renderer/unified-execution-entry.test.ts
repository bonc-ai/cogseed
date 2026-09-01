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
  'settings.thinking.title',
  'agents.exec_default_model',
  'agents.exec_default_thinking',
  'agents.exec_follow_global',
];

describe('unified execution entry — picker scope', () => {
  it('keeps the recipient picker agent-only — models are the exec-chip\'s job', () => {
    const agents = read('src/renderer/modules/agents.js');
    // 验收反馈修订：@ 选择器只管「谁执行」，模型一律由右下角执行配置 chip
    // 管理，否则概念混淆。分组行/下钻逻辑必须不存在于 picker 渲染路径。
    expect(agents).not.toContain('recipient_api_models');
    expect(agents).not.toContain('_renderPickerModelGroup');
    expect(agents).not.toContain('data-kind="model"');
    // Commander + agents listing intact.
    expect(agents).toContain('__commander__');
    expect(agents).toMatch(/data-kind="agent"/);
  });

  it('external-agent control: CLI agents get a REAL model picker gated by the capability table', () => {
    const chip = read('src/renderer/modules/model-chip.js');
    const ctl = read('src/renderer/modules/cli-exec-control.js');
    const conv = read('src/renderer/modules/conversation.js');
    // 外接智能体执行控制（feat/external-agent-exec-control）：信封已带
    // execution_prefs.model，能力表内（claude/codex）的 CLI 模型真实可控——
    // 扫描式模型列表（问 CLI 本身）+ 手输兜底必须存在。
    expect(chip).toContain('_renderCliModelList');
    expect(ctl).toContain("'p3394.external.listModels'");
    expect(ctl).toContain('execControlFor');
    // 手输兜底：清单外 id 也能用（CLI 接受完整模型名）。
    expect(ctl).toContain('rememberCustomModel');
    // 能力表防假开关：模型可控性查表而非硬编码，表外 CLI 不渲染模型区。
    expect(chip).not.toContain('CLI_EFFORT_SUPPORTED');
    // 发送侧：模型通用下发（execution_config.model 不设白名单——网关按
    // 参数模板消费，无通道即安全忽略）；effort 仍按能力表把关。
    expect(conv).toContain('cliExec && cliExec.effort');
    expect(conv).not.toContain('cliExec && cliExec.model');
    // 真开关保留：effort 分段仍在。
    expect(chip).toContain('model-chip-menu-segmented');
    expect(chip).toContain("t('exec_config.effort_cli_forward_note'");
    expect(chip).toContain("t('exec_config.cli_models_scanning')");
    // 切到外接智能体时 chip 直接亮出 CLI 当前实际模型（扫描披露的
    // current），不是笼统的「CLI 默认」占位；recipient 变化触发后台扫描。
    expect(chip).toContain('scanCurrent');
    expect(chip).toContain('modelIsCliCurrent');
    expect(chip).toContain('_scanCliCurrentForChips');
    expect(chip).toContain("t('exec_config.cli_current_model_title'");
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

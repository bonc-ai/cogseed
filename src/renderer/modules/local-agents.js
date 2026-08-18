// ─── Local CLI agents (renderer side) ─────────────────────────────────
//
// Two surfaces share this module:
//   1. The agent-modal "external" tab — selector lists every detected CLI
//      (default: "not selected"). Selecting one auto-fills name + description
//      from CLI_DEFAULTS so a single click is enough to ship an
//      external-agent shell.
//   2. The agent-detail runtime selector (existing CLI-bound agents)
//      lives in agents.js; this module just supplies the registry list.
//
// CLI_DEFAULTS holds the bilingual seed values used by both create
// and edit. `description_zh` + `description_en` are stored side-by-
// side on the agent so locale switches are zero-cost; `name` is a
// single brand label (the user can rename to disambiguate two
// instances of the same CLI bound to different project directories).
//
// Detection starts when the External Agent selector/runtime picker is opened
// and is cached thereafter. Startup must not spawn five version probes for a
// surface the user may never visit.

const _localAgentsLog = createLogger('local-agents');

// Product-supported external Agent presets. Keep this list intentionally
// narrower than the low-level local CLI registry: OpenCode may be runnable by
// internal/dev surfaces, but the External tab is a stable five-Agent product
// contract whose entries auto-configure a managed P3394 gateway on confirm.
// Product-supported external Agent presets. This is the stable external-agent
// product contract (renderer status test locks these six); the gateway preset
// inventory is intentionally a superset (gemini/aider templates remain usable
// via the gateway but are not exposed as first-class External-tab entries yet).
const EXTERNAL_DEFAULT_CLI_TYPES = Object.freeze([
  'claude',
  'codex',
  'openclaw',
  'opencode',
  'hermes',
  'workbuddy',
]);

// Single source of truth for default name + description per CLI type.
// English-source (per CLAUDE.md "English-only project text") with the
// Chinese variant carried alongside for the agent description pair.
const CLI_DEFAULTS = {
  claude: {
    name: 'ClaudeCode',
    description_zh: '代码研发智能体——通过 P3394 协议接入本机 Claude Code，在本地项目里端到端做软件开发：实现新功能、修复 bug、跨多文件重构、写测试、调试；适合"实现一下这个功能"、"把这个 bug 修了"、"重构这个模块"、"给这段代码加测试"；触发词：写代码、开发、实现、修 bug、重构、加功能、写测试、改代码、调试',
    description_en: "Coding agent connected to the local Claude Code CLI through P3394 — builds features, fixes bugs, refactors across files, writes tests, and debugs in your local project; For: 'implement this feature', 'fix this bug', 'refactor this module', 'add tests for this code'; Triggers: code, develop, implement, fix bug, refactor, add feature, write tests, edit code, debug",
    isCoding: true,
  },
  codex: {
    name: 'Codex',
    description_zh: '代码研发智能体——通过 P3394 协议接入本机 Codex，在本地项目里端到端做软件开发：实现新功能、修复 bug、跨多文件重构、按需求/issue 打补丁；适合"实现一下这个功能"、"按 issue 描述打个补丁"、"修一下这个 bug"、"重构这块逻辑"；触发词：写代码、开发、实现、修 bug、重构、加功能、补丁、改代码、issue',
    description_en: "Coding agent connected to the local Codex CLI through P3394 — builds features, fixes bugs, refactors across files, and patches against requirements or issues in your local project; For: 'implement this feature', 'patch following this issue', 'fix this bug', 'refactor this logic'; Triggers: code, develop, implement, fix bug, refactor, add feature, patch, edit code, issue",
    isCoding: true,
  },
  openclaw: {
    name: 'OpenClaw',
    description_zh: '通用任务智能体——通过 P3394 协议接入本机 OpenClaw，进行任务编排与轻量自动化，擅长把不同模型和工具组合起来跑流程；适合"把这几个工具串起来跑一遍"、"用便宜的模型先草稿一版"、"换个模型再答一次比较"；触发词：编排、自动化、多模型、切换、跑流程、串起来、组合',
    description_en: "General-purpose agent connected to the local OpenClaw CLI through P3394 for task orchestration and lightweight automation; For: 'chain these tools and run the flow', 'draft this with a cheap model first', 'try the same prompt on another model to compare'; Triggers: orchestrate, automate, multi-model, switch model, run flow, chain, compose",
    isCoding: false,
  },
  opencode: {
    name: 'OpenCode',
    description_zh: '代码研发智能体——在本地项目里做软件开发,支持自选模型(含本地模型),实现功能、修 bug、改文件、跑终端命令,可换模型对比；适合"用本地模型实现这个功能"、"修一下这个 bug"、"换个模型再写一版"、"在终端里跑一下"；触发词：写代码、开发、实现、修 bug、改代码、换模型、本地模型、终端',
    description_en: "Coding agent for software development in your local project with bring-your-own-model (including local models) — builds features, fixes bugs, edits files, and runs terminal commands, swap models to compare; For: 'implement this feature with a local model', 'fix this bug', 'try another model and rewrite', 'run it in the terminal'; Triggers: code, develop, implement, fix bug, edit code, switch model, local model, terminal",
    isCoding: false,
  },
  hermes: {
    name: 'Hermes',
    description_zh: '通用任务智能体——通过 P3394 协议接入本机 Hermes，执行多步任务、调用工具、按会话粒度续接，擅长按既定流程一步步推进；适合"按这个流程一步步做下来"、"接着上次的会话继续"、"调几个工具配合完成这件事"；触发词：多步、流程、任务、工具调用、会话续接、协同',
    description_en: "General-purpose multi-step agent connected to the local Hermes CLI through P3394, with tool use and session-scoped resume; For: 'walk through this process step by step', 'continue from the last session', 'coordinate a few tools to finish this'; Triggers: multi-step, process, task, tool use, resume session, coordinate",
    isCoding: false,
  },
  workbuddy: {
    name: 'WorkBuddy',
    description_zh: '代码研发智能体——通过 P3394 协议接入本机 WorkBuddy（CodeBuddy CLI），在本地项目里端到端做软件开发：实现新功能、修复 bug、跨多文件重构、写测试、调试；适合"实现一下这个功能"、"把这个 bug 修了"、"重构这个模块"、"给这段代码加测试"；触发词：写代码、开发、实现、修 bug、重构、加功能、写测试、改代码、调试',
    description_en: "Coding agent connected to the local WorkBuddy CodeBuddy CLI through P3394 — builds features, fixes bugs, refactors across files, writes tests, and debugs in your local project; For: 'implement this feature', 'fix this bug', 'refactor this module', 'add tests for this code'; Triggers: code, develop, implement, fix bug, refactor, add feature, write tests, edit code, debug",
    isCoding: true,
  },
};

/** Defaults for a given CLI type, or null when the type is unknown. */
function getCliDefaults(cliType) {
  return cliType && Object.prototype.hasOwnProperty.call(CLI_DEFAULTS, cliType)
    ? CLI_DEFAULTS[cliType]
    : null;
}

/** True when the CLI is one of claude / codex (the coding agents that
 *  expose a project-directory setting). Mirrors
 *  `cliIsCodingAgent` in features/agents.ts — keep in sync. */
function cliIsCodingAgent(cliType) {
  const d = getCliDefaults(cliType);
  return !!(d && d.isCoding);
}

/** Localized recovery hint for an unavailable registry entry. Keep the
 * registry error code intact instead of collapsing every unavailable CLI
 * into "not installed". WorkBuddy gets a dedicated guide because its CLI
 * (codebuddy) is deliberately NOT on PATH — it ships inside the app bundle
 * or under ~/.local/bin, so "add it to PATH" would be wrong advice. */
function getLocalCliUnavailableHint(entry) {
  if (entry?.type === 'workbuddy') {
    return t('agent.cli_missing_workbuddy');
  }
  if (entry?.error === 'version_unknown') {
    return t('agent.cli_version_unknown');
  }
  if (entry?.error === 'version_too_old') {
    return t('agent.cli_version_too_old', { version: entry.version || '?' });
  }
  return t('agent.cli_not_found');
}

let _localCliEntries = null;

async function loadLocalCliEntries({ force = false } = {}) {
  if (_localCliEntries && !force) return _localCliEntries;
  try {
    const res = await window.cogseed.invoke('localAgents.list', { force });
    _localCliEntries = Array.isArray(res?.entries) ? res.entries : [];
  } catch (e) {
    _localAgentsLog.warn('localAgents.list failed', e);
    _localCliEntries = [];
  }
  return _localCliEntries;
}

// ── External-tab CLI selector (create modal) ───────────────────────────
//
// Sentinel value for "not selected" — distinct from empty string so a user who
// genuinely empties the selector still re-routes through this branch.
const EXT_CLI_NONE = '__none__';

let _extCliSelectApi = null;

// 「正在扫描本机 CLI…」的最小可见时长：本机探测很快（实测约 200ms），
// 若探测一返回就立刻切到最终列表，扫描态会被 modal 打开动画吞掉，用户
// 会误以为没有真正扫描。探测本身不变，只在拿到结果后把切换延迟到至少
// 展示这么久，纯展示保底，不影响探测时序与结果。
const EXT_CLI_SCAN_MIN_VISIBLE_MS = 300;

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mount the External-tab CLI selector. Default option is "not
 * selected"; detected CLIs follow. `onChange` fires with the chosen
 * `LocalCliType` (string) or null when the user reverts to the "not
 * selected" sentinel — agents.js wires
 * this to the auto-fill logic.
 *
 * Idempotent: re-mounting just resets options + value so a re-open of
 * the modal picks up newly-installed CLIs.
 */
let _externalGateways = [];
let _externalPanelData = null;

/** Load managed P3394 gateway status for the External tab. */
async function loadExternalGateways({ force = false } = {}) {
  if (_externalGateways.length && !force) return _externalGateways;
  try {
    const res = await window.cogseed.invoke('p3394.external.list', { force });
    _externalGateways = Array.isArray(res?.gateways) ? res.gateways : [];
  } catch (e) {
    _localAgentsLog.warn('p3394.external.list failed', e);
    _externalGateways = [];
  }
  return _externalGateways;
}

/** Single-probe panel data: p3394.external.list already returns both the
 *  detected CLI entries and the managed gateway status, so the External
 *  tab selector consumes one IPC round-trip instead of two (localAgents.list
 *  + p3394.external.list each re-running detectAll). The response also
 *  carries the registry snapshot (`peers`) so the "connected nodes" area
 *  renders from the same probe.
 *
 *  In-flight dedup: 切到「外接」tab 时 CLI 选择器与"已接入节点"管理区几乎
 *  同时请求同一份数据，未去重会让 force 探测重复执行两次完整的 detectAll。
 *  这里把并发调用合并到同一个 promise 上（force 语义由首个调用决定）。 */
let _externalPanelDataInflight = null;
async function loadExternalPanelData({ force = false } = {}) {
  if (_externalPanelData && !force) return _externalPanelData;
  if (_externalPanelDataInflight) return _externalPanelDataInflight;
  _externalPanelDataInflight = (async () => {
    try {
      const res = await window.cogseed.invoke('p3394.external.list', { force });
      _externalPanelData = {
        entries: Array.isArray(res?.entries) ? res.entries : [],
        gateways: Array.isArray(res?.gateways) ? res.gateways : [],
        // cli → 已绑定 agent 名字列表（同 CLI 允许多个外接 agent）。渲染端用
        // 它给「外接」tab 打「已连接」标记，提示当前实例已有该本地 CLI 的成员。
        bound: (res && typeof res.bound === 'object' && res.bound !== null) ? res.bound : {},
        // 统一注册表快照：全部已注册 P3394 节点（含在线状态/能力/端点）。
        peers: Array.isArray(res?.peers) ? res.peers : [],
      };
      return _externalPanelData;
    } catch (e) {
      _localAgentsLog.warn('p3394.external.list failed', e);
      _externalPanelData = { entries: [], gateways: [], bound: {}, peers: [] };
      return _externalPanelData;
    } finally {
      _externalPanelDataInflight = null;
    }
  })();
  return _externalPanelDataInflight;
}

/** User action: remove a registered node (registry + projection + its
 *  managed gateway). Resolves to the IPC result. */
async function revokeP3394Peer(agentId) {
  const res = await window.cogseed.invoke('p3394.peers.revoke', { agentId });
  _externalPanelData = null;
  return res;
}

/** User action: disable/enable a registered node. */
async function toggleP3394Peer(agentId, disabled) {
  const res = await window.cogseed.invoke('p3394.peers.toggle', { agentId, disabled });
  _externalPanelData = null;
  return res;
}

async function mountExternalCliSelect(onChange) {
  const mount = document.getElementById('agent-modal-ext-cli-select');
  if (!mount) return null;
  const noneLabel = t('agent_modal.ext_cli_none');
  const scanningLabel = t('agent_modal.ext_cli_scanning');
  const handleChange = (v) => {
    const cli = (!v || v === EXT_CLI_NONE) ? null : v;
    if (typeof onChange === 'function') onChange(cli);
  };
  // Clear the previous result immediately. This makes the real local probe
  // visible instead of leaving a stale cached menu on screen while IPC runs.
  const scanningOptions = [{ value: EXT_CLI_NONE, label: scanningLabel }];
  if (!_extCliSelectApi) {
    _extCliSelectApi = _aiSelectMount(mount, {
      options: scanningOptions, value: EXT_CLI_NONE,
      placeholder: noneLabel, onChange: handleChange,
    });
  } else {
    _extCliSelectApi.setOptions(scanningOptions, { value: EXT_CLI_NONE });
  }
  // The modal may have been opened before the user installed a CLI. Re-probe
  // on every open so the renderer's longer-lived cache cannot preserve a
  // stale "not installed" result for the rest of the app session.
  const scanStartedAt = Date.now();
  const { entries, gateways, bound } = await loadExternalPanelData({ force: true });
  // 保证「正在扫描本机 CLI…」至少可见 EXT_CLI_SCAN_MIN_VISIBLE_MS：
  // 探测跑得过快（本机 ~200ms）时把结果显示平移到保底时长之后，让扫描
  // 状态真实可见；探测本身无变化，超时时段的余量被静默等待。
  const scanElapsed = Date.now() - scanStartedAt;
  if (scanElapsed < EXT_CLI_SCAN_MIN_VISIBLE_MS) {
    await _sleep(EXT_CLI_SCAN_MIN_VISIBLE_MS - scanElapsed);
  }
  const entryByType = new Map(entries.map((entry) => [entry.type, entry]));

  // 不可用预设的可见引导（不静默消失）：用户能知道"为什么没有这一项、
  // 该怎么处理"——WorkBuddy 提示无需注册 PATH（见 getLocalCliUnavailableHint）。
  const missingHint = document.getElementById('agent-ext-missing-hint');
  const missing = EXTERNAL_DEFAULT_CLI_TYPES
    .map((type) => entryByType.get(type))
    .filter((entry) => entry && !entry.available);
  if (missingHint) {
    missingHint.style.display = missing.length ? '' : 'none';
    missingHint.innerHTML = '';
    if (missing.length) {
      const title = document.createElement('div');
      title.className = 'agent-ext-missing-title';
      title.textContent = t('agent_modal.ext_cli_missing_label');
      missingHint.appendChild(title);
      for (const entry of missing) {
        const item = document.createElement('div');
        item.className = 'agent-ext-missing-item';
        const name = document.createElement('span');
        name.className = 'agent-ext-missing-name';
        name.textContent = (getCliDefaults(entry.type)?.name) || entry.type;
        item.appendChild(name);
        item.appendChild(document.createTextNode(' — ' + getLocalCliUnavailableHint(entry)));
        missingHint.appendChild(item);
      }
    }
  }
  // Stable five-Agent order; local discovery controls whether a preset is
  // selectable and supplies its absolute binary path + detected version.
  const available = EXTERNAL_DEFAULT_CLI_TYPES
    .map((type) => entryByType.get(type))
    .filter((entry) => entry && entry.available);
  const runningLabel = t('agent_modal.ext_cli_running');
  const connectedLabel = t('agent_modal.ext_cli_connected');
  const options = [
    { value: EXT_CLI_NONE, label: noneLabel },
    ...available.map(e => {
      const gw = gateways.find(g => g && g.cli === e.type);
      const status = gw && gw.running ? runningLabel : '';
      // 同 CLI 允许多个外接 agent；已绑定只打标不禁用，让用户看到当前
      // 实例已有该 CLI 的成员（含名字，方便识别是哪个在占用）。
      const boundNames = (bound && Array.isArray(bound[e.type])) ? bound[e.type] : [];
      // label 最终经 textContent 渲染（不解析 HTML），直接以原文拼接名字即可。
      const boundMark = boundNames.length
        ? ` ${connectedLabel}(${boundNames.join('/')})`
        : '';
      return {
        value: e.type,
        label: `${(getCliDefaults(e.type)?.name) || e.type}${e.version ? ` (${e.version})` : ''}${status ? ' ' + status : ''}${boundMark}`,
      };
    }),
  ];
  if (!_extCliSelectApi) {
    _extCliSelectApi = _aiSelectMount(mount, {
      options, value: EXT_CLI_NONE,
      placeholder: noneLabel,
      onChange: handleChange,
    });
  } else {
    _extCliSelectApi.setOptions(options, { value: EXT_CLI_NONE });
  }
  return _extCliSelectApi;
}

/** Read the currently-selected CLI type from the External tab, or null
 *  when the user kept the "not selected" sentinel. */
function getExternalCliValue() {
  const v = _extCliSelectApi ? _extCliSelectApi.getValue() : EXT_CLI_NONE;
  if (!v || v === EXT_CLI_NONE) return null;
  return v;
}

/** Programmatically set the External-tab selector (used by edit form
 *  to seed from the bound CLI). Pass null to revert to the "not
 *  selected" sentinel. */
function setExternalCliValue(cliType) {
  if (!_extCliSelectApi) return;
  _extCliSelectApi.setValue(cliType || EXT_CLI_NONE);
}

window.loadLocalCliEntries = loadLocalCliEntries;
window.loadExternalGateways = loadExternalGateways;
window.loadExternalPanelData = loadExternalPanelData;
window.revokeP3394Peer = revokeP3394Peer;
window.toggleP3394Peer = toggleP3394Peer;
window.getExternalDefaultCliTypes = () => [...EXTERNAL_DEFAULT_CLI_TYPES];
window.getCliDefaults = getCliDefaults;
window.cliIsCodingAgent = cliIsCodingAgent;
window.getLocalCliUnavailableHint = getLocalCliUnavailableHint;
window.mountExternalCliSelect = mountExternalCliSelect;
window.getExternalCliValue = getExternalCliValue;
window.setExternalCliValue = setExternalCliValue;

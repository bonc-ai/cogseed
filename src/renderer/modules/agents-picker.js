// agents-picker.js — Agent/Skill/Artifact/Asset「@ 选择器」大区块。
// 从 agents.js 按职责拆出（R4）：popover 定位 / tab 管理 / 各 tab 列表渲染 /
// 任务引用 chips / _triggerPickerItem 派发 / @ 键处理 / bindRecipientAnchor。
// 依赖 agents.js 的模块态与工具（_agentsCache、_agentSource、useAgent、
// _agentsLog 等）：classic <script> 经共享全局词法环境跨文件引用，本文件
// 必须排在 agents.js 之后加载（顺序见 index.html 的 script 标签）。

// ─── Agent picker (one-shot, works on both new-chat and conversation) ───
// Selecting an agent immediately fires a send with the agent's workflow
// auto-injected on the backend. The selection does NOT persist — the user
// picks an agent each time they need one.

// Place popover above the **input area** (not just the anchor button) so
// it never covers the textarea — the toolbar buttons sit at the bottom of
// the input area, and computing "above" from the button alone meant the
// popover's bottom edge landed on top of the textarea above. We look for
// any chat-input wrapper / area ancestor (main conv, new-chat, skill-edit,
// agent-edit) and use its top as the "above" reference, falling back to
// the anchor's own rect for unrelated anchors.
const _INPUT_AREA_CLASS_RE = /(?:^|\s)(?:chat|new-chat|skills-chat|agents-chat)-input-(?:wrapper|area)(?:\s|$)/;
function _findInputAreaTop(anchorEl) {
  let cur = anchorEl;
  while (cur && cur !== document.body) {
    const cls = cur.className;
    if (typeof cls === 'string' && _INPUT_AREA_CLASS_RE.test(cls)) {
      return cur.getBoundingClientRect().top;
    }
    cur = cur.parentElement;
  }
  return null;
}

function _positionPopoverAboveOrBelow(popover, anchorEl, opts = {}) {
  // Make invisible but laid out so we can measure it before positioning.
  popover.style.display = 'flex';
  popover.style.left = '-9999px';
  popover.style.top = '-9999px';
  popover.style.maxHeight = '';
  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  // Reference top for "above" computation: top of the whole input area
  // when the anchor lives in the chat composer; otherwise the anchor's
  // own top. This keeps the popover from overlapping the textarea on
  // chat panels while still working for any other future anchor.
  const aboveRef = _findInputAreaTop(anchorEl);
  // Recipient chips want the popover ANCHORED TO THE BUTTON itself —
  // aligning to the input area leaves it floating ~100px above the chip
  // (验收反馈两轮「位置不对」的根因), because the input-area box extends
  // far above the button row.
  const refTop = (opts.anchorToButton ? null : aboveRef) ?? rect.top;
  const availAbove = refTop - margin - gap;
  const availBelow = window.innerHeight - rect.bottom - margin - gap;
  const preferAbove = popRect.height <= availAbove || availAbove >= availBelow;

  let left = rect.left;
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  if (left < margin) left = margin;

  let top;
  if (preferAbove) {
    const maxH = Math.max(0, availAbove);
    if (popRect.height > maxH) popover.style.maxHeight = maxH + 'px';
    top = Math.max(margin, refTop - Math.min(popRect.height, maxH) - gap);
  } else {
    const maxH = Math.max(0, availBelow);
    if (popRect.height > maxH) popover.style.maxHeight = maxH + 'px';
    top = rect.bottom + gap;
  }
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}

// Expose so skills.js can reuse the same positioning math (DRY across the
// two pickers; behaviour must stay identical so users get consistent UX).
if (typeof window !== 'undefined') {
  window.positionPickerPopover = _positionPopoverAboveOrBelow;
}

// Project scope state for the active picker session: when the anchor's
// active context (commander tab / current conv) belongs to a project, the
// picker collapses to that project's bound agents. `null` = no project
// scope active (orphan conv / no project picked) → unrestricted listing.
// Set on every `_openAgentPicker`; consumed by `_renderAgentPickerList` and
// the search-input change handler so live filtering stays scoped.
let _pickerBoundAgentIds = null;
let _pickerBoundSkillIds = null; // 情境空间一期：同 scope.resolve 的 skills 作用域
let _pickerProjectId = '';
let _pickerScopeSpace = null; // 情境空间一期：当前项目绑定空间摘要
let _pickerLibraryRows = null;
let _pickerLibraryLoading = null;
let _pickerLibraryRenderSeq = 0;
// "本体" tab cache — same lazy-load-once-per-picker-session pattern as
// _pickerLibraryRows above, but scoped to personalOntology.groups.list (no
// project-scoped variant, per §3.7's "only the hidden groups sub-dir" bound).
let _pickerOntologyEntries = null;
let _pickerOntologyLoading = null;
// 本体 tab：被用户收起的分组（parentId 集合）—— 分组标题行可折叠子条目。
// parentId 是 PO contract 给的展示用标识（模板 = templateId），不是 PO 内部 group_id。
let _pickerOntologyCollapsed = new Set();
let _pickerOntologyRenderSeq = 0;
let _agentPickerTab = 'agents';
let _agentPickerOpenSeq = 0;
let _agentPickerLoadedTabs = new Set();
const _agentPickerTabLoads = new Map();
let _pickerProjectContextLoading = false;
let _pickerProjectContextSeq = 0;
// 产物/资产 tab（空间会话 @ 引用）：懒加载缓存（每 picker 会话重置一次）
let _pickerArtifactRows = null;        // 空间产物（spaces.artifacts.list）
let _pickerArtifactTitles = new Map(); // cid → 会话标题（引用 source_title）
let _pickerArtifactLoading = null;
let _pickerArtifactRenderSeq = 0;
let _pickerAssetRows = null;           // 全局沉淀资产（recall.assets.list）
let _pickerAssetLoading = null;
let _pickerAssetRenderSeq = 0;
// 任务引用 chips（composer 引用条）：conversation = 已持久化 task_references；
// new-chat = 待提交 pending（会话创建后写入 task_references）
let _pendingNewChatRefs = [];          // TaskReference[]
const _AGENT_PICKER_TAB_ORDER = ['agents', 'skills', 'artifacts', 'assets'];
const _AGENT_PICKER_TABS = new Set(_AGENT_PICKER_TAB_ORDER);

function _normalizeAgentPickerTab(tab) {
  return _AGENT_PICKER_TABS.has(tab) ? tab : 'agents';
}

/**
 * @ 选择器作用域：锚点所在会话是否绑空间。
 *   - chat-recipient-chip：当前会话（currentCid → conversations 缓存）space_id；
 *   - new-chat-recipient-chip：工作空间 chip 选中的空间（getNewChatSpaceId）；
 *   - auto-recipient-chip / 其余：无空间。
 */
function _agentPickerSpaceId(anchorId) {
  if (anchorId === 'chat-recipient-chip') {
    const cid = (typeof currentCid === 'string') ? currentCid : '';
    if (cid && typeof conversations !== 'undefined' && Array.isArray(conversations)) {
      const conv = conversations.find((c) => c && c.conversation_id === cid);
      return (conv && conv.space_id) || '';
    }
    return '';
  }
  if (anchorId === 'new-chat-recipient-chip' && typeof window.getNewChatSpaceId === 'function') {
    return window.getNewChatSpaceId() || '';
  }
  return '';
}

function _agentPickerVisibleTabs(anchorId) {
  // 空间会话（聊天绑空间 / new-chat 选中空间）→ 智能体/技能/产物/资产；
  // 无空间（主对话默认工作区 / Auto）→ 仅智能体/技能。
  // 连接器/资料库/本体 tab 已删（两处都不再出现）。
  const spaceId = _agentPickerSpaceId(anchorId);
  return spaceId ? _AGENT_PICKER_TAB_ORDER : ['agents', 'skills'];
}

function _agentPickerSearchPlaceholder() {
  if (_agentPickerTab === 'skills') return t('agent_picker.search_skills_placeholder');
  if (_agentPickerTab === 'artifacts') return t('agent_picker.search_artifacts_placeholder');
  if (_agentPickerTab === 'assets') return t('agent_picker.search_assets_placeholder');
  return t('agent_picker.search_placeholder');
}

/** composer 占位符随会话空间状态更新：空间会话提示「产物/资产」可选，非空间只说智能体/技能。
 *  同时同步富文本编辑器（contenteditable 镜像 data-placeholder，见 _initMentionMirror）与
 *  attribute（i18n 重应用/镜像 sync 读的是 getAttribute）。 */
function updateAgentPickerPlaceholders() {
  const spacePh = t('agent_picker.input_placeholder_space', '输入 @ 选择智能体、技能、产物、资产');
  const plainPh = t('chat.input_placeholder', '输入 @ 选择智能体、技能');
  const apply = (input, ph) => {
    if (!input) return;
    input.placeholder = ph;
    input.setAttribute('placeholder', ph);
    try {
      if (typeof getChatRichComposerEditor === 'function') {
        const ed = getChatRichComposerEditor(input.id);
        if (ed) ed.dataset.placeholder = ph;
      }
    } catch (_) {}
  };
  apply(document.getElementById('chat-input'), _agentPickerSpaceId('chat-recipient-chip') ? spacePh : plainPh);
  apply(document.getElementById('new-chat-input'), _agentPickerSpaceId('new-chat-recipient-chip') ? spacePh : plainPh);
}

function _updateAgentPickerChrome() {
  const picker = document.getElementById('agent-picker');
  if (!picker) return;
  const visibleTabs = new Set(_agentPickerVisibleTabs(picker.dataset.anchorId || ''));
  picker.querySelectorAll('[data-agent-picker-tab]').forEach((btn) => {
    const tab = btn.dataset.agentPickerTab || 'agents';
    const visible = visibleTabs.has(tab);
    btn.style.display = visible ? '' : 'none';
    const active = visible && tab === _agentPickerTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const tabsEl = picker.querySelector('.skill-picker-tabs');
  if (tabsEl) tabsEl.style.gridTemplateColumns = `repeat(${Math.max(1, visibleTabs.size)}, minmax(0, 1fr))`;
  const search = document.getElementById('agent-picker-search');
  if (search) search.placeholder = _agentPickerSearchPlaceholder();
}

function _setAgentPickerTab(tab, opts = {}) {
  const picker = document.getElementById('agent-picker');
  const visibleTabs = _agentPickerVisibleTabs(picker?.dataset.anchorId || '');
  const normalized = _normalizeAgentPickerTab(tab);
  _agentPickerTab = visibleTabs.includes(normalized) ? normalized : 'agents';
  const search = document.getElementById('agent-picker-search');
  if (search && !opts.keepSearch) search.value = '';
  _updateAgentPickerChrome();
  _renderAgentPickerList(search ? search.value : '');
  _ensureAgentPickerTabData(_agentPickerTab, _agentPickerOpenSeq);
  if (opts.focusSearch !== false) setTimeout(() => search?.focus(), 0);
}

function _ensureAgentPickerTabData(tab, openSeq) {
  const normalized = _normalizeAgentPickerTab(tab);
  // artifacts/assets own their own lazy-load + cache inside their render
  // functions (_renderArtifactsPickerList / _renderAssetsPickerList) — same
  // pattern as the removed library/ontology tabs, skip generic bookkeeping.
  if (normalized === 'artifacts' || normalized === 'assets' || _agentPickerLoadedTabs.has(normalized)) {
    return Promise.resolve();
  }
  const existing = _agentPickerTabLoads.get(normalized);
  if (existing) {
    const joined = existing.then(() => {
      if (openSeq !== _agentPickerOpenSeq) return;
      _agentPickerLoadedTabs.add(normalized);
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== normalized) return;
      const search = document.getElementById('agent-picker-search');
      _renderAgentPickerList(search ? search.value : '');
    });
    joined.catch(() => {});
    return joined;
  }
  const run = (async () => {
    if (normalized === 'skills') {
      const loader = typeof loadRendererFeature === 'function'
        ? loadRendererFeature
        : window.loadRendererFeature;
      if (typeof loadSkills !== 'function' && typeof loader === 'function') {
        await loader('skills');
      }
      if (typeof loadSkills === 'function') await loadSkills(false);
    } else {
      // A summary catalog is enough for the first frame. `loadAgents(false)`
      // upgrades it once and then reuses the validated full cache.
      await loadAgents(false);
    }
    if (openSeq === _agentPickerOpenSeq) _agentPickerLoadedTabs.add(normalized);
  })().catch((err) => {
    _agentsLog.warn('picker tab load failed', {
      tab: normalized,
      error: err?.message || String(err),
    });
    throw err;
  }).finally(() => {
    if (_agentPickerTabLoads.get(normalized) === run) _agentPickerTabLoads.delete(normalized);
    const picker = document.getElementById('agent-picker');
    if (openSeq !== _agentPickerOpenSeq || !picker || picker.style.display === 'none') return;
    if (_agentPickerTab !== normalized) return;
    const search = document.getElementById('agent-picker-search');
    _renderAgentPickerList(search ? search.value : '');
  });
  _agentPickerTabLoads.set(normalized, run);
  // Tab clicks are UI events; contain failures here so they never create an
  // unhandled rejection. Re-selecting the tab retries because the map clears.
  run.catch(() => {});
  return run;
}

function _moveAgentPickerTab(delta) {
  const picker = document.getElementById('agent-picker');
  const tabs = _agentPickerVisibleTabs(picker?.dataset.anchorId || '');
  const cur = tabs.indexOf(_agentPickerTab);
  const idx = cur >= 0 ? cur : 0;
  const next = (idx + delta + tabs.length) % tabs.length;
  _setAgentPickerTab(tabs[next]);
}

async function _refreshAgentPickerProjectContext(anchorId) {
  // 空间化重构：picker 作用域 = 当前会话所属空间的「能力配置」。
  //   - 会话绑空间（conv.space_id 非空）→ 折叠到该空间 agents ∪ skills
  //     （模板 bundle ∪ extra，与 runner 执行作用域同源 spaces.scope.resolve）；
  //   - 未绑空间 / 空间空配置（S1：resolve 返回 null）→ 全局不过滤。
  // 旧项目作用域已删（不再按 project 过滤）。
  // 主对话：当前会话 → 空间；新聊天：chip 选中的空间（创建后对话归该空间，@ 同步过滤）
  // （同步判定，无空间直接走全局路径，不闪 loading）
  const spaceId = _agentPickerSpaceId(anchorId);
  if (!spaceId) {
    _pickerBoundAgentIds = null;
    _pickerBoundSkillIds = null;
    _pickerScopeSpace = null;
    _pickerProjectId = '';
    _pickerProjectContextLoading = false;
    _pickerLibraryRows = null;
    _pickerLibraryLoading = null;
    _pickerLibraryRenderSeq += 1;
    _pickerOntologyEntries = null;
    _pickerOntologyLoading = null;
    _pickerOntologyRenderSeq += 1;
    _pickerArtifactRows = null;
    _pickerArtifactTitles = new Map();
    _pickerArtifactLoading = null;
    _pickerAssetRows = null;
    _pickerAssetLoading = null;
    return;
  }
  // 有空间 → 异步解析作用域（loading 壳防旧列表可点）
  _pickerProjectContextLoading = true;
  let boundAgentIds = null;
  let boundSkillIds = null;
  let scopeSpace = null;
  try {
    const res = await window.cogseed.invoke('spaces.scope.resolve', { spaceId });
    const scope = res && res.scope;
    if (scope && Array.isArray(scope.agents) && Array.isArray(scope.skills)) {
      boundAgentIds = new Set(scope.agents);
      boundSkillIds = new Set(scope.skills);
      scopeSpace = { space_id: spaceId };
    }
    // scope === null（空间缺失/空配置/全失效）→ 保持 null = 全局可见
  } catch (err) {
    _agentsLog.warn('resolve space scope for picker failed', err);
  } finally {
    _pickerProjectContextLoading = false;
  }
  _pickerBoundAgentIds = boundAgentIds;
  _pickerBoundSkillIds = boundSkillIds;
  _pickerScopeSpace = scopeSpace;
  _pickerProjectId = '';
  _pickerLibraryRows = null;
  _pickerLibraryLoading = null;
  _pickerLibraryRenderSeq += 1;
  _pickerOntologyEntries = null;
  _pickerOntologyLoading = null;
  _pickerOntologyRenderSeq += 1;
  _pickerArtifactRows = null;
  _pickerArtifactTitles = new Map();
  _pickerArtifactLoading = null;
  _pickerAssetRows = null;
  _pickerAssetLoading = null;
}

async function refreshAgentPickerContext(anchorId) {
  const picker = document.getElementById('agent-picker');
  if (!picker || picker.style.display === 'none') return;
  if (anchorId && picker.dataset.anchorId !== anchorId) return;
  const activeAnchorId = picker.dataset.anchorId || anchorId || '';
  await _refreshAgentPickerProjectContext(activeAnchorId);
  const search = document.getElementById('agent-picker-search');
  _renderAgentPickerList(search ? search.value : '');
}

async function _openAgentPicker(anchorBtn) {
  const picker = document.getElementById('agent-picker');
  if (!anchorBtn || !picker) return;
  picker.dataset.anchorId = anchorBtn.id;
  const openSeq = ++_agentPickerOpenSeq;
  _agentPickerLoadedTabs = new Set();
  // 产物/资产目录按 picker 会话重置（防上次会话残留旧空间行可点）
  _pickerArtifactRows = null;
  _pickerArtifactTitles = new Map();
  _pickerArtifactLoading = null;
  _pickerAssetRows = null;
  _pickerAssetLoading = null;
  // Reset project scope synchronously before painting. For project-bound
  // composers this flips the list to a loading shell immediately, so stale
  // unrestricted rows from the previous picker session are never clickable
  // while the fresh binding request is in flight.
  const projectContextPromise = _refreshAgentPickerProjectContext(anchorBtn.id);
  // Paint the cached Agent shell in the same interaction frame. Other tabs
  // own their script/data loads and cannot delay this first frame.
  _setAgentPickerTab('agents', { focusSearch: false });
  // Recipient pickers anchor to the @ button itself (紧贴按钮上方弹出)。
  _positionPopoverAboveOrBelow(picker, anchorBtn, {
    anchorToButton: anchorBtn.id === 'chat-recipient-chip'
      || anchorBtn.id === 'new-chat-recipient-chip'
      || anchorBtn.id === 'auto-recipient-chip',
  });
  setTimeout(() => document.getElementById('agent-picker-search')?.focus(), 30);
  // Project bindings affect Agent visibility, so refresh them independently
  // and repaint only if this picker session is still current.
  projectContextPromise.then(() => {
    if (openSeq !== _agentPickerOpenSeq || picker.style.display === 'none') return;
    if (_agentPickerTab !== 'agents') return;
    const search = document.getElementById('agent-picker-search');
    _renderAgentPickerList(search ? search.value : '');
  }).catch(() => {});
}

function _closeAgentPicker() {
  const picker = document.getElementById('agent-picker');
  if (picker) picker.style.display = 'none';
  // NOTE: callers that close-without-selection (Esc / click-outside) must
  // also clear `_atKeyMark` — otherwise the next picker open would consume
  // a stale `@`. Selection callers leave the mark so _triggerPickerItem can
  // use it before clearing.
}

function _renderAgentPickerList(filterText) {
  const listEl = document.getElementById('agent-picker-list');
  const picker = document.getElementById('agent-picker');
  if (!listEl) return;
  const anchorId = picker?.dataset.anchorId || '';
  if (!_agentPickerVisibleTabs(anchorId).includes(_agentPickerTab)) {
    _agentPickerTab = 'agents';
  }
  _updateAgentPickerChrome();
  if (_agentPickerTab === 'skills') {
    if (typeof loadSkills !== 'function') {
      listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
      return;
    }
    _renderSkillPickerList(listEl, filterText, anchorId);
    return;
  }
  if (_agentPickerTab === 'artifacts') {
    _renderArtifactsPickerList(listEl, filterText, anchorId);
    return;
  }
  if (_agentPickerTab === 'assets') {
    _renderAssetsPickerList(listEl, filterText, anchorId);
    return;
  }
  // Disabled agents are filtered out — picker is a "what can I dispatch right
  // now" UI, and re-enabling lives in the management page (Agents view + ⋯ menu).
  if (_pickerProjectContextLoading) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    return;
  }
  const executableCliRuntimes = new Set(['claude', 'codex', 'openclaw', 'opencode', 'hermes', 'workbuddy']);
  let agents = (_agentsCache || []).filter((a) => {
    if (a.enabled === false || a.interaction_mode === 'management_only') return false;
    const runtime = a.runtime;
    return !runtime || runtime.kind === 'in_process' || executableCliRuntimes.has(runtime.cli);
  });
  // Project scope: only show agents bound to the active context's project.
  // Applied AFTER the enabled filter (per CLAUDE.md §6 outer-intersection
  // rule). `null` = no project scope, full listing.
  if (_pickerBoundAgentIds) {
    agents = agents.filter((a) => _pickerBoundAgentIds.has(a.agent_id));
  }
  const q = (filterText || '').toLowerCase();
  // Search matches across the active locale description; cross-language
  // fallback via pickDesc lets users find a single-locale agent regardless
  // of which side they typed in.
  // Match-quality ranking: name-exact (0) < name-prefix (1) < name-substring (2)
  // < description-only (3). Stable sort within ties preserves the source-group
  // order computed below. Without this, an agent whose description happens to
  // mention the query (e.g. "Agent Skill 搜集" mentioning "Claude Code subagents"
  // in passing) outranks the actual `Claude Code` agent because the original
  // list is sorted by hex agent_id, not by relevance.
  const lang = getLang();
  const matchScore = (a) => {
    const name = (a.name || '').toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  const filtered = q
    ? agents
        .filter(a => (a.name || '').toLowerCase().includes(q) || pickDesc(a, lang).toLowerCase().includes(q))
        .sort((a, b) => matchScore(a) - matchScore(b))
    : agents;
  // Recipient chip exposes "commander" as a virtual top entry so the user can
  // switch back without an empty-state. Other anchors keep agent-only listing.
  const isRecipientPicker = anchorId === 'chat-recipient-chip'
    || anchorId === 'new-chat-recipient-chip'
    || anchorId === 'auto-recipient-chip';
  const commanderName = t('chat.recipient_commander');
  const commanderMatchesFilter = !q || commanderName.toLowerCase().includes(q);
  if (!filtered.length && !(isRecipientPicker && commanderMatchesFilter)) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('agents.no_match'))}</div>`;
    return;
  }
  const groups = { custom: [], marketplace: [] };
  for (const a of filtered) (groups[_agentSource(a.source)] || groups.custom).push(a);
  const groupHtml = (label, list) => {
    if (!list.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` +
      list.map(a => {
        const aDesc = pickDesc(a, lang).trim();
        return `
        <div class="skill-picker-item" data-kind="agent" data-id="${escapeHtml(a.agent_id)}" data-name="${escapeHtml(a.name || a.agent_id)}">
          <div class="skill-picker-item-name">${escapeHtml(a.name || t('agents.unnamed'))}</div>
          ${aDesc ? `<div class="skill-picker-item-desc">${escapeHtml(aDesc)}</div>` : ''}
        </div>`;
      }).join('');
  };
  const commanderHtml = (isRecipientPicker && commanderMatchesFilter)
    ? `<div class="skill-picker-item" data-kind="agent" data-id="__commander__" data-name="${escapeHtml(commanderName)}">
         <div class="skill-picker-item-name">${escapeHtml(commanderName)}</div>
         <div class="skill-picker-item-desc">${escapeHtml(t('chat.recipient_commander_hint'))}</div>
       </div>`
    : '';
  // When the active context is a project AND the project has zero agents
  // bound, surface a hint above the commander entry so the user knows
  // "this isn't broken — go bind an agent first". Suppressed on user search
  // (they're explicitly typing) so the search "no match" message owns the
  // empty rendering.
  const projectEmptyHint = (!q && _pickerBoundAgentIds && _pickerBoundAgentIds.size === 0)
    ? `<div class="skill-picker-empty-hint">${escapeHtml(t('agents.no_project_agents'))}</div>`
    : '';
  // 接收者选择器只管「谁执行」（Commander + Agent）；模型的选择与展示统一由
  // composer 右下角的执行配置 chip 负责（选中 CLI 智能体时该 chip 即管理其
  // runtime.model）。模型不进这个列表——验收反馈：左侧出现模型属于概念混淆。
  listEl.innerHTML = projectEmptyHint + commanderHtml
    + groupHtml(t('agents.source_custom'), groups.custom)
    + groupHtml(t('agents.source_marketplace'), groups.marketplace);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _matchPickerItem(q, name, desc, extra = '') {
  if (!q) return true;
  return String(name || '').toLowerCase().includes(q)
    || String(desc || '').toLowerCase().includes(q)
    || String(extra || '').toLowerCase().includes(q);
}

function _pickerMatchScore(q, name) {
  const n = String(name || '').toLowerCase();
  if (!q) return 0;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

function _renderSkillPickerList(listEl, filterText, anchorId) {
  const lang = getLang();
  const q = (filterText || '').toLowerCase();
  const trustedDesc = (s) => pickDesc(s, lang);
  const openDesc = (s) => s.description || '';
  const applyFilter = (list, descOf) => q
    ? list
        .filter((s) => _matchPickerItem(q, s.name || s.id, descOf(s), s.id))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.id) - _pickerMatchScore(q, b.name || b.id))
    : list;

  const trusted = applyFilter((_skillsCache || [])
    .filter((s) => s.enabled !== false)
    // 情境空间一期：项目/空间作用域下只显示作用域内技能（null = 全局不过滤）
    .filter((s) => !_pickerBoundSkillIds || _pickerBoundSkillIds.has(s.id)), trustedDesc);
  // Global open-tier skills share the same picker surface as trusted skills.
  // External package internals stay package-scoped in user UI; the agent layer
  // can still see package-provided SKILL.md files when composing a task.
  // 情境空间一期：global 技能同样受作用域过滤（否则空间外技能漏网显示）。
  const openRows = (typeof _openSkillsCache !== 'undefined' && Array.isArray(_openSkillsCache))
    ? applyFilter(_openSkillsCache.filter((s) => s.source === 'global' && s.enabled !== false
      && (!_pickerBoundSkillIds || _pickerBoundSkillIds.has(s.id))), openDesc)
    : [];

  if (!trusted.length && !openRows.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('skills.no_match'))}</div>`;
    return;
  }

  const groups = { custom: [], marketplace: [] };
  for (const s of trusted) {
    const source = (typeof normalizeCatalogSource === 'function') ? normalizeCatalogSource(s.source) : s.source;
    (groups[source] || groups.custom).push(s);
  }
  const globalRows = openRows.filter((s) => s.source === 'global');

  const groupHtml = (label, list, descOf) => {
    if (!list.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` +
      list.map((s) => {
        const desc = (descOf(s) || '').trim();
        const name = s.name || s.id;
        return `
        <div class="skill-picker-item" data-kind="skill" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(name)}">
          <div class="skill-picker-item-name">${escapeHtml(name)}</div>
          ${desc ? `<div class="skill-picker-item-desc">${escapeHtml(desc)}</div>` : ''}
        </div>`;
      }).join('');
  };
  listEl.innerHTML = groupHtml(t('skills.source_custom'), groups.custom, trustedDesc)
    + groupHtml(t('skills.source_marketplace'), groups.marketplace, trustedDesc)
    + groupHtml(t('skills.global_group'), globalRows, openDesc);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _renderConnectorPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const items = (typeof listUsableConnectorsForPicker === 'function')
    ? listUsableConnectorsForPicker()
    : [];
  const filtered = q
    ? items
        .filter((c) => _matchPickerItem(q, c.name || c.id, c.description, `${c.id} ${c.account || ''}`))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.id) - _pickerMatchScore(q, b.name || b.id))
    : items;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(q ? t('connectors.no_match') : t('connectors.no_connected'))}</div>`;
    return;
  }
  listEl.innerHTML = `<div class="skill-picker-group-label">${escapeHtml(t('connectors.group.connected'))}</div>` +
    filtered.map((c) => {
      const descParts = [];
      if (c.description) descParts.push(c.description);
      if (c.account) descParts.push(t('connectors.account_label', { account: c.account }));
      return `
      <div class="skill-picker-item" data-kind="connector" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name || c.id)}">
        <div class="skill-picker-item-name">${escapeHtml(c.name || c.id)}</div>
        ${descParts.length ? `<div class="skill-picker-item-desc">${escapeHtml(descParts.join(' · '))}</div>` : ''}
      </div>`;
    }).join('');
  _bindAgentPickerListItems(listEl, anchorId);
}

function _agentPickerBasename(rel) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _agentPickerFormatMtime(mtime) {
  const n = Number(mtime);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 100000000000 ? n : n * 1000;
  try {
    const locale = (typeof getLocaleMeta === 'function' && typeof getLang === 'function')
      ? getLocaleMeta(getLang()).intlLocale
      : undefined;
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleString();
  }
}

function _flattenLibraryPickerTree(nodes, scope, projectId) {
  const rows = [];
  const walk = (items) => {
    for (const node of items || []) {
      if (!node) continue;
      if (node.type === 'dir') {
        walk(node.children || []);
        continue;
      }
      if (node.type !== 'file') continue;
      const rel = String(node.relPath || node.path || node.name || '');
      if (!rel) continue;
      const name = node.name || _agentPickerBasename(rel);
      rows.push({
        scope,
        projectId: projectId || '',
        rel,
        name,
        group: scope === 'project' ? 'project' : 'global',
        kind: node.kind || '',
        bytes: Number(node.bytes || 0),
        mtime: node.mtime,
      });
    }
  };
  walk(nodes || []);
  return rows;
}

async function _loadLibraryPickerRows() {
  // 空间化后仅全局上下文库（contexts）可选；项目文件树已删。
  const globalPromise = apiFetch('/api/contexts/tree')
    .then((res) => res.json())
    .catch((err) => {
      _agentsLog.warn('global library picker load failed', err);
      return null;
    });
  const globalData = await globalPromise;
  const rows = [];
  if (globalData && globalData.ok !== false) {
    rows.push(..._flattenLibraryPickerTree(globalData.tree || [], 'global', ''));
  }
  return rows;
}

function _libraryPickerRowHtml(row) {
  const rel = row.rel || row.name || '';
  const label = row.name || _agentPickerBasename(rel);
  const time = _agentPickerFormatMtime(row.mtime);
  const desc = rel && rel !== label ? rel : '';
  const id = `${row.scope}:${row.projectId || ''}:${rel}`;
  return `
    <div class="skill-picker-item" data-kind="library" data-id="${escapeHtml(id)}"
         data-name="${escapeHtml(label)}" data-library-scope="${escapeHtml(row.scope)}"
         data-library-rel="${escapeHtml(rel)}" data-project-id="${escapeHtml(row.projectId || '')}">
      <div class="skill-picker-item-meta">
        <div class="skill-picker-item-name">${escapeHtml(label)}</div>
        ${time ? `<span class="skill-picker-item-time">${escapeHtml(time)}</span>` : ''}
      </div>
      ${desc ? `<div class="skill-picker-item-desc">${escapeHtml(desc)}</div>` : ''}
    </div>`;
}

function _renderLibraryPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerLibraryRenderSeq;
  if (!_pickerLibraryRows) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    if (!_pickerLibraryLoading) {
      _pickerLibraryLoading = _loadLibraryPickerRows()
        .then((rows) => {
          _pickerLibraryRows = rows || [];
          _pickerLibraryLoading = null;
        })
        .catch((err) => {
          _agentsLog.warn('library picker load failed', err);
          _pickerLibraryRows = [];
          _pickerLibraryLoading = null;
        });
    }
    _pickerLibraryLoading.then(() => {
      if (renderSeq !== _pickerLibraryRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'library') return;
      const search = document.getElementById('agent-picker-search');
      _renderLibraryPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }

  const allRows = _pickerLibraryRows || [];
  const filtered = q
    ? allRows
        .filter((row) => _matchPickerItem(q, row.name, row.rel, row.kind))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.rel) - _pickerMatchScore(q, b.name || b.rel))
    : allRows;

  if (!filtered.length) {
    const key = allRows.length ? 'agent_picker.library_no_match' : 'agent_picker.library_empty';
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t(key))}</div>`;
    return;
  }

  const projectRows = filtered.filter((row) => row.scope === 'project');
  const globalRows = filtered.filter((row) => row.scope === 'global');
  const groupHtml = (label, rows) => {
    if (!rows.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` + rows.map(_libraryPickerRowHtml).join('');
  };
  listEl.innerHTML = groupHtml(t('agent_picker.library_group_project'), projectRows)
    + groupHtml(t('agent_picker.library_group_global'), globalRows);
  _bindAgentPickerListItems(listEl, anchorId);
}

async function _loadOntologyPickerEntries() {
  try {
    const res = await window.cogseed.invoke('personalOntology.entries.list', {});
    return (res && res.ok !== false && Array.isArray(res.entries)) ? res.entries : [];
  } catch (err) {
    _agentsLog.warn('ontology entry picker load failed', err);
    return [];
  }
}

function _ontologyPickerRowHtml(entry, checked) {
  return `
    <div class="skill-picker-item is-checkable${checked ? ' is-checked' : ''}${entry.parentId ? ' is-template-child' : ''}" data-kind="ontology_group"
         data-id="${escapeHtml(entry.ref)}" data-name="${escapeHtml(entry.label || '')}">
      <span class="skill-picker-item-checkbox" aria-hidden="true"></span>
      <div class="skill-picker-item-meta">
        <div class="skill-picker-item-name">${escapeHtml(entry.label || '')}</div>
      </div>
    </div>`;
}

// 本体 tab 层级渲染：无 parentId 的条目平铺；有 parentId 的收纳在分组标题行
// （可折叠）下。data-id 一律是 PO contract 给的 opaque ref —— 渲染层不解析、
// 不拼接，chat-use 原样透传，发送时主进程按 ref 读回内容。
// 标题行不带 data-id —— 不参与键盘导航（_setAgentPickerActive 只遍历 [data-id]）
// 也不参与点击选中（_bindAgentPickerListItems 只绑 [data-id]），多选逻辑零改动。
function _ontologyPickerSectionsHtml(entries, selectedIds) {
  const rows = [];
  const grouped = new Map(); // parentId → { label, items[] }
  for (const e of entries) {
    if (!e || !e.ref) continue;
    if (!e.parentId) {
      rows.push(_ontologyPickerRowHtml(e, selectedIds.has(e.ref)));
      continue;
    }
    let bucket = grouped.get(e.parentId);
    if (!bucket) {
      bucket = { label: e.parentLabel || e.parentId, items: [] };
      grouped.set(e.parentId, bucket);
    }
    bucket.items.push(e);
  }
  for (const [parentId, bucket] of grouped) {
    const collapsed = _pickerOntologyCollapsed.has(parentId);
    rows.push(`<button type="button" class="skill-picker-template-header" data-ontology-template-toggle="${escapeHtml(parentId)}">
      <span class="skill-picker-template-caret">${collapsed ? '▶' : '▼'}</span>${escapeHtml(bucket.label)}</button>`);
    if (!collapsed) {
      rows.push(`<div class="skill-picker-template-groups">${
        bucket.items.map((e) => _ontologyPickerRowHtml(e, selectedIds.has(e.ref))).join('')
      }</div>`);
    }
  }
  return rows.join('');
}

function _bindAgentPickerTemplateToggles(listEl) {
  for (const btn of listEl.querySelectorAll('[data-ontology-template-toggle]')) {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.ontologyTemplateToggle;
      if (!pid) return;
      if (_pickerOntologyCollapsed.has(pid)) _pickerOntologyCollapsed.delete(pid);
      else _pickerOntologyCollapsed.add(pid);
      const picker = document.getElementById('agent-picker');
      const search = document.getElementById('agent-picker-search');
      _renderOntologyPickerList(listEl, search ? search.value : '', picker ? picker.dataset.anchorId || '' : '');
    });
  }
}

function _renderOntologyPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerOntologyRenderSeq;
  if (!_pickerOntologyEntries) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    if (!_pickerOntologyLoading) {
      _pickerOntologyLoading = _loadOntologyPickerEntries()
        .then((entries) => {
          _pickerOntologyEntries = entries || [];
          _pickerOntologyLoading = null;
        })
        .catch(() => {
          _pickerOntologyEntries = [];
          _pickerOntologyLoading = null;
        });
    }
    _pickerOntologyLoading.then(() => {
      if (renderSeq !== _pickerOntologyRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'ontology') return;
      const search = document.getElementById('agent-picker-search');
      _renderOntologyPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }

  const allEntries = _pickerOntologyEntries || [];
  // 搜索匹配条目标签或分组标签：分组名命中时保留该分组全部条目（与收归前
  // 「模板名命中保留该模板全部预置组」的行为一致），单一过滤路径。
  const filtered = q
    ? (() => {
        const hitParents = new Set(
          allEntries.filter((e) => e.parentLabel && _matchPickerItem(q, e.parentLabel, '', ''))
            .map((e) => e.parentId),
        );
        return allEntries
          .filter((e) => _matchPickerItem(q, e.label, '', '') || (e.parentId && hitParents.has(e.parentId)))
          .sort((a, b) => _pickerMatchScore(q, a.label) - _pickerMatchScore(q, b.label));
      })()
    : allEntries;

  if (!filtered.length) {
    const key = allEntries.length ? 'agent_picker.ontology_no_match' : 'agent_picker.ontology_empty';
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t(key))}</div>`;
    return;
  }

  const target = _targetFromPickerAnchor(anchorId);
  const selectedIds = new Set(
    (typeof getChatUseOntologyGroups === 'function' ? getChatUseOntologyGroups(target) : [])
      .map((sel) => sel.id),
  );
  listEl.innerHTML = _ontologyPickerSectionsHtml(filtered, selectedIds);
  _bindAgentPickerTemplateToggles(listEl);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _bindAgentPickerListItems(listEl, anchorId) {
  for (const el of listEl.querySelectorAll('[data-id]')) {
    el.addEventListener('click', async () => {
      // "本体" rows are checkboxes, not click-to-trigger-and-close — this is
      // the one behavioral difference from the other four tabs (§3.7). Toggle
      // the checked state and keep the picker open so the user can multi-select.
      if (el.dataset.kind === 'ontology_group') {
        await _triggerPickerItem('ontology_group', el.dataset.id, el.dataset.name, anchorId, el.dataset);
        return;
      }
      _closeAgentPicker();
      await _triggerPickerItem(el.dataset.kind || 'agent', el.dataset.id, el.dataset.name, anchorId, el.dataset);
    });
    el.addEventListener('mouseenter', () => {
      const all = listEl.querySelectorAll('.skill-picker-item[data-id]');
      const idx = Array.prototype.indexOf.call(all, el);
      if (idx >= 0) _setAgentPickerActive(idx);
    });
  }
  _setAgentPickerActive(0);
}

// ── Agent picker keyboard navigation ─────────────────────────────────────

function _setAgentPickerActive(idx) {
  const listEl = document.getElementById('agent-picker-list');
  if (!listEl) return;
  const items = listEl.querySelectorAll('.skill-picker-item[data-id]');
  if (!items.length) return;
  const clamped = Math.max(0, Math.min(items.length - 1, idx));
  items.forEach((el, i) => el.classList.toggle('active', i === clamped));
  items[clamped].scrollIntoView({ block: 'nearest' });
}

function _moveAgentPickerActive(delta) {
  const listEl = document.getElementById('agent-picker-list');
  if (!listEl) return;
  const items = listEl.querySelectorAll('.skill-picker-item[data-id]');
  if (!items.length) return;
  let cur = -1;
  items.forEach((el, i) => { if (el.classList.contains('active')) cur = i; });
  const next = cur < 0 ? 0 : (cur + delta + items.length) % items.length;
  _setAgentPickerActive(next);
}

function _targetFromPickerAnchor(anchorId) {
  if (anchorId === 'new-chat-recipient-chip') return 'new-chat';
  if (anchorId === 'auto-recipient-chip') return 'auto';
  return 'conversation';
}

// ── 产物 / 资产 tab（空间会话 @ 引用：复用任务引用 task_references）─────────────

function _sameTaskRefKey(r) {
  return r && r.kind === 'asset'
    ? `asset:${r.asset_id || ''}`
    : `artifact:${r.source_cid || ''}:${r.file_name || ''}`;
}

async function _loadArtifactPickerRows(spaceId) {
  const [artRes, convRes] = await Promise.all([
    window.cogseed.invoke('spaces.artifacts.list', { spaceId }).catch(() => ({})),
    window.cogseed.invoke('spaces.conversations.list', { spaceId }).catch(() => ({})),
  ]);
  const titles = new Map();
  for (const c of (convRes && convRes.conversations) || []) {
    if (c && c.conversation_id) titles.set(c.conversation_id, c.title || '');
  }
  _pickerArtifactTitles = titles;
  return Array.isArray(artRes && artRes.artifacts) ? artRes.artifacts : [];
}

async function _loadAssetPickerRows(spaceId) {
  // @ 资产 = 本空间沉淀资产（recall.assets.listForSpace，与空间资产 tab 同源；
  // 不再用全局 recall.assets.list——用户明确要求空间资产）。
  if (!spaceId) return [];
  try {
    const res = await window.cogseed.invoke('recall.assets.listForSpace', { spaceId });
    return Array.isArray(res && res.assets)
      ? res.assets.map((a) => ({ asset_id: a.id, title: a.title, asset_type: a.type }))
      : [];
  } catch (err) {
    _agentsLog.warn('asset picker load failed', err);
    return [];
  }
}

function _renderArtifactsPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerArtifactRenderSeq;
  const spaceId = _agentPickerSpaceId(anchorId);
  if (!spaceId) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('agent_picker.artifacts_empty'))}</div>`;
    return;
  }
  if (!_pickerArtifactRows) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    const openSeq = _agentPickerOpenSeq;
    if (!_pickerArtifactLoading) {
      _pickerArtifactLoading = _loadArtifactPickerRows(spaceId)
        .then((rows) => {
          // 会话守卫：picker 已关闭/重开则丢弃过期结果
          if (openSeq !== _agentPickerOpenSeq) return;
          _pickerArtifactRows = rows || [];
          _pickerArtifactLoading = null;
        })
        .catch((err) => {
          if (openSeq !== _agentPickerOpenSeq) return;
          _agentsLog.warn('artifact picker load failed', err);
          _pickerArtifactRows = [];
          _pickerArtifactLoading = null;
        });
    }
    _pickerArtifactLoading.then(() => {
      if (openSeq !== _agentPickerOpenSeq) return;
      if (renderSeq !== _pickerArtifactRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'artifacts') return;
      const search = document.getElementById('agent-picker-search');
      _renderArtifactsPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }
  const rows = _pickerArtifactRows || [];
  const filtered = q ? rows.filter((a) => _matchPickerItem(q, a.name, a.sourceSessionId || '', a.ext || '')) : rows;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(q ? t('agent_picker.artifacts_no_match') : t('agent_picker.artifacts_empty'))}</div>`;
    return;
  }
  listEl.innerHTML = `<div class="skill-picker-group-label">${escapeHtml(t('agent_picker.artifacts_group'))}</div>` +
    filtered.map((a) => {
      const sub = `${a.type === 'artifact' ? escapeHtml(t('agent_picker.artifact_confirmed')) : escapeHtml(t('agent_picker.artifact_attachment'))}${a.ext ? ` · ${escapeHtml(a.ext)}` : ''}`;
      return `
      <div class="skill-picker-item" data-kind="artifact"
           data-id="${escapeHtml(a.name)}" data-name="${escapeHtml(a.name)}"
           data-source-cid="${escapeHtml(a.sourceSessionId || '')}"
           data-source-title="${escapeHtml(_pickerArtifactTitles.get(a.sourceSessionId) || '')}"
           data-file-name="${escapeHtml(a.name)}">
        <div class="skill-picker-item-name">${escapeHtml(a.name)}</div>
        <div class="skill-picker-item-desc">${sub}</div>
      </div>`;
    }).join('');
  _bindAgentPickerListItems(listEl, anchorId);
}

function _renderAssetsPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const renderSeq = ++_pickerAssetRenderSeq;
  const spaceId = _agentPickerSpaceId(anchorId);
  if (!spaceId) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('agent_picker.assets_empty'))}</div>`;
    return;
  }
  if (!_pickerAssetRows) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('common.loading'))}</div>`;
    const openSeq = _agentPickerOpenSeq;
    if (!_pickerAssetLoading) {
      _pickerAssetLoading = _loadAssetPickerRows(spaceId)
        .then((rows) => {
          // 会话守卫：picker 已关闭/重开则丢弃过期结果
          if (openSeq !== _agentPickerOpenSeq) return;
          _pickerAssetRows = rows || [];
          _pickerAssetLoading = null;
        })
        .catch(() => {
          if (openSeq !== _agentPickerOpenSeq) return;
          _pickerAssetRows = [];
          _pickerAssetLoading = null;
        });
    }
    _pickerAssetLoading.then(() => {
      if (openSeq !== _agentPickerOpenSeq) return;
      if (renderSeq !== _pickerAssetRenderSeq) return;
      const picker = document.getElementById('agent-picker');
      if (!picker || picker.style.display === 'none' || _agentPickerTab !== 'assets') return;
      const search = document.getElementById('agent-picker-search');
      _renderAssetsPickerList(listEl, search ? search.value : filterText, anchorId);
    });
    return;
  }
  const rows = _pickerAssetRows || [];
  const filtered = q ? rows.filter((a) => _matchPickerItem(q, a.title || '', a.asset_id || '', a.asset_type || '')) : rows;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(q ? t('agent_picker.assets_no_match') : t('agent_picker.assets_empty'))}</div>`;
    return;
  }
  listEl.innerHTML = `<div class="skill-picker-group-label">${escapeHtml(t('agent_picker.assets_group'))}</div>` +
    filtered.map((a) => {
      const typeLabel = a.asset_type ? ` · ${escapeHtml(a.asset_type)}` : '';
      return `
      <div class="skill-picker-item" data-kind="asset"
           data-id="${escapeHtml(a.asset_id)}" data-name="${escapeHtml(a.title || a.asset_id)}"
           data-asset-id="${escapeHtml(a.asset_id)}" data-asset-type="${escapeHtml(a.asset_type || '')}">
        <div class="skill-picker-item-name">${escapeHtml(a.title || a.asset_id)}</div>
        <div class="skill-picker-item-desc">${escapeHtml(t('agent_picker.asset_type'))}${typeLabel}</div>
      </div>`;
    }).join('');
  _bindAgentPickerListItems(listEl, anchorId);
}

// ── 任务引用 chips（composer 引用条）───────────────────────────────────────

function _renderTaskRefChips(el, refs, cid) {
  if (!el) return;
  if (!refs || !refs.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = refs.map((r, i) => `
    <span class="chat-taskref-chip ${r.kind === 'asset' ? 'is-asset' : 'is-artifact'}">
      <em>${r.kind === 'asset' ? escapeHtml(t('agent_picker.ref_asset')) : escapeHtml(t('agent_picker.ref_artifact'))}</em>
      <span title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <button type="button" class="chat-taskref-remove" data-cid="${escapeHtml(cid || '')}" data-index="${i}"
        data-kind="${escapeHtml(r.kind || '')}" data-key="${escapeHtml(_sameTaskRefKey(r))}" aria-label="${escapeHtml(t('agent_picker.ref_remove'))}">×</button>
    </span>`).join('');
  el.querySelectorAll('.chat-taskref-remove').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const c = btn.dataset.cid;
      const idx = Number(btn.dataset.index);
      try {
        if (c) {
          await window.cogseed.invoke('conversations.taskRefs.remove', { cid: c, index: idx });
        } else {
          _pendingNewChatRefs = (_pendingNewChatRefs || []).filter((_, i) => i !== idx);
        }
      } catch (err) {
        _agentsLog.warn('task ref remove failed', err);
      }
      renderChatTaskRefChips();
    });
  });
}

/** 渲染两个 composer 的引用条：conversation = 当前会话 task_references；new-chat = pending。 */
function renderChatTaskRefChips() {
  const cid = (typeof currentCid === 'string') ? currentCid : '';
  const convEl = document.getElementById('chat-taskrefs');
  if (convEl) {
    if (!cid) { convEl.style.display = 'none'; convEl.innerHTML = ''; }
    else {
      (async () => {
        try {
          const res = await window.cogseed.invoke('conversations.taskRefs.list', { cid });
          const refs = Array.isArray(res && res.references) ? res.references : [];
          _renderTaskRefChips(convEl, refs, cid);
        } catch (_) { convEl.style.display = 'none'; }
      })();
    }
  }
  const ncEl = document.getElementById('new-chat-taskrefs');
  if (ncEl) _renderTaskRefChips(ncEl, _pendingNewChatRefs || [], '');
}

/** 发送后清空 composer 引用条（视觉反馈：引用已随消息发出；服务端 task_references 保留）。 */
function clearChatTaskRefChips() {
  const convEl = document.getElementById('chat-taskrefs');
  if (convEl) { convEl.style.display = 'none'; convEl.innerHTML = ''; }
  const ncEl = document.getElementById('new-chat-taskrefs');
  if (ncEl) { ncEl.style.display = 'none'; ncEl.innerHTML = ''; }
}

/** new-chat 提交：把 @ 选的 pending 引用写入新建会话的 task_references（发送前调用）。 */
async function commitNewChatTaskRefs(convId) {
  const refs = _pendingNewChatRefs || [];
  _pendingNewChatRefs = [];
  renderChatTaskRefChips();
  if (!convId || !refs.length) return;
  for (const r of refs.slice(0, 20)) {
    try {
      await window.cogseed.invoke('conversations.taskRefs.add', { cid: convId, reference: r });
    } catch (err) {
      _agentsLog.warn('taskRefs.add for new chat failed', err);
    }
  }
}

async function _commitTaskRef(reference, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  if (target === 'conversation') {
    const cid = (typeof currentCid === 'string') ? currentCid : '';
    if (!cid) return false;
    try {
      const res = await window.cogseed.invoke('conversations.taskRefs.add', { cid, reference });
      if (res && res.error) throw new Error(res.error);
    } catch (err) {
      _agentsLog.warn('taskRefs.add failed', err);
      if (typeof uiToast === 'function') uiToast(t('agent_picker.ref_add_failed', '添加引用失败'), { variant: 'warning' });
      return false;
    }
    renderChatTaskRefChips();
    return true;
  }
  if (target === 'new-chat') {
    const pending = _pendingNewChatRefs || [];
    const dup = pending.some((r) => _sameTaskRefKey(r) === _sameTaskRefKey(reference));
    if (!dup) {
      if (pending.length >= 20) {
        if (typeof uiToast === 'function') uiToast(t('agent_picker.ref_too_many', '引用数量已达上限'), { variant: 'warning' });
        return false;
      }
      pending.push(reference);
      _pendingNewChatRefs = pending;
    }
    renderChatTaskRefChips();
    return true;
  }
  return false;
}

async function _triggerArtifactRef(itemName, dataset, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  const name = dataset.fileName || dataset.name || itemName || '';
  if (!name) return;
  _agentsTrackClick(target === 'auto' ? 'auto_artifact_select' : 'chat_artifact_select', { target, name });
  _consumeAtKeyChar();
  const reference = {
    kind: 'artifact',
    name,
    ...(dataset.sourceCid ? { source_cid: dataset.sourceCid } : {}),
    ...(dataset.sourceTitle ? { source_title: dataset.sourceTitle } : {}),
    file_name: dataset.fileName || name,
  };
  const ok = await _commitTaskRef(reference, anchorId);
  const inputId = target === 'new-chat' ? 'new-chat-input' : 'chat-input';
  _focusInput(document.getElementById(inputId));
  if (ok && typeof uiToast === 'function') {
    uiToast(t('agent_picker.ref_added', '已添加引用'), { variant: 'success', timeoutMs: 1500 });
  }
}

async function _triggerAssetRef(itemName, dataset, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  const name = dataset.name || itemName || '';
  if (!name) return;
  _consumeAtKeyChar();
  const reference = {
    kind: 'asset',
    name,
    ...(dataset.assetId ? { asset_id: dataset.assetId } : {}),
    ...(dataset.assetType ? { asset_type: dataset.assetType } : {}),
  };
  const ok = await _commitTaskRef(reference, anchorId);
  const inputId = target === 'new-chat' ? 'new-chat-input' : 'chat-input';
  _focusInput(document.getElementById(inputId));
  if (ok && typeof uiToast === 'function') {
    uiToast(t('agent_picker.ref_added', '已添加引用'), { variant: 'success', timeoutMs: 1500 });
  }
}

async function _triggerPickerItem(kind, itemId, itemName, anchorId, dataset) {
  const target = _targetFromPickerAnchor(anchorId);
  if (kind === 'skill') {
    const skillId = String(itemId || itemName || '');
    _agentsTrackClick(target === 'auto' ? 'auto_skill_select' : 'chat_skill_select', {
      target,
      skill_id: skillId,
    });
    _consumeAtKeyChar();
    setChatSkill(target, itemId, itemName || itemId);
    const inputId = target === 'new-chat'
      ? 'new-chat-input'
      : (target === 'auto' ? 'auto-task-input' : 'chat-input');
    _focusInput(document.getElementById(inputId));
    return;
  }
  if (kind === 'connector') {
    _consumeAtKeyChar();
    setChatConnector(target, itemId, itemName || itemId);
    const inputId = target === 'new-chat'
      ? 'new-chat-input'
      : (target === 'auto' ? 'auto-task-input' : 'chat-input');
    _focusInput(document.getElementById(inputId));
    return;
  }
  if (kind === 'library') {
    await _triggerLibraryFile(dataset || {}, anchorId);
    return;
  }
  if (kind === 'ontology_group') {
    _triggerOntologyGroup(itemId, itemName, anchorId);
    return;
  }
  if (kind === 'artifact') {
    await _triggerArtifactRef(itemName, dataset || {}, anchorId);
    return;
  }
  if (kind === 'asset') {
    await _triggerAssetRef(itemName, dataset || {}, anchorId);
    return;
  }
  await _triggerAgent(itemId, itemName, anchorId);
}

/**
 * 本体分组行的点击处理：不走 _triggerAgent/_triggerLibraryFile 那种"触发即关闭
 * picker"的分支，而是切换该分组的勾选状态（类似多选下拉）。第一次选中会顺带
 * 消费掉输入框里那个 `@` 字符（跟其余 tab 一致）；之后的多选不会再有 `@` 可消费
 * （_consumeAtKeyChar 在标记已清空时是安全的空操作）。选中/取消不关闭 picker，
 * 也不 focus 回输入框——用户还在挑选，focus 跳走会打断多选操作。
 */
function _triggerOntologyGroup(groupId, groupTitle, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  const alreadySelected = (typeof getChatUseOntologyGroups === 'function')
    ? getChatUseOntologyGroups(target).some((sel) => sel.id === groupId)
    : false;
  _consumeAtKeyChar();
  if (alreadySelected) {
    if (typeof removeChatUseOntologyGroup === 'function') removeChatUseOntologyGroup(target, groupId);
  } else {
    if (typeof addChatUseOntologyGroup === 'function') addChatUseOntologyGroup(target, groupId, groupTitle);
  }
  // Re-render just the list so the checkbox reflects the new state; the
  // search input keeps focus and the picker stays open for further picks.
  const listEl = document.getElementById('agent-picker-list');
  const search = document.getElementById('agent-picker-search');
  if (listEl) _renderOntologyPickerList(listEl, search ? search.value : '', anchorId);
}

function _libraryPickerInputIdForTarget(target) {
  if (target === 'new-chat') return 'new-chat-input';
  if (target === 'auto') return 'auto-task-input';
  return 'chat-input';
}

function _libraryPickerDraftCidFor(anchorId, target) {
  if (target === 'new-chat') return window.COMMANDER_DRAFT_CID;
  if (target === 'conversation') {
    return (typeof currentCid !== 'undefined') ? (currentCid || '') : '';
  }
  return '';
}

async function _triggerLibraryFile(dataset, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  // 空间化后仅全局上下文库（contexts）可挂草稿；project scope 已删。
  const scope = 'global';
  const rel = dataset.libraryRel || '';
  if (!rel) return;
  if (target === 'auto') {
    try {
      if (typeof window._autoAttachLibraryFile !== 'function') throw new Error('auto_attach_unavailable');
      await window._autoAttachLibraryFile({ scope, rel });
      _consumeAtKeyChar();
      _focusInput(document.getElementById('auto-task-input'));
    } catch (err) {
      const reason = String((err && err.message) || err || 'failed');
      if (typeof uiAlert === 'function') await uiAlert(t('agent_picker.library_attach_failed', { reason }));
    }
    return;
  }
  const cid = _libraryPickerDraftCidFor(anchorId, target);
  if (!cid) return;

  const channel = 'contexts.attachToDraft';
  const payload = { relPath: rel };
  const inputId = _libraryPickerInputIdForTarget(target);
  const telemetry = {
    target,
    scope,
    has_project: false,
  };
  try {
    await window.attachKbFileToDraft(
      channel,
      payload,
      cid,
      () => {
        if (target === 'new-chat' && typeof setView === 'function') setView('new-chat');
      },
    );
    _agentsTrackEvent('chat_library_attach_result', { ...telemetry, result: 'success' });
    _consumeAtKeyChar();
    _focusInput(document.getElementById(inputId));
  } catch (err) {
    const reason = String((err && err.message) || err || 'failed');
    _agentsTrackEvent('chat_library_attach_result', { ...telemetry, result: 'failure' });
    _agentsTrackError('chat_library_attach', {
      ...telemetry,
      error_type: 'operation',
      error_message: 'library_attach_failed',
    });
    if (typeof uiAlert === 'function') await uiAlert(t('agent_picker.library_attach_failed', { reason }));
  }
}

// Route an agent selection to the right behaviour based on which button
// triggered the picker:
//   - recipient chip / @ picker → update the persistent recipient chip.
//   - other anchors → spin up a fresh conversation for that agent.
async function _triggerAgent(agentId, agentName, anchorId) {
  if (anchorId === 'auto-recipient-chip') {
    // Auto modal owns its own recipient state; route the picked agent
    // (or commander) to its registered handler instead of touching any
    // conversation-scoped chat state.
    const rec = (agentId === '__commander__')
      ? { kind: 'commander' }
      : { kind: 'agent', id: agentId, name: agentName || agentId };
    const resourceAgentId = rec.kind === 'commander' ? _COMMANDER_AGENT_ID : String(agentId || '');
    _agentsTrackClick('auto_agent_select', {
      target: 'auto',
      recipient_type: rec.kind,
      agent_id: rec.kind === 'agent' ? String(agentId || '') : '',
    });
    if (typeof window !== 'undefined' && typeof window._autoOnRecipientPicked === 'function') {
      window._autoOnRecipientPicked(rec);
    }
    _consumeAtKeyChar();
    _focusInput(document.getElementById('auto-task-input'));
    return;
  }
  const isRecipientAnchor = anchorId === 'chat-recipient-chip'
    || anchorId === 'new-chat-recipient-chip';
  if (isRecipientAnchor) {
    const target = _targetFromPickerAnchor(anchorId);
    const resourceAgentId = agentId === '__commander__' ? _COMMANDER_AGENT_ID : String(agentId || '');
    _agentsTrackClick('chat_agent_select', {
      target,
      recipient_type: agentId === '__commander__' ? 'commander' : 'agent',
      agent_id: agentId === '__commander__' ? '' : String(agentId || ''),
    });
    if (agentId === '__commander__') {
      setChatRecipient(target, { kind: 'commander' });
    } else {
      setChatRecipient(target, { kind: 'agent', id: agentId, name: agentName || agentId });
    }
    // If the picker was opened by the user typing `@` in the textarea, that
    // `@` is now redundant (the chip carries the recipient) and would also
    // leak into the sent text — strip it.
    _consumeAtKeyChar();
    const inputId = target === 'new-chat' ? 'new-chat-input' : 'chat-input';
    _focusInput(document.getElementById(inputId));
    return;
  }
  // Sidebar / agent-detail "use" button → spin up a fresh conversation
  await useAgent(agentId);
}

// `@`-keystroke bookkeeping so a successful picker selection can remove the
// `@` the user just typed. Cleared on every open; consumed on selection.
let _atKeyMark = null; // { inputId, posAfter } | null

function _consumeAtKeyChar() {
  const m = _atKeyMark;
  _atKeyMark = null;
  if (!m) return null;
  const ta = document.getElementById(m.inputId);
  if (!ta) return null;
  const atIdx = m.posAfter - 1;
  if (atIdx < 0 || ta.value.charAt(atIdx) !== '@') return null;
  ta.value = ta.value.slice(0, atIdx) + ta.value.slice(atIdx + 1);
  try { ta.setSelectionRange(atIdx, atIdx); } catch (_) {}
  if (typeof autoGrow === 'function') autoGrow(ta, 200);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return ta;
}

function _focusInput(input) {
  // Defer to the next tick so the picker's outside-click handler can finish
  // closing first; otherwise focus jumps back to the picker on some browsers.
  setTimeout(() => {
    try {
      if (typeof focusChatRichComposer === 'function' && focusChatRichComposer(input)) return;
      input.focus();
    } catch (_) {}
  }, 0);
}

// Recipient chip + composer textarea anchor pairs. Three sticky composers
// (commander conversation, new-chat landing, project detail) get bound at
// boot from this table; the auto modal calls `bindRecipientAnchor`
// directly when it mounts so its DOM ID joins the wiring on the fly.
const _RECIPIENT_ANCHOR_PAIRS = [
  { chip: 'chat-recipient-chip',         input: 'chat-input' },
  { chip: 'new-chat-recipient-chip',     input: 'new-chat-input' },
];

// Backspace right after a `@<name>` token (with or without the trailing
// space the picker inserts) removes the whole mention as one unit —
// character-by-character deletion of `@<CJK-name> ` is annoying when the
// user picked the wrong agent. Matches the bus mention regex's charset so
// CJK names work.
const _MENTION_DELETE_RE = /@[A-Za-z0-9_一-鿿-]+ ?$/u;

function _recipientTextareaFromEventTarget(target) {
  if (!target) return null;
  const inputId = target.dataset?.richInputId || target.id || '';
  if (inputId) {
    const input = document.getElementById(inputId);
    if (input) return input;
  }
  return target;
}

function _onMentionBackspace(e) {
  if (e.key !== 'Backspace') return;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const ta = _recipientTextareaFromEventTarget(e.currentTarget);
  if (!ta || typeof ta.selectionStart !== 'number') return;
  if (ta.selectionStart !== ta.selectionEnd) return; // user has a selection — let default handle
  const caret = ta.selectionStart;
  if (caret === 0) return;
  const left = ta.value.slice(0, caret);
  const m = _MENTION_DELETE_RE.exec(left);
  if (!m) return;
  const start = caret - m[0].length;
  e.preventDefault();
  ta.value = ta.value.slice(0, start) + ta.value.slice(caret);
  try { ta.setSelectionRange(start, start); } catch (_) {}
  if (typeof autoGrow === 'function') autoGrow(ta, 200);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function _atKeyOpener(chipId) {
  return (e) => {
    if (e.key !== '@') return;
    const btn = document.getElementById(chipId);
    if (!btn) return;
    const ta = _recipientTextareaFromEventTarget(e.currentTarget);
    if (!ta) return;
    setTimeout(() => {
      try {
        if (typeof getChatRichComposerSelection === 'function') getChatRichComposerSelection(ta);
      } catch (_) {}
      _atKeyMark = {
        inputId: ta.id || '',
        posAfter: typeof ta.selectionStart === 'number' ? ta.selectionStart : 0,
      };
      _openAgentPicker(btn);
    }, 0);
  };
}

// Wire (chip → click opens picker) + (textarea → `@` opens picker,
// Backspace deletes whole mention). Guarded with dataset flags so calling
// this twice for the same anchor is a no-op. Called at boot for the three
// sticky composers AND on demand by `modules/auto.js` when its modal
// mounts (registers the 4th `'auto-recipient-chip'` anchor).
function bindRecipientAnchor(chipId, inputId) {
  const btn = document.getElementById(chipId);
  if (btn && btn.dataset.bound !== '1') {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      _atKeyMark = null; // chip click is not a `@`-keystroke trigger
      const picker = document.getElementById('agent-picker');
      if (picker && picker.style.display !== 'none' && picker.dataset.anchorId === chipId) {
        _closeAgentPicker();
      } else {
        _openAgentPicker(btn);
      }
    });
  }
  const ta = document.getElementById(inputId);
  const bindInput = (el) => {
    if (!el || el.dataset.atBound === '1') return;
    el.dataset.atBound = '1';
    el.addEventListener('keydown', _atKeyOpener(chipId));
    el.addEventListener('keydown', _onMentionBackspace);
  };
  bindInput(ta);
  if (typeof getChatRichComposerEditor === 'function') {
    try {
      bindInput(getChatRichComposerEditor(inputId));
    } catch (_) {}
  }
}

if (typeof window !== 'undefined') {
  window.bindRecipientAnchor = bindRecipientAnchor;
  window.refreshAgentPickerContext = refreshAgentPickerContext;
  window.renderChatTaskRefChips = renderChatTaskRefChips;
  window.commitNewChatTaskRefs = commitNewChatTaskRefs;
  window.clearChatTaskRefChips = clearChatTaskRefChips;
  window.updateAgentPickerPlaceholders = updateAgentPickerPlaceholders;
}

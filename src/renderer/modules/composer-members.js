// Composer 多 Agent 选择：会话成员名单、正文 `@` 点名标记、按来源的模型配置。
//
// 三条互相独立的规则（PRD FR-002/FR-007/FR-016）：
//   1. 底部 `@` 入口管理「会话成员」——有序名单，勾选即往草稿插入绿色点名标记；
//      手动删掉某成员在草稿里的最后一个标记＝主动取消该成员（发送后的自动清空不算）。
//   2. 正文 `@` 点名标记绑定稳定身份，整块删除；标记只由选择动作产生，
//      普通文字/邮箱/未知名不会自动成为执行者。
//   3. 模型配置按来源分组：CogSeed 与 Task Agent 共用一套，每个外接实例独立一套。
//
// 纯函数集中在文件上半部并通过 guarded CommonJS bridge 暴露给单测；DOM 与
// localStorage 读写留在同一 IIFE 内，不再拆层（渲染层经典脚本约束）。

(function initComposerMembers(root) {
  'use strict';

  const MEMBERS_LS_KEY = 'chat.membersByCid';
  const SOURCE_CONFIG_LS_KEY = 'chat.sourceConfigByCid';
  const MENTION_SIDECAR_LS_KEY = 'chat.mentionSidecarByCid';
  const INTERNAL_SOURCE = 'internal';
  const COMMANDER_ID = 'commander';
  // 与 bus/router 的 mention 字符集保持一致（ASCII 词字符 + CJK 汉字 + 连字符）。
  const TOKEN_CHAR_RE = /[A-Za-z0-9_\u4e00-\u9fff-]/;
  const EFFORT_VALUES = ['off', 'low', 'high'];

  function tr(key, fallback, vars) {
    if (typeof t === 'function') {
      const out = t(key, vars || {});
      if (out && out !== key) return out;
    }
    return fallback === undefined ? key : fallback;
  }

  // ─── 纯函数：成员 / 来源 / 摘要 ────────────────────────────────────────────

  function commanderName() {
    return tr('composer.members.commander_name', 'CogSeed');
  }

  function commanderMember() {
    return { kind: 'commander', id: COMMANDER_ID, name: commanderName() };
  }

  /** 成员稳定键：commander 统一成 `commander`，agent 用 agent_id。 */
  function memberKeyOf(member) {
    if (!member) return '';
    if (member.kind === 'agent' && member.id) return String(member.id);
    return COMMANDER_ID;
  }

  function normalizeMember(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.kind === 'agent' && raw.id) {
      return { kind: 'agent', id: String(raw.id), name: String(raw.name || raw.id) };
    }
    if (raw.kind === 'commander' || raw.id === COMMANDER_ID) return commanderMember();
    return null;
  }

  function normalizeMembers(list) {
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(list) ? list : [])) {
      const member = normalizeMember(raw);
      const key = memberKeyOf(member);
      if (!member || !key || seen.has(key)) continue;
      seen.add(key);
      out.push(member);
    }
    return out;
  }

  /** 未显式选择时由 CogSeed 接收（FR-003）。 */
  function effectiveMembers(members) {
    const list = normalizeMembers(members);
    return list.length ? list : [commanderMember()];
  }

  /** CLI / P3394 外接实例：独立配置、不能与内部成员合并来源。 */
  function isExternalAgentRecord(agent) {
    const kind = agent && agent.runtime && agent.runtime.kind;
    return kind === 'cli' || kind === 'p3394-gateway';
  }

  function isExternalMember(member, agentIndex) {
    const key = memberKeyOf(member);
    if (!key || key === COMMANDER_ID) return false;
    return isExternalAgentRecord(agentIndex && agentIndex.get ? agentIndex.get(key) : null);
  }

  /**
   * 配置来源分组：内部一套（CogSeed + 全部 Task Agent 共享）+ 每个外接实例一套。
   * 套数只随会话成员变化，不随本条 @ 数量变化（FR-008）。
   */
  function configGroupsFrom(members, agentIndex) {
    const effective = effectiveMembers(members);
    const internal = [];
    const externals = [];
    for (const member of effective) {
      const key = memberKeyOf(member);
      if (isExternalMember(member, agentIndex)) {
        externals.push({
          id: key,
          name: member.name || key,
          external: true,
          members: [key],
        });
      } else {
        internal.push(member);
      }
    }
    const groups = [];
    if (internal.length) {
      groups.push({
        id: INTERNAL_SOURCE,
        name: tr('composer.model.source_internal', 'CogSeed / Task Agent'),
        external: false,
        members: internal.map(memberKeyOf),
      });
    }
    return groups.concat(externals);
  }

  /** 成员里的执行者 id（不含协调者）：主进程只按 agent 校验这份名单。 */
  function agentMemberIds(members) {
    return normalizeMembers(members)
      .map(memberKeyOf)
      .filter((key) => key && key !== COMMANDER_ID);
  }

  /** 底部入口摘要：首位成员名 + 其余人数（一位不显示 +0）。 */
  function memberSummary(members) {
    const effective = effectiveMembers(members);
    const first = effective[0];
    return {
      key: memberKeyOf(first),
      name: first.name || commanderName(),
      total: effective.length,
      extra: Math.max(0, effective.length - 1),
    };
  }

  // ─── 纯函数：正文点名标记 ─────────────────────────────────────────────────

  /** 名称表：CogSeed（含内建别名）+ 当前可用 Agent，长名优先匹配。 */
  function mentionTableFrom(agents) {
    const table = [{
      id: COMMANDER_ID,
      name: commanderName(),
      aliases: ['commander', 'cogseed', '指挥官'],
    }];
    const sorted = (Array.isArray(agents) ? agents : [])
      .filter((a) => a && a.agent_id && a.name)
      .sort((a, b) => String(b.name).length - String(a.name).length);
    for (const a of sorted) {
      table.push({ id: String(a.agent_id), name: String(a.name), aliases: [] });
    }
    return table;
  }

  function _matchAt(text, index, entry) {
    const candidates = [entry.name].concat(entry.aliases || []);
    for (const candidate of candidates) {
      if (!candidate) continue;
      const seg = text.slice(index + 1, index + 1 + candidate.length);
      if (seg.toLowerCase() !== candidate.toLowerCase()) continue;
      const after = text[index + 1 + candidate.length];
      if (after && TOKEN_CHAR_RE.test(after)) continue;
      return candidate;
    }
    return '';
  }

  /**
   * 扫描正文里的有效点名标记。有效＝@ 前是行首或非词字符（排除邮箱），
   * @ 后是注册过的 Agent 名或 CogSeed 别名，且名字后面不是词字符。
   */
  function mentionTokensIn(text, table) {
    const src = String(text || '');
    const entries = Array.isArray(table) ? table : [];
    const out = [];
    for (let i = 0; i < src.length; i += 1) {
      if (src[i] !== '@') continue;
      if (i > 0 && TOKEN_CHAR_RE.test(src[i - 1])) continue;
      let hit = null;
      let matched = '';
      for (const entry of entries) {
        const candidate = _matchAt(src, i, entry);
        if (!candidate) continue;
        if (!hit || candidate.length > matched.length) {
          hit = entry;
          matched = candidate;
        }
      }
      if (!hit) continue;
      const end = i + 1 + matched.length;
      out.push({ id: hit.id, name: matched, start: i, end, raw: src.slice(i, end) });
      i = end - 1;
    }
    return out;
  }

  function mentionIdsIn(text, table) {
    const seen = new Set();
    for (const token of mentionTokensIn(text, table)) seen.add(token.id);
    return seen;
  }

  /**
   * 草稿编辑后的成员联动（FR-002 / US1-04）。
   *
   * `baseline`：本草稿里「曾经被标记代表过」的成员键集合——它的存在让撤销
   * 恢复标记时能恢复成员，同时保证纯文本不会凭空增员（普通文字不在基线里）。
   * `lastPresent`：上一次同步时仍在正文里的成员键，用来区分「刚被删掉」与
   * 「本来就没有标记」。
   */
  function syncDraftMembers(input) {
    const members = normalizeMembers(input && input.members);
    const baseline = (input && input.baseline) || new Set();
    const lastPresent = (input && input.lastPresent) || new Set();
    const present = (input && input.present) || mentionIdsIn(input && input.text, input && input.table);

    const removed = [];
    const kept = members.filter((member) => {
      const key = memberKeyOf(member);
      if (!baseline.has(key) || !lastPresent.has(key)) return true;
      if (present.has(key)) return true;
      removed.push(key);
      return false;
    });

    const restored = [];
    for (const key of present) {
      if (!baseline.has(key) || kept.some((m) => memberKeyOf(m) === key)) continue;
      restored.push(key);
    }
    return { members: kept, present, removed, restored };
  }

  // ─── 状态与持久化 ─────────────────────────────────────────────────────────

  function loadMap(key) {
    try {
      const raw = root.localStorage && root.localStorage.getItem(key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function saveMap(key, value) {
    try {
      if (root.localStorage) root.localStorage.setItem(key, JSON.stringify(value));
    } catch (_) { /* quota / private mode — 选择仍在本会话内存里生效 */ }
  }

  let _membersByCid = loadMap(MEMBERS_LS_KEY);
  let _sourceConfigByCid = loadMap(SOURCE_CONFIG_LS_KEY);
  let _mentionSidecarByCid = loadMap(MENTION_SIDECAR_LS_KEY);
  const _baseline = new Map();     // targetKey → Set(memberKey) 本草稿标记基线
  const _lastPresent = new Map();  // targetKey → Set(memberKey) 上次仍在正文里的标记
  // Session-only authorization archive for native undo. Active sidecars stay
  // persisted for draft recovery, but removed identities must not survive a
  // reload where later typed/pasted display text could otherwise revive them.
  const _mentionHistoryByTarget = new Map();

  function currentCidSafe() {
    try {
      if (typeof currentCid === 'string' && currentCid) return currentCid;
    } catch (_) { /* conversation.js 尚未加载 */ }
    return '';
  }

  function targetKeyOf(target) {
    const tg = target || 'conversation';
    if (tg === 'new-chat') return 'new-chat';
    if (tg === 'project') return 'project';
    const cid = currentCidSafe();
    return cid || 'new-chat';
  }

  function inputIdOf(target) {
    const tg = target || 'conversation';
    if (tg === 'new-chat') return 'new-chat-input';
    if (tg === 'auto') return 'auto-task-input';
    return 'chat-input';
  }

  function agentList() {
    try {
      if (typeof window.getComposerAgentList === 'function') return window.getComposerAgentList() || [];
    } catch (_) { /* agents.js 未加载 */ }
    return [];
  }

  /** 候选列表用的 Agent（与既有 Agents 页签同口径：项目绑定时只列绑定的）。 */
  function candidateAgentList() {
    try {
      if (typeof window.getComposerAgentCandidates === 'function') {
        return window.getComposerAgentCandidates() || [];
      }
    } catch (_) { /* agents.js 未加载 */ }
    return agentList();
  }

  function memberScopeHint() {
    try {
      if (typeof window.getComposerMemberScopeHint === 'function') {
        return String(window.getComposerMemberScopeHint() || '');
      }
    } catch (_) { /* ignore */ }
    return '';
  }

  function agentIndex() {
    const map = new Map();
    for (const agent of agentList()) {
      if (agent && agent.agent_id) map.set(String(agent.agent_id), agent);
    }
    return map;
  }

  function rawMembers(target) {
    return normalizeMembers(_membersByCid[targetKeyOf(target)]);
  }

  function getMembers(target) {
    return rawMembers(target).map((m) => ({ ...m }));
  }

  function normalizeMentionSidecar(list) {
    const out = [];
    for (const raw of (Array.isArray(list) ? list : [])) {
      if (!raw || typeof raw !== 'object' || !raw.id || !raw.name) continue;
      const start = Number(raw.start);
      const text = String(raw.text || `@${raw.name} `);
      if (!Number.isSafeInteger(start) || start < 0 || !text) continue;
      out.push({ id: String(raw.id), name: String(raw.name), start, end: start + text.length, text });
    }
    return out.sort((a, b) => a.start - b.start || a.end - b.end);
  }

  function setMentionSidecar(target, list) {
    const key = targetKeyOf(target);
    const previous = normalizeMentionSidecar(_mentionSidecarByCid[key]);
    const next = normalizeMentionSidecar(list);
    const sameIdentity = (left, right) => left.id === right.id
      && left.name === right.name
      && left.text === right.text;
    const sameExactToken = (left, right) => sameIdentity(left, right)
      && left.start === right.start
      && left.end === right.end;
    const history = normalizeMentionSidecar(_mentionHistoryByTarget.get(key));
    for (const token of previous) {
      if (next.some((candidate) => sameIdentity(token, candidate))) continue;
      if (!history.some((candidate) => sameExactToken(token, candidate))) history.push(token);
    }
    const inactive = history
      .filter((token) => !next.some((candidate) => sameExactToken(token, candidate)))
      .slice(-50);
    if (inactive.length) _mentionHistoryByTarget.set(key, inactive);
    else _mentionHistoryByTarget.delete(key);
    if (next.length) _mentionSidecarByCid[key] = next;
    else delete _mentionSidecarByCid[key];
    saveMap(MENTION_SIDECAR_LS_KEY, _mentionSidecarByCid);
    return next.map((token) => ({ ...token }));
  }

  function mentionSidecarSnapshot(target) {
    return normalizeMentionSidecar(_mentionSidecarByCid[targetKeyOf(target)])
      .map((token) => ({ ...token }));
  }

  /** Authorize mention chips ingested from the rich-editor DOM. Ordinary
   * edits may only move already-active chooser tokens. A browser historyUndo
   * may additionally reactivate one session-archived token, but only when its
   * stable identity, token text, and exact range all match the deleted atom. */
  function syncMentionSidecarFromDom(target, list, opts) {
    const key = targetKeyOf(target);
    const candidates = normalizeMentionSidecar(list);
    const active = mentionSidecarSnapshot(target);
    const history = normalizeMentionSidecar(_mentionHistoryByTarget.get(key));
    const activeUsed = new Set();
    const historyUsed = new Set();
    const isHistoryUndo = opts && opts.inputType === 'historyUndo';
    const authorized = [];
    for (const candidate of candidates) {
      const activeIndex = active.findIndex((token, index) => (
        !activeUsed.has(index)
        && token.id === candidate.id
        && token.name === candidate.name
        && token.text === candidate.text
      ));
      if (activeIndex >= 0) {
        activeUsed.add(activeIndex);
        authorized.push(candidate);
        continue;
      }
      if (!isHistoryUndo) continue;
      const historyIndex = history.findIndex((token, index) => (
        !historyUsed.has(index)
        && token.id === candidate.id
        && token.name === candidate.name
        && token.text === candidate.text
        && token.start === candidate.start
        && token.end === candidate.end
      ));
      if (historyIndex < 0) continue;
      historyUsed.add(historyIndex);
      authorized.push(candidate);
    }
    return setMentionSidecar(target, authorized);
  }

  /** Only chooser-created atoms carry identity. Exact atoms can move during
   * ordinary editing/undo, but typed or pasted display names have no sidecar
   * record and therefore never become an Agent mention. */
  function mentionTokensForTarget(target, text) {
    const src = String(text || '');
    const stored = mentionSidecarSnapshot(target);
    const used = new Set();
    const resolved = [];
    for (const token of stored) {
      let start = src.slice(token.start, token.end) === token.text ? token.start : -1;
      if (start < 0) {
        const candidates = [];
        let at = src.indexOf(token.text);
        while (at >= 0) {
          if (!used.has(at)) candidates.push(at);
          at = src.indexOf(token.text, at + 1);
        }
        if (candidates.length) {
          candidates.sort((a, b) => Math.abs(a - token.start) - Math.abs(b - token.start));
          start = candidates[0];
        }
      }
      if (start < 0 || used.has(start)) continue;
      used.add(start);
      resolved.push({ ...token, start, end: start + token.text.length, raw: token.text.trimEnd() });
    }
    const next = resolved.map(({ raw: _raw, ...token }) => token);
    if (JSON.stringify(next) !== JSON.stringify(stored)) setMentionSidecar(target, next);
    return resolved;
  }

  function mentionIdsForTarget(target, text) {
    return Array.from(new Set(mentionTokensForTarget(target, text).map((token) => token.id)));
  }

  /** 列表为空 = 默认由 CogSeed 接收（不落盘空数组以外的语义）。 */
  function setMembers(target, list, opts) {
    const key = targetKeyOf(target);
    const previous = rawMembers(target);
    const next = normalizeMembers(list);
    const nextKeys = new Set(next.map(memberKeyOf));
    const removedAgentIds = previous
      .map(memberKeyOf)
      .filter((id) => id && id !== COMMANDER_ID && !nextKeys.has(id));
    if (next.length) _membersByCid[key] = next;
    else delete _membersByCid[key];
    saveMap(MEMBERS_LS_KEY, _membersByCid);
    if (!opts || opts.silent !== true) {
      emitChange(target, {
        members: next,
        ...(removedAgentIds.length ? { removed_agent_ids: removedAgentIds } : {}),
      });
    }
    return next;
  }

  function isMember(target, memberKey) {
    return rawMembers(target).some((m) => memberKeyOf(m) === memberKey);
  }

  function addMember(target, member, opts) {
    const normalized = normalizeMember(member);
    if (!normalized) return null;
    const list = rawMembers(target);
    const key = memberKeyOf(normalized);
    if (list.some((m) => memberKeyOf(m) === key)) return list;
    list.push(normalized);
    // 重选排到末尾（FR-002）。
    return setMembers(target, list, opts);
  }

  function removeMember(target, memberKey, opts) {
    const list = rawMembers(target).filter((m) => memberKeyOf(m) !== memberKey);
    return setMembers(target, list, opts);
  }

  function clearMembers(target) {
    return setMembers(target, []);
  }

  /** 落地页选择的成员与配置跟随首条消息进入新会话（FR-016）。 */
  function transferTarget(fromTarget, toKey) {
    const from = targetKeyOf(fromTarget);
    const to = String(toKey || '');
    if (!from || !to || from === to) return;
    if (_membersByCid[from]) {
      _membersByCid[to] = normalizeMembers(_membersByCid[from]);
      delete _membersByCid[from];
      saveMap(MEMBERS_LS_KEY, _membersByCid);
    }
    if (_sourceConfigByCid[from]) {
      _sourceConfigByCid[to] = { ..._sourceConfigByCid[from] };
      delete _sourceConfigByCid[from];
      saveMap(SOURCE_CONFIG_LS_KEY, _sourceConfigByCid);
    }
    if (_mentionSidecarByCid[from]) {
      _mentionSidecarByCid[to] = normalizeMentionSidecar(_mentionSidecarByCid[from]);
      delete _mentionSidecarByCid[from];
      saveMap(MENTION_SIDECAR_LS_KEY, _mentionSidecarByCid);
    }
    resetDraftTracking(fromTarget);
    // 入口按新会话的来源重画（迁移发生在新会话挂载之后，不能等下次事件）。
    if (typeof window.refreshExecConfigChip === 'function') {
      try { window.refreshExecConfigChip(); } catch (_) {}
    }
  }

  /** 新建任务等「恢复默认」：清成员、清按来源配置、清标记基线。 */
  function resetTarget(target) {
    const key = targetKeyOf(target);
    delete _membersByCid[key];
    delete _sourceConfigByCid[key];
    delete _mentionSidecarByCid[key];
    saveMap(MEMBERS_LS_KEY, _membersByCid);
    saveMap(SOURCE_CONFIG_LS_KEY, _sourceConfigByCid);
    saveMap(MENTION_SIDECAR_LS_KEY, _mentionSidecarByCid);
    resetDraftTracking(target);
    emitChange(target, { reset: true });
  }

  // ─── 按来源的模型配置 ─────────────────────────────────────────────────────

  function getSourceConfig(target, sourceId) {
    const bucket = _sourceConfigByCid[targetKeyOf(target)];
    const entry = bucket && typeof bucket === 'object' ? bucket[sourceId] : null;
    if (!entry || typeof entry !== 'object') return null;
    const out = {};
    if (typeof entry.model === 'string' && entry.model) out.model = entry.model;
    if (typeof entry.modelLabel === 'string' && entry.modelLabel) out.modelLabel = entry.modelLabel;
    if (typeof entry.provider === 'string' && entry.provider) out.provider = entry.provider;
    if (EFFORT_VALUES.includes(entry.effort)) out.effort = entry.effort;
    return Object.keys(out).length ? out : null;
  }

  function setSourceConfig(target, sourceId, patch) {
    const key = targetKeyOf(target);
    const bucket = (_sourceConfigByCid[key] && typeof _sourceConfigByCid[key] === 'object')
      ? { ..._sourceConfigByCid[key] }
      : {};
    if (patch === null || patch === undefined) delete bucket[sourceId];
    else {
      const next = { ...(bucket[sourceId] || {}) };
      for (const field of ['model', 'modelLabel', 'provider']) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
          if (patch[field]) next[field] = String(patch[field]);
          else delete next[field];
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'effort')) {
        if (EFFORT_VALUES.includes(patch.effort)) next.effort = patch.effort;
        else delete next.effort;
      }
      if (Object.keys(next).length) bucket[sourceId] = next;
      else delete bucket[sourceId];
    }
    if (Object.keys(bucket).length) _sourceConfigByCid[key] = bucket;
    else delete _sourceConfigByCid[key];
    saveMap(SOURCE_CONFIG_LS_KEY, _sourceConfigByCid);
    emitChange(target, { sourceId, patch: patch || null });
    return getSourceConfig(target, sourceId);
  }

  /** 某来源的配置套数（入口按套数切换形态，FR-008）。 */
  function configGroups(target) {
    return configGroupsFrom(rawMembers(target), agentIndex());
  }

  /** 会话内提交快照用的按来源配置：{ internal?, [agentId]? }。 */
  function sourceConfigSnapshot(target) {
    const key = targetKeyOf(target);
    const bucket = _sourceConfigByCid[key];
    if (!bucket || typeof bucket !== 'object') return null;
    const live = new Set(configGroups(target).map((g) => g.id));
    const out = {};
    for (const [sourceId, value] of Object.entries(bucket)) {
      if (!live.has(sourceId)) continue;
      if (value && typeof value === 'object' && Object.keys(value).length) out[sourceId] = { ...value };
    }
    return Object.keys(out).length ? out : null;
  }

  function draftSelectionSnapshot(target) {
    return {
      members: getMembers(target),
      sourceConfigs: sourceConfigSnapshot(target),
      mentions: mentionSidecarSnapshot(target),
    };
  }

  function restoreDraftSnapshot(target, snapshot) {
    const key = targetKeyOf(target);
    const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const members = normalizeMembers(value.members);
    if (members.length) _membersByCid[key] = members;
    else delete _membersByCid[key];
    const configs = value.sourceConfigs && typeof value.sourceConfigs === 'object'
      ? { ...value.sourceConfigs }
      : null;
    if (configs && Object.keys(configs).length) _sourceConfigByCid[key] = configs;
    else delete _sourceConfigByCid[key];
    saveMap(MEMBERS_LS_KEY, _membersByCid);
    saveMap(SOURCE_CONFIG_LS_KEY, _sourceConfigByCid);
    setMentionSidecar(target, value.mentions || []);
    resetDraftTracking(target);
    emitChange(target, { restored: true, members });
  }

  // ─── 变更广播 ─────────────────────────────────────────────────────────────

  function emitChange(target, detail) {
    try {
      root.dispatchEvent(new CustomEvent('composer-members-change', {
        detail: { target: target || 'conversation', ...(detail || {}) },
      }));
    } catch (_) { /* non-DOM 环境 */ }
    if (typeof window.refreshExecConfigChip === 'function') {
      try { window.refreshExecConfigChip(); } catch (_) {}
    }
  }

  function resetDraftTracking(target) {
    const key = targetKeyOf(target);
    _baseline.delete(key);
    _lastPresent.delete(key);
    _mentionHistoryByTarget.delete(key);
  }

  function seedDraftTracking(target, text) {
    const key = targetKeyOf(target);
    const present = new Set(mentionIdsForTarget(target, text));
    _lastPresent.set(key, present);
    const baseline = new Set(_baseline.get(key) || []);
    for (const id of present) baseline.add(id);
    _baseline.set(key, baseline);
    return present;
  }

  /**
   * 用户编辑草稿后的同步：删除最后一个标记＝取消成员；撤销恢复标记＝恢复成员。
   * 返回 { changed, removed, restored }。
   */
  function syncFromDraft(target, text) {
    const key = targetKeyOf(target);
    const members = rawMembers(target);
    const baseline = _baseline.get(key) || new Set();
    const lastPresent = _lastPresent.get(key) || new Set();
    const result = syncDraftMembers({
      members,
      text,
      baseline,
      lastPresent,
      table: mentionTableFrom(agentList()),
      present: new Set(mentionIdsForTarget(target, text)),
    });
    const changed = result.removed.length > 0 || result.restored.length > 0;
    if (changed) {
      const next = result.members.slice();
      const index = agentIndex();
      for (const id of result.restored) {
        if (id === COMMANDER_ID) { next.push(commanderMember()); continue; }
        const agent = index.get(id);
        next.push({ kind: 'agent', id, name: (agent && agent.name) || id });
      }
      setMembers(target, next, { silent: true });
    }
    _lastPresent.set(key, result.present);
    const baselineNext = new Set(baseline);
    for (const id of result.present) baselineNext.add(id);
    _baseline.set(key, baselineNext);
    if (changed) {
      emitChange(target, {
        members: result.members,
        ...(result.removed.length
          ? { removed_agent_ids: result.removed.filter((id) => id !== COMMANDER_ID) }
          : {}),
      });
    }
    return { changed, removed: result.removed, restored: result.restored };
  }

  // ─── 正文标记插入 / 移除 ──────────────────────────────────────────────────

  function composerTextarea(target) {
    try {
      return document.getElementById(inputIdOf(target));
    } catch (_) {
      return null;
    }
  }

  function refreshComposer(target) {
    const inputId = inputIdOf(target);
    try {
      if (typeof syncChatRichComposerFromTextarea === 'function'
        && syncChatRichComposerFromTextarea(inputId)) return;
    } catch (_) { /* 富编辑器不可用时降级到 textarea */ }
  }

  function dispatchComposerInput(textarea) {
    if (!textarea) return;
    try { textarea.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  }

  /** 插入点名标记（去重）；`pendingAt` 为刚输入的 `@` 位置，命中即替换。 */
  function insertMention(target, member, opts) {
    const normalized = normalizeMember(member);
    const textarea = composerTextarea(target);
    if (!normalized || !textarea) return false;
    const key = memberKeyOf(normalized);
    const text = String(textarea.value || '');
    const tokens = mentionTokensForTarget(target, text);
    const existing = tokens.find((token) => token.id === key);
    const pendingAt = (opts && typeof opts.pendingAt === 'number') ? opts.pendingAt : null;

    if (existing && pendingAt === null) {
      // 同一成员不重复插入；把光标放到已有标记之后即可。
      setCaret(textarea, existing.end);
      refreshComposer(target);
      return true;
    }
    if (existing && pendingAt !== null
      && pendingAt >= existing.start && pendingAt < existing.end) {
      setCaret(textarea, existing.end);
      refreshComposer(target);
      return true;
    }

    let at = pendingAt === null ? caretIndex(textarea, text) : pendingAt;
    if (pendingAt !== null && text[at] !== '@') at = caretIndex(textarea, text);
    // 光标落在某个标记内部时排到它后面，绝不拆开已有标记（FR-005）。
    const containing = tokens.find((token) => at > token.start && at < token.end);
    if (containing) {
      // 光标在标记内部：排到标记之后，并跳过它后面的分隔空格（不制造双空格）。
      at = containing.end;
      if (text[at] === ' ') at += 1;
    }

    const replace = pendingAt !== null && text[at] === '@' ? 1 : 0;
    const name = normalized.name || key;
    const leading = at > 0 && !/\s/.test(text[at - 1]) ? ' ' : '';
    const token = `${leading}@${name} `;
    textarea.value = text.slice(0, at) + token + text.slice(at + replace);
    const retained = tokens
      .filter((item) => item.end <= at || item.start >= at + replace)
      .map((item) => {
        if (item.start < at) return item;
        const shift = token.length - replace;
        return { ...item, start: item.start + shift, end: item.end + shift };
      });
    retained.push({ id: key, name, start: at + leading.length, text: `@${name} ` });
    setMentionSidecar(target, retained);
    const caret = at + token.length;
    setCaret(textarea, caret);
    refreshComposer(target);
    dispatchComposerInput(textarea);
    return true;
  }

  /** 删除某成员在草稿里的全部标记（从底部取消勾选时调用）。 */
  function removeMentions(target, memberKey) {
    const textarea = composerTextarea(target);
    if (!textarea) return false;
    let text = String(textarea.value || '');
    const tokens = mentionTokensForTarget(target, text)
      .filter((token) => token.id === memberKey)
      .reverse();
    if (!tokens.length) return false;
    for (const token of tokens) {
      const end = text[token.end] === ' ' ? token.end + 1 : token.end;
      text = text.slice(0, token.start) + text.slice(end);
    }
    textarea.value = text;
    setMentionSidecar(target, mentionTokensForTarget(target, text));
    setCaret(textarea, text.length);
    refreshComposer(target);
    dispatchComposerInput(textarea);
    return true;
  }

  function caretIndex(textarea, text) {
    const start = typeof textarea.selectionStart === 'number' ? textarea.selectionStart : text.length;
    return Math.max(0, Math.min(start, text.length));
  }

  /**
   * 标记整块删除（FR-005）：光标紧邻、选区部分覆盖、剪切等路径都删掉整个标记，
   * 并顺带带走一个分隔空格，不误删任务文字。
   */
  function deleteMentionAtCaret(input, direction, target) {
    if (!input) return false;
    const text = String(input.value || '');
    const resolvedTarget = target || (input && input.id === 'new-chat-input' ? 'new-chat' : 'conversation');
    const tokens = mentionTokensForTarget(resolvedTarget, text);
    if (!tokens.length) return false;
    const start = typeof input.selectionStart === 'number' ? input.selectionStart : 0;
    const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : start;
    let hit;
    if (start !== end) {
      hit = tokens.filter((token) => start < token.end && end > token.start);
      if (!hit.length) return false;
    } else {
      const token = tokens.find((item) => (direction === 'backward'
        ? (start > item.start && start <= item.end)
          || (start === item.end + 1 && text[item.end] === ' ')
        : (start >= item.start && start < item.end)));
      if (!token) return false;
      hit = [token];
    }
    let from = Math.min(start, ...hit.map((token) => token.start));
    let to = Math.max(end, ...hit.map((token) => token.end));
    if (hit.some((token) => token.end === to) && text[to] === ' ') to += 1;
    else if (start === end && from > 0 && text[from - 1] === ' ') from -= 1;
    input.value = text.slice(0, from) + text.slice(to);
    setMentionSidecar(resolvedTarget, tokens
      .filter((token) => !hit.includes(token))
      .map((token) => token.start >= to
        ? { ...token, start: token.start - (to - from), end: token.end - (to - from) }
        : token));
    try { input.setSelectionRange(from, from); } catch (_) {}
    dispatchComposerInput(input);
    return true;
  }

  function setCaret(textarea, index) {
    try { textarea.setSelectionRange(index, index); } catch (_) {}
  }

  // ─── 候选列表（会话成员 / 本条点名） ──────────────────────────────────────

  function memberRows(target, mode) {
    const members = rawMembers(target);
    // 「本条点名」模式勾选的是草稿里已有的标记，不改变会话成员（FR-002）。
    const checked = mode === 'mentions'
      ? new Set(mentionIdsForTarget(target, (composerTextarea(target) || {}).value))
      : new Set(members.map(memberKeyOf));
    const rows = [];

    // 勾选态＝真实已选（原型 list() 同语义）：名单为空时 CogSeed 也不勾选——
    // "默认接收"由入口的 aria-label 说明，列表只反映真实选择。
    rows.push({
      key: COMMANDER_ID,
      kind: 'commander',
      group: '',
      name: commanderName(),
      description: tr('composer.members.commander_hint', '默认接收者，也可参与协作'),
      checked: checked.has(COMMANDER_ID),
    });

    for (const agent of candidateAgentList()) {
      if (!agent || !agent.agent_id) continue;
      const key = String(agent.agent_id);
      const external = isExternalAgentRecord(agent);
      rows.push({
        key,
        kind: 'agent',
        group: external ? 'external' : 'task',
        name: String(agent.name || key),
        description: describeAgent(agent, external),
        checked: checked.has(key),
      });
    }
    return rows;
  }

  function describeAgent(agent, external) {
    const runtime = (agent && agent.runtime) || {};
    if (external) {
      const cli = runtime.cli || runtime.kind || '';
      return tr('composer.members.external_hint', '本机 {cli} 命令行', { cli });
    }
    const desc = (typeof pickDesc === 'function') ? pickDesc(agent, (typeof getLang === 'function' ? getLang() : 'zh')) : '';
    return String(desc || '').trim() || tr('composer.members.task_hint', 'CogSeed 内部成员');
  }

  /** 分组顺序与原型一致：CogSeed → 外接 Agent → Task Agent（组内保持原序）。 */
  const GROUP_RANK = { '': 0, external: 1, task: 2 };
  function orderRowsByGroup(rows) {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => (GROUP_RANK[a.row.group] ?? 3) - (GROUP_RANK[b.row.group] ?? 3)
        || a.index - b.index)
      .map((entry) => entry.row);
  }

  function filterRows(rows, filter) {
    const q = String(filter || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => `${row.name} ${row.description}`.toLowerCase().includes(q));
  }

  /** 成员行：DOM 构建（图标仍走 icons.js），新模块不引入裸控件字面量。 */
  function createMemberRow(row, mode) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `skill-picker-item composer-member-row${row.checked ? ' is-checked' : ''}`;
    item.dataset.composerMember = row.key;
    item.dataset.memberKind = row.kind;
    item.dataset.memberName = row.name;
    item.setAttribute('aria-pressed', row.checked ? 'true' : 'false');
    item.setAttribute('aria-label', mode === 'mentions'
      ? tr('composer.members.mention_aria', '点名 {name}', { name: row.name })
      : tr('composer.members.member_aria', '选择会话成员 {name}', { name: row.name }));

    const check = document.createElement('span');
    check.className = 'composer-member-check';
    check.setAttribute('aria-hidden', 'true');
    if (typeof window.uiIconHtml === 'function') {
      check.innerHTML = window.uiIconHtml('check', 'composer-member-tick');
    }
    item.appendChild(check);

    const body = document.createElement('span');
    body.className = 'composer-member-body';
    const name = document.createElement('span');
    name.className = 'skill-picker-item-name';
    name.textContent = row.name;
    body.appendChild(name);
    if (row.description) {
      const desc = document.createElement('span');
      desc.className = 'skill-picker-item-desc';
      desc.textContent = row.description;
      body.appendChild(desc);
    }
    item.appendChild(body);
    return item;
  }

  const GROUP_LABELS = {
    cogseed: () => tr('composer.members.group_cogseed', 'CogSeed'),
    external: () => tr('composer.members.group_external', '外接 Agent'),
    task: () => tr('composer.members.group_task', 'Task Agent'),
  };

  function buildPickerList(target, mode, filter) {
    const fragment = document.createDocumentFragment();
    const rows = orderRowsByGroup(filterRows(memberRows(target, mode), filter));
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'skill-picker-empty';
      empty.textContent = tr('composer.members.no_match', '未找到匹配的智能体');
      fragment.appendChild(empty);
      return fragment;
    }
    const scopeHint = memberScopeHint();
    if (scopeHint && !filter) {
      const hint = document.createElement('div');
      hint.className = 'skill-picker-empty-hint';
      hint.textContent = scopeHint;
      fragment.appendChild(hint);
    }
    let group = '';
    for (const row of rows) {
      // 原型：group 为空的行（CogSeed）不出标题，只给外接 / Task Agent 分组。
      if (row.group && row.group !== group) {
        group = row.group;
        const label = document.createElement('div');
        label.className = 'skill-picker-group-label';
        label.textContent = GROUP_LABELS[group] ? GROUP_LABELS[group]() : group;
        fragment.appendChild(label);
      }
      fragment.appendChild(createMemberRow(row, mode));
    }
    return fragment;
  }

  /** 候选列表底部的计数 + 完成（PRD FR-006：搜索/关闭/完成都要可用）。 */
  function ensurePickerChrome(picker) {
    if (!picker) return null;
    let foot = picker.querySelector('.composer-members-foot');
    if (!foot) {
      foot = document.createElement('div');
      foot.className = 'skill-picker-foot composer-members-foot';
      const count = document.createElement('span');
      count.className = 'composer-members-count';
      foot.appendChild(count);
      const done = document.createElement('span');
      done.className = 'composer-members-done';
      done.innerHTML = (typeof window.uiButton === 'function')
        ? window.uiButton({
          label: tr('composer.members.done', '完成'),
          role: 'ghost',
          size: 'sm',
          attrs: { 'data-composer-members-done': '1' },
        })
        : '';
      foot.appendChild(done);
      picker.appendChild(foot);
    }
    return foot;
  }

  function updatePickerChrome(picker, target, mode) {
    const foot = ensurePickerChrome(picker);
    if (!foot) return;
    const count = foot.querySelector('.composer-members-count');
    if (count) {
      count.textContent = mode === 'mentions'
        ? tr('composer.members.mention_count', '本条点名 {n} 个', { n: mentionCountInDraft(target) })
        : tr('composer.members.count', '会话成员 {n} 个', { n: effectiveMembers(rawMembers(target)).length });
    }
  }

  function mentionCountInDraft(target) {
    const textarea = composerTextarea(target);
    if (!textarea) return 0;
    return mentionIdsForTarget(target, textarea.value).length;
  }

  // ─── 对外 API ─────────────────────────────────────────────────────────────

  const api = {
    COMMANDER_ID,
    INTERNAL_SOURCE,
    memberKeyOf,
    commanderMember,
    commanderName,
    normalizeMembers,
    effectiveMembers,
    isExternalAgentRecord,
    configGroupsFrom,
    memberSummary,
    agentMemberIds,
    mentionTableFrom,
    mentionTokensIn,
    mentionIdsIn,
    mentionTokensForTarget,
    mentionIdsForTarget,
    setMentionSidecar,
    mentionSidecarSnapshot,
    syncMentionSidecarFromDom,
    syncDraftMembers,
    getMembers,
    setMembers,
    addMember,
    removeMember,
    clearMembers,
    resetTarget,
    transferTarget,
    isMember,
    getSourceConfig,
    setSourceConfig,
    configGroups,
    sourceConfigSnapshot,
    draftSelectionSnapshot,
    restoreDraftSnapshot,
    resetDraftTracking,
    seedDraftTracking,
    syncFromDraft,
    insertMention,
    removeMentions,
    deleteMentionAtCaret,
    buildPickerList,
    orderRowsByGroup,
    updatePickerChrome,
    memberRows: (target, mode) => memberRows(target, mode),
    inputIdOf,
    targetKeyOf,
    currentCidSafe,
  };

  root.composerMembers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

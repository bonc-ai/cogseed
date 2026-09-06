// agents-detail.js — Agent 详情页 + 编辑模式。
// 从 agents.js 按职责拆出（R4）：分类/profile/继承/运行时区块/托管网关/项目
// 目录/头像/启停按钮等详情渲染，toggleAgentEditMode 字段保存，以及创建弹窗
// 外接 tab 的 CLI 默认值跟踪（_extActiveCli/_applyExternalCliDefaults，创建
// 侧 agents-create.js 会写入这些状态）。
// 依赖 agents.js 的模块态与工具（_agentsCache、_selectedAgent、_agentEditing、
// loadAgents 等）：classic <script> 共享全局词法环境，本文件必须排在
// agents.js 之后加载（顺序见 index.html）。

// Render the header meta strip for a single agent / skill detail. Custom items
// mount an editable category select beside these static chips.
function _renderSourceMetaHtml(item) {
  if (!item) return '';
  if (_isCommanderAgent(item)) return '';
  const parts = [];
  if (item.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(item.version));
    parts.push(`<span class="agents-detail-source is-version">${escapeHtml(versionLabel)}</span>`);
  }
  if (_agentSource(item.source) !== 'custom') {
    const lang = (typeof getLang === 'function') ? getLang() : 'en';
    const label = _resolveCategoryLabel(item.category, lang);
    parts.push(`<span class="agents-detail-source is-category">${escapeHtml(label)}</span>`);
  }
  return parts.join('');
}

async function _detailCategoryOptions(currentValue = '') {
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const canonical = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  const stateCats = (typeof _mpState !== 'undefined' && Array.isArray(_mpState?.categories)) ? _mpState.categories : [];
  const cacheCats = (typeof _mpCategoriesCache !== 'undefined' && Array.isArray(_mpCategoriesCache)) ? _mpCategoriesCache : [];
  let categories = stateCats.length ? stateCats : cacheCats;
  if (!categories.length && typeof window !== 'undefined' && window.cogseed?.invoke) {
    try {
      const res = await window.cogseed.invoke('marketplace.categories', { local_only: true });
      const list = Array.isArray(res?.list) ? res.list : [];
      if (list.length) {
        categories = list;
        if (typeof _mpCategoriesCache !== 'undefined') _mpCategoriesCache = list;
        if (typeof _mpState !== 'undefined' && _mpState) _mpState.categories = list;
        if (typeof _mpPersistCategoriesCache === 'function') _mpPersistCategoriesCache(list);
      }
    } catch (_) {
      // The current value / General fallback below keeps the control usable.
    }
  }

  const seen = new Set();
  const options = [];
  for (const category of categories) {
    const code = canonical(category && category.code);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    options.push({
      value: code,
      label: (typeof pickLocalizedName === 'function' ? pickLocalizedName(category, lang) : '') || code,
    });
  }

  const current = canonical(currentValue || 'general') || 'general';
  if (current && !seen.has(current)) {
    options.unshift({
      value: current,
      label: _resolveCategoryLabel(current, lang) || current,
    });
    seen.add(current);
  }
  if (!options.length) options.push({ value: 'general', label: _generalCategoryLabel(lang) });
  return options;
}

async function _mountDetailCategorySelect(host, { value = 'general', onChange, readonly = false } = {}) {
  if (!host) return null;
  const current = (typeof _mpCanonicalCategoryCode === 'function')
    ? _mpCanonicalCategoryCode(value || 'general')
    : String(value || 'general').trim();
  const mount = document.createElement('div');
  mount.className = 'ai-select detail-category-select';
  host.appendChild(mount);
  const options = await _detailCategoryOptions(current);
  let api;
  api = _aiSelectMount(mount, {
    options,
    value: current || 'general',
    onChange: async (nextValue) => {
      if (readonly) {
        api.setValue(current || 'general');
        return;
      }
      if (typeof onChange === 'function') await onChange(nextValue || 'general', api);
    },
  });
  if (readonly) {
    mount.classList.add('is-readonly');
    const trigger = mount.querySelector('.ai-select-trigger');
    if (trigger) {
      trigger.setAttribute('disabled', '');
      trigger.setAttribute('aria-disabled', 'true');
    }
  }
  return api;
}

function _renderAgentHeaderCategory(agent) {
  const sourceEl = document.getElementById('agents-detail-source');
  if (!sourceEl || _isCommanderAgent(agent) || _agentSource(agent?.source) !== 'custom') return;
  const agentId = agent?.agent_id;
  const isMock = _isAgentProfileMock(agent);
  _mountDetailCategorySelect(sourceEl, {
    value: agent?.category || 'general',
    readonly: isMock,
    onChange: async (category, api) => {
      try {
        const res = await window.cogseed.invoke('agents.update', {
          agent_id: agentId,
          updates: { category: category || 'general' },
        });
        if (!res || !res.ok) {
          api.setValue(agent?.category || 'general');
          uiAlert((res && res.error) || t('agents.update_failed'));
          return;
        }
        agent.category = res.agent?.category || category || 'general';
        await loadAgents(true);
        if (_selectedAgent?.id === agentId && !_agentEditing) await selectAgent(agentId);
      } catch (err) {
        api.setValue(agent?.category || 'general');
        uiAlert((err && err.message) || t('agents.update_failed'));
      }
    },
  }).catch((err) => _agentsLog.warn('render agent category select failed', err));
}

function _agentProfileChipHtml(text, extraClass) {
  return text ? `<span class="agents-profile-chip${extraClass ? ' ' + extraClass : ''}">${escapeHtml(text)}</span>` : '';
}

function _agentDetailListIconHtml(kind) {
  if (kind === 'memory') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="M7 4.5h10a1.5 1.5 0 0 1 1.5 1.5v14l-6.5-3.6L5.5 20V6A1.5 1.5 0 0 1 7 4.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
  }
  if (kind === 'standard') {
    return '<svg viewBox="0 0 24 24" fill="none"><path d="m5 12 4.2 4.2L19 6.8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  return '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
}

function _agentMemoryListItemHtml(text, editable) {
  if (!text) return '';
  const removeTitle = _agentLabel('agents.memory_remove', '删除记忆', 'Remove memory', 'メモリを削除');
  const editTitle = _agentLabel('agents.memory_edit', '修改记忆', 'Edit memory', 'メモリを編集');
  return `
    <div class="agents-detail-list-item">
      <span class="agents-detail-list-icon is-memory" aria-hidden="true">${_agentDetailListIconHtml('memory')}</span>
      ${editable
        ? `<button type="button" class="agents-detail-list-text is-action" data-agent-memory-edit="${escapeHtml(text)}" title="${escapeHtml(editTitle)}">${escapeHtml(text)}</button>`
        : `<span class="agents-detail-list-text">${escapeHtml(text)}</span>`}
      ${editable ? `<button type="button" class="agents-memory-chip-remove" data-agent-memory-remove="${escapeHtml(text)}" title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}">×</button>` : ''}
    </div>
  `;
}

function _agentEditableListItemHtml(text, index, key) {
  if (!text) return '';
  const editTitle = _agentLabel('agents.tag_edit', '修改', 'Edit', '編集');
  const removeTitle = _agentLabel('agents.tag_remove', '删除', 'Remove', '削除');
  const iconKind = key === 'standards' ? 'standard' : 'ability';
  return `
    <div class="agents-detail-list-item">
      <span class="agents-detail-list-icon is-${escapeHtml(iconKind)}" aria-hidden="true">${_agentDetailListIconHtml(iconKind)}</span>
      <button type="button" class="agents-detail-list-text is-action" data-agent-list-edit="${escapeHtml(key)}" data-agent-list-index="${index}" title="${escapeHtml(editTitle)}">${escapeHtml(text)}</button>
      <button type="button" class="agents-memory-chip-remove" data-agent-list-remove="${escapeHtml(key)}" data-agent-list-index="${index}" title="${escapeHtml(removeTitle)}" aria-label="${escapeHtml(removeTitle)}">×</button>
    </div>
  `;
}

function _agentReadonlyListItemHtml(text, key) {
  if (!text) return '';
  const iconKind = key === 'standards' ? 'standard' : 'ability';
  return `
    <div class="agents-detail-list-item">
      <span class="agents-detail-list-icon is-${escapeHtml(iconKind)}" aria-hidden="true">${_agentDetailListIconHtml(iconKind)}</span>
      <span class="agents-detail-list-text">${escapeHtml(text)}</span>
    </div>
  `;
}

function _agentWorkflowMarkdown(steps) {
  if (!steps.length) return '';
  return steps.map((step, idx) => {
    const title = normalizeDisplayText(step.title || step.description);
    const desc = normalizeDisplayText(step.description);
    const tool = normalizeDisplayText(step.tool);
    const line = `${idx + 1}. ${title}${tool ? `（${tool}）` : ''}`;
    return desc && desc !== title ? `${line}\n${desc}` : line;
  }).join('\n\n');
}

function _agentProfileEntryTags(entries) {
  return entries
    .map((entry) => entry.title || entry.description)
    .map(normalizeDisplayText)
    .filter(Boolean);
}

function _agentTextList(agent, key) {
  return _agentProfileEntryTags(_agentProfileEntries(_agentProfile(agent)[key])).slice(0, 20);
}

function _canEditAgentDefinition(agent) {
  const source = _agentSource(agent && agent.source);
  return !!agent && !_isAgentProfileMock(agent)
    && source === 'custom';
}

function _canEditAgentMemory(agent) {
  const source = _agentSource(agent && agent.source);
  return !!agent
    && !_isAgentProfileMock(agent)
    && !_isExternalCliAgent(agent)
    && (_isCommanderAgent(agent) || source === 'custom' || _isAgentPlatformSource(source));
}

function _canEnterAgentEditMode(agent) {
  return _isCommanderAgent(agent) || _canEditAgentDefinition(agent) || _canEditAgentMemory(agent);
}

async function _saveAgentTextList(agent, key, values) {
  if (!agent || !_canEditAgentDefinition(agent)) return false;
  const clean = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const text = normalizeDisplayText(raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    clean.push(text);
    if (clean.length >= 20) break;
  }
  try {
    const res = await window.cogseed.invoke('agents.update', {
      agent_id: agent.agent_id,
      updates: { [key]: clean },
    });
    if (!res || !res.ok) {
      await uiAlert((res && res.error) || t('agents.update_failed'));
      return false;
    }
    await loadAgents(true);
    await _refreshAgentDetail(agent.agent_id);
    return true;
  } catch (err) {
    await uiAlert((err && err.message) || t('agents.update_failed'));
    return false;
  }
}

async function _refreshAgentDetail(agentId) {
  if (!agentId) return;
  if (_isCommanderAgent(agentId)) {
    await _renderCommanderAgentDetail(!!_agentEditing);
    return;
  }
  const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
  const data = await res.json();
  if (!data.ok || !data.agent) return;
  data.agent.source = _agentSource(data.agent.source);
  await _maybeLoadAgentSkillNames(_agentSkillIds(data.agent), data.agent.agent_id, { refresh: false });
  _selectedAgent = { id: data.agent.agent_id, name: data.agent.name, source: data.agent.source };
  _renderAgentDetail(data.agent, !!_agentEditing);
}

async function _promptAgentTextListValue(kind, current = '') {
  const label = kind === 'standards'
    ? _agentLabel(
        'agents.standard_prompt',
        '输入交付标准：明确可验收的预期结果',
        'Enter a delivery standard: an expected, verifiable result',
        '納品基準を入力：検証できる期待結果',
      )
    : _agentLabel('agents.knowhow_prompt', '输入擅长点', 'Enter know-how', '得意分野を入力');
  const value = typeof uiPrompt === 'function'
    ? await uiPrompt(label, current)
    : window.prompt(label, current);
  return normalizeDisplayText(value);
}

function _renderEditableTagList(host, agent, key, tags, editing) {
  const canEdit = !!editing && _canEditAgentDefinition(agent);
  if (!host) return;
  host.innerHTML = canEdit
    ? tags.map((tag, idx) => _agentEditableListItemHtml(tag, idx, key)).join('')
    : tags.map((tag) => _agentReadonlyListItemHtml(tag, key)).join('');
  if (!canEdit) return;
  host.querySelectorAll('[data-agent-list-edit]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-agent-list-index'));
      if (!Number.isInteger(idx) || idx < 0 || idx >= tags.length) return;
      const next = await _promptAgentTextListValue(key, tags[idx]);
      if (!next || next === tags[idx]) return;
      const values = tags.slice();
      values[idx] = next;
      await _saveAgentTextList(agent, key, values);
    });
  });
  host.querySelectorAll('[data-agent-list-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-agent-list-index'));
      if (!Number.isInteger(idx) || idx < 0 || idx >= tags.length) return;
      const ok = typeof uiConfirm === 'function'
        ? await uiConfirm({
            message: _agentLabel('agents.tag_remove_confirm', '确认删除这一项？', 'Remove this item?', 'この項目を削除しますか？'),
            okLabel: _agentLabel('agents.memory_remove_ok', '删除', 'Delete', '削除'),
            cancelLabel: _agentLabel('common.cancel', '取消', 'Cancel', 'キャンセル'),
          })
        : false;
      if (!ok) return;
      const values = tags.filter((_, i) => i !== idx);
      await _saveAgentTextList(agent, key, values);
    });
  });
}

function _mountAgentListAddButton(section, agent, key, tags, editing) {
  const title = section?.querySelector('.agents-detail-label, .agents-detail-subtitle');
  if (!title) return;
  title.querySelector('[data-agent-list-add]')?.remove();
  if (!editing || !_canEditAgentDefinition(agent)) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'agents-memory-add';
  btn.dataset.agentListAdd = key;
  btn.textContent = _agentLabel('agents.tag_add', '添加', 'Add', '追加');
  title.appendChild(btn);
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    const next = await _promptAgentTextListValue(key, '');
    if (!next) return;
    await _saveAgentTextList(agent, key, [...tags, next]);
  });
}

function _agentInputRefs(agent) {
  const cleanInputTitle = (value) => normalizeDisplayText(value)
    .replace(/\s*[（(]\s*(可选|选填|optional)\s*[）)]\s*$/i, '')
    .replace(/\s*[（(]\s*(必填|required)\s*[）)]\s*$/i, '')
    .trim();
  return Array.isArray(agent.inputs)
    ? agent.inputs.map((input) => ({
        title: cleanInputTitle(input.label || input.id || ''),
        description: normalizeDisplayText(input.description || input.type || ''),
        required: input.required === true,
      })).filter((input) => input.title)
    : [];
}

function _agentInputChipHtml(input) {
  if (!input || !input.title) return '';
  const state = input.required
    ? _agentLabel('agents.input_required', '必填', 'Required', '必須')
    : _agentLabel('agents.input_optional', '可选', 'Optional', '任意');
  return `
    <span class="agents-profile-chip agents-input-chip" title="${escapeHtml(input.description || '')}">
      <span>${escapeHtml(input.title)}</span>
      <small>${escapeHtml(state)}</small>
    </span>
  `;
}

function _renderAgentDetailStats(agent, editing = false) {
  const section = document.getElementById('agents-detail-stats-section');
  const host = document.getElementById('agents-detail-stats');
  if (!host) return;
  const runtime = _agentRuntimeStats(agent);
  if (runtime.deliveries <= 0) {
    if (section) section.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  const stats = _agentDetailStats(agent).slice(0, 4);
  if (section) section.style.display = stats.length ? '' : 'none';
  const statsHtml = stats.map((s) => `
    <div class="agents-detail-stat${s.kind === 'memory' ? ' is-memory' : ''}">
      <div class="agents-detail-stat-value">${escapeHtml(s.value)}${s.unit ? `<small>${escapeHtml(s.unit)}</small>` : ''}</div>
      <div class="agents-detail-stat-label">${escapeHtml(s.key)}</div>
    </div>
  `).join('');
  host.innerHTML = statsHtml;
}

function _renderAgentDetailMemory(agent, editing = false) {
  const section = document.getElementById('agents-detail-memory-section');
  const host = document.getElementById('agents-detail-memory');
  if (!section || !host) return;
  if (_isExternalCliAgent(agent)) {
    section.style.display = 'none';
    host.innerHTML = '';
    section.querySelector('[data-agent-memory-add]')?.remove();
    return;
  }
  const memoryTags = _agentMemoryEntries(agent)
    .map((entry) => entry.title || entry.description)
    .filter(Boolean)
    .slice(0, 20);
  const canEditMemory = !!editing && _canEditAgentMemory(agent);
  section.style.display = (memoryTags.length || canEditMemory) ? '' : 'none';
  section.querySelector('[data-agent-memory-add]')?.remove();
  const title = section.querySelector('.agents-detail-label');
  if (title && canEditMemory) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'agents-memory-add';
    btn.dataset.agentMemoryAdd = '';
    btn.textContent = _agentLabel('agents.memory_add', '添加', 'Add', '追加');
    title.appendChild(btn);
  }
  host.innerHTML = memoryTags.map((tag) => _agentMemoryListItemHtml(tag, canEditMemory)).join('');
  if (canEditMemory) _wireAgentMemoryControls(section, agent);
}

async function _agentMemoryAdd(agent, text) {
  if (_isCommanderAgent(agent)) {
    return window.cogseed.invoke('memory.add', { target: 'agent', agentId: _COMMANDER_AGENT_ID, content: text });
  }
  return window.cogseed.invoke('agents.memory.add', { agent_id: agent.agent_id, content: text });
}

async function _agentMemoryUpdate(agent, oldText, text) {
  if (_isCommanderAgent(agent)) {
    return window.cogseed.invoke('memory.replace', { target: 'agent', agentId: _COMMANDER_AGENT_ID, oldText, content: text });
  }
  return window.cogseed.invoke('agents.memory.update', { agent_id: agent.agent_id, old_text: oldText, content: text });
}

async function _agentMemoryRemove(agent, text) {
  if (_isCommanderAgent(agent)) {
    return window.cogseed.invoke('memory.remove', { target: 'agent', agentId: _COMMANDER_AGENT_ID, oldText: text });
  }
  return window.cogseed.invoke('agents.memory.remove', { agent_id: agent.agent_id, old_text: text });
}

function _wireAgentMemoryControls(host, agent) {
  host.querySelectorAll('[data-agent-memory-add]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const label = _agentLabel('agents.memory_add_prompt', '请输入要添加的记忆', 'Enter memory to add', '追加するメモリを入力');
      const content = typeof uiPrompt === 'function'
        ? await uiPrompt(label, '')
        : window.prompt(label, '');
      const text = (content || '').trim();
      if (!text) return;
      try {
        const res = await _agentMemoryAdd(agent, text);
        if (!res || res.ok === false) {
          uiAlert((res && res.error) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
          return;
        }
        await loadAgents(true);
        await _refreshAgentDetail(agent.agent_id);
      } catch (err) {
        uiAlert((err && err.message) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
      }
    });
  });
  host.querySelectorAll('[data-agent-memory-edit]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const oldText = btn.getAttribute('data-agent-memory-edit') || '';
      if (!oldText) return;
      const label = _agentLabel('agents.memory_edit_prompt', '修改记忆', 'Edit memory', 'メモリを編集');
      const content = typeof uiPrompt === 'function'
        ? await uiPrompt(label, oldText)
        : window.prompt(label, oldText);
      const text = (content || '').trim();
      if (!text || text === oldText) return;
      try {
        const res = await _agentMemoryUpdate(agent, oldText, text);
        if (!res || res.ok === false) {
          uiAlert((res && res.error) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
          return;
        }
        await loadAgents(true);
        await _refreshAgentDetail(agent.agent_id);
      } catch (err) {
        uiAlert((err && err.message) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
      }
    });
  });
  host.querySelectorAll('[data-agent-memory-remove]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const text = btn.getAttribute('data-agent-memory-remove') || '';
      if (!text) return;
      const confirmText = _agentLabel('agents.memory_remove_confirm', '确认删除这条记忆？', 'Remove this memory?', 'このメモリを削除しますか？');
      const ok = typeof uiConfirm === 'function'
        ? await uiConfirm({
            message: confirmText,
            okLabel: _agentLabel('agents.memory_remove_ok', '删除', 'Delete', '削除'),
            cancelLabel: _agentLabel('common.cancel', '取消', 'Cancel', 'キャンセル'),
          })
        : false;
      if (!ok) return;
      try {
        const res = await _agentMemoryRemove(agent, text);
        if (!res || res.ok === false) {
          uiAlert((res && res.error) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
          return;
        }
        await loadAgents(true);
        await _refreshAgentDetail(agent.agent_id);
      } catch (err) {
        uiAlert((err && err.message) || _agentLabel('agents.memory_update_failed', '记忆更新失败', 'Memory update failed', 'メモリ更新に失敗しました'));
      }
    });
  });
}

function _renderAgentDetailKnowhow(agent, editing = false) {
  const section = document.getElementById('agents-detail-knowhow-section');
  const host = document.getElementById('agents-detail-knowhow');
  if (!section || !host) return;
  if (_isExternalCliAgent(agent)) {
    section.style.display = 'none';
    host.innerHTML = '';
    _mountAgentListAddButton(section, agent, 'knowhow', [], false);
    return;
  }
  const tags = _agentTextList(agent, 'knowhow');
  const canEdit = !!editing && _canEditAgentDefinition(agent);
  section.style.display = (tags.length || canEdit) ? '' : 'none';
  _mountAgentListAddButton(section, agent, 'knowhow', tags, editing);
  _renderEditableTagList(host, agent, 'knowhow', tags, editing);
}

/** 一条资产没被继承的原因，翻成用户能懂的话。
 *
 *  `user_excluded` 单独一档：那是人做的决定，其余五档是系统按资产状态判的。
 *  两者混在一起显示，用户就没法回答「是我当初勾掉的，还是它自己失效了」。 */
function _inheritanceExclusionLabel(reason) {
  switch (reason) {
    case 'user_excluded':
      return _agentLabel('agents.inheritance_excluded_user', '你在创建时勾掉了', 'You unchecked it at creation', '作成時にあなたが外しました');
    case 'paused':
      return _agentLabel('agents.inheritance_excluded_paused', '当时已暂停', 'Paused at the time', '当時は一時停止中');
    case 'archived':
      return _agentLabel('agents.inheritance_excluded_archived', '当时已归档', 'Archived at the time', '当時はアーカイブ済み');
    case 'revoked':
      return _agentLabel('agents.inheritance_excluded_revoked', '当时已撤销', 'Revoked at the time', '当時は取り消し済み');
    case 'deleted':
      return _agentLabel('agents.inheritance_excluded_deleted', '当时已删除', 'Deleted at the time', '当時は削除済み');
    case 'purged':
      return _agentLabel('agents.inheritance_excluded_purged', '当时已彻底清除', 'Purged at the time', '当時は完全消去済み');
    default:
      return reason;
  }
}

function _inheritanceItemHtml(title, meta, { excludedByUser = false } = {}) {
  return `
    <div class="agents-detail-list-item">
      <div class="agents-detail-list-main">
        <span class="agents-detail-list-text">${escapeHtml(title)}</span>
        <span class="agents-detail-list-meta${excludedByUser ? ' is-user-choice' : ''}">${escapeHtml(meta)}</span>
      </div>
    </div>
  `;
}

/**
 * 「出生时继承了什么」。
 *
 * **两种空必须分开说。** `inheritance === null` 表示这个 Agent 生成的时候还没有
 * 继承机制——它不是「没继承到东西」，是这个问题当时根本不存在。把两者都渲染成
 * 一句「没有继承任何认知」，用户会以为自己教过的东西丢了。
 */
async function _renderAgentDetailInheritance(agent) {
  const section = document.getElementById('agents-detail-inheritance-section');
  const host = document.getElementById('agents-detail-inheritance');
  if (!section || !host) return;
  const agentId = String(agent?.agent_id || '');
  if (!agentId || _isCommanderAgent(agent)) {
    section.style.display = 'none';
    host.innerHTML = '';
    return;
  }

  let inheritance = null;
  let assetTitles = new Map();
  try {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/inheritance`);
    const data = await res.json();
    if (!data.ok) throw new Error('inheritance unavailable');
    inheritance = data.inheritance;
    if (inheritance) {
      // 继承记录只存引用，标题要另取——取不到就退回显示 id，而不是空着。
      // recall 频道在渲染层一律直接 invoke（与 skills.js 一致），不走 apiFetch。
      const list = await window.cogseed.invoke('recall.assets.list').catch(() => null);
      assetTitles = new Map((list?.assets || []).map((a) => [a.id, a.title]));
    }
  } catch {
    section.style.display = 'none';
    host.innerHTML = '';
    return;
  }

  // 异步返回期间用户可能已经切走了，别把结果画到别人的详情页上。
  if (!_selectedAgent || _selectedAgent.id !== agentId) return;

  section.style.display = '';

  if (!inheritance) {
    host.innerHTML = `<p class="agents-detail-placeholder">${escapeHtml(_agentLabel(
      'agents.inheritance_none_recorded',
      '这个智能体创建时还没有继承机制，所以没有出生记录——不是它没继承到东西。',
      'This agent was created before inheritance was recorded, so there is no record of its creation — that is not the same as inheriting nothing.',
      'このエージェントは継承の記録が始まる前に作成されたため、作成時の記録がありません（何も継承しなかったという意味ではありません）。',
    ))}</p>`;
    return;
  }

  const inherited = Array.isArray(inheritance.inheritedAssets) ? inheritance.inheritedAssets : [];
  const excluded = Array.isArray(inheritance.excludedAssets) ? inheritance.excludedAssets : [];

  const inheritedHtml = inherited.map((ref) => _inheritanceItemHtml(
    assetTitles.get(ref.asset_id) || ref.asset_id,
    `v${ref.version}`,
  )).join('');

  const excludedHtml = excluded.map((entry) => _inheritanceItemHtml(
    assetTitles.get(entry.assetId) || entry.assetId,
    _inheritanceExclusionLabel(entry.reason),
    { excludedByUser: entry.reason === 'user_excluded' },
  )).join('');

  const emptyHtml = inherited.length ? '' : `<p class="agents-detail-placeholder">${escapeHtml(_agentLabel(
    'agents.inheritance_empty',
    '创建时没有可继承的认知资产。',
    'There was no cognition available to inherit when this agent was created.',
    '作成時に継承できる認知資産がありませんでした。',
  ))}</p>`;

  const excludedTitle = excluded.length ? `<div class="agents-detail-label is-sub">${escapeHtml(_agentLabel(
    'agents.inheritance_excluded_label',
    '没有带走的',
    'Not carried over',
    '引き継がなかったもの',
  ))}</div>` : '';

  host.innerHTML = `${emptyHtml}${inheritedHtml}${excludedTitle}${excludedHtml}`;
}

function _renderAgentDetail(agent, editing) {
  agent = { ...agent, source: _agentSource(agent.source) };
  const isCommander = _isCommanderAgent(agent);
  document.getElementById('agents-detail-content').style.display = '';

  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  const sourceEl = document.getElementById('agents-detail-source');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  const editBtn = document.getElementById('agent-edit-btn');

  const lang = getLang();
  nameEl.textContent = agent.name || '';
  if (nameInput) nameInput.value = agent.name || '';
  // Header chips: custom items mount an editable category dropdown;
  // marketplace-installed items show version + category as static chips.
  sourceEl.className = 'agents-detail-source-row';
  sourceEl.innerHTML = _renderSourceMetaHtml(agent);
  _renderAgentHeaderCategory(agent);
  // Runtime slot lives at the top of the body now (not the header):
  // an always-editable dropdown so the user can flip CogSeed ↔ local CLI
  // without entering edit mode. The header chip was removed because
  // it duplicated information the dropdown already exposes.
  _renderAgentDetailRuntime(agent);
  _renderAgentDetailExecDefaults(agent);
  _renderAgentDetailProjectDir(agent);
  void _renderAgentDetailGateway(agent);
  const localizedDesc = _agentSummary(agent, lang);
  descEl.textContent = localizedDesc;
  descEl.classList.toggle('is-empty', !localizedDesc);

  _renderAgentDetailAvatar(agent);
  _renderAgentDetailStats(agent, editing);
  _renderAgentDetailMemory(agent, editing);
  _renderAgentDetailKnowhow(agent, editing);
  // 异步：要读出生快照与资产标题。失败就把整段藏起来，不占位。
  void _renderAgentDetailInheritance(agent);

  // CLI-backed agents have no authored workflow / skill_list — the
  // external CLI brings its own behavior. Hide the entire workflow
  // section so the detail page doesn't show an empty editor block.
  const workflowSection = document.querySelector('.agents-detail-section-workflow');
  // R1：外接判定统一走 _isExternalCliAgent（legacy 'cli' kind 半边恒假已删）。
  const isCliRuntime = _isExternalCliAgent(agent);
  const structuredWorkflow = _agentWorkflowSteps(agent);
  const hasWorkflowToShow = structuredWorkflow.length || !!String(agent.workflow || '').trim();
  if (workflowSection) workflowSection.style.display = (isCliRuntime && !hasWorkflowToShow) ? 'none' : '';

  const unsetHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset'))}</span>`;
  // Workflow renders markdown in readonly mode; raw text in edit mode so user
  // can edit source directly.
  if (editing && !isCommander) {
    workflowEl.textContent = agent.workflow || '';
  } else {
    const workflowMarkdown = structuredWorkflow.length
      ? _agentWorkflowMarkdown(structuredWorkflow)
      : String(agent.workflow || '').trim();
    workflowEl.innerHTML = workflowMarkdown ? renderMarkdownFull(workflowMarkdown) : unsetHtml;
  }
  if (!editing && !localizedDesc) descEl.innerHTML = unsetHtml;

  // Detail header actions, fixed order:
  //   use (icon) / edit / enable-disable / delete
  // Edit mode hides everything except the "done" button (the relabeled
  // "edit" button).
  const useBtn = document.getElementById('agent-use-btn');
  const manageBtn = document.getElementById('agent-manage-btn');
  const enableBtn = document.getElementById('agent-enabled-btn');
  const uploadBtn = document.getElementById('agent-upload-marketplace-btn');
  const delBtn = document.getElementById('agent-delete-btn');
  const isMock = _isAgentProfileMock(agent);
  const isCustom = agent.source === 'custom' && !isMock;
  const canEditDefinition = !isMock && isCustom;
  const canEdit = isCommander || canEditDefinition || _canEditAgentMemory(agent);
  if (useBtn) {
    useBtn.style.display = editing ? 'none' : '';
    useBtn.disabled = isMock || agent.enabled === false;
    useBtn.setAttribute('aria-disabled', (isMock || agent.enabled === false) ? 'true' : 'false');
  }
  if (manageBtn) {
    const canManage = agent.management_surface === 'expense_workbench'
      && agent.reimbursement_entry_role === 'canonical';
    manageBtn.hidden = editing || !canManage;
    manageBtn.disabled = editing || !canManage || agent.enabled === false;
    manageBtn.setAttribute('aria-hidden', (!canManage || editing) ? 'true' : 'false');
    if (canManage && agent.agent_id) manageBtn.setAttribute('data-expense-agent-id', agent.agent_id);
    else manageBtn.removeAttribute('data-expense-agent-id');
  }
  if (enableBtn && isCommander) {
    enableBtn.style.display = 'none';
    enableBtn.disabled = true;
  } else if (enableBtn && isMock) {
    enableBtn.style.display = editing ? 'none' : '';
    enableBtn.disabled = true;
    enableBtn.textContent = t('component.disable');
  } else if (enableBtn) {
    enableBtn.style.display = editing ? 'none' : '';
    enableBtn.disabled = false;
  }
  // Upload button visibility: gated by marketplace_dev.js's presence (the open-source build lacks it).
  if (uploadBtn) {
    uploadBtn.style.display = isCommander
      ? 'none'
      : (isMock ? (editing ? 'none' : '') : ((typeof openMarketplaceUpload === 'function' && !editing) ? '' : 'none'));
    uploadBtn.disabled = isCommander || isMock;
  }
  if (delBtn) {
    delBtn.style.display = (!isCommander && (canEditDefinition || isMock) && !editing) ? '' : 'none';
    delBtn.disabled = isCommander || isMock;
  }
  if (editBtn) {
    editBtn.style.display = (canEdit || isMock) ? '' : 'none';
    editBtn.disabled = isMock && !isCommander;
    editBtn.textContent = editing ? t('agents.edit_btn_done') : t('agents.edit_btn_edit');
  }
  if (!isMock && !isCommander) _renderAgentEnabledButton({ id: agent.agent_id, enabled: agent.enabled !== false });

  _renderAgentOutputFormatSection(agent, editing);

  _toggleAgentFieldEditable(editing && !isCommander);
}

/** Render the output-format preference dropdown (auto / text /
 *  dashboard / artifact). Always editable (no edit-mode gating — same convention as the
 *  runtime selector); persists via `agents.update({ output_format })`. Hidden
 *  for CLI agents — those run an external coding CLI and ignore the in-process
 *  system-prompt hint entirely.
 *
 *  Legacy on-disk values map for display: `'markdown_only'` → `'text'`,
 *  `'allow_artifacts'` → `'artifact'`; `'auto'` / missing → `'auto'`
 *  (the default). */
function _renderAgentOutputFormatSection(agent, editing = false) {
  const section = document.getElementById('agents-detail-input-output-section');
  const slot = document.getElementById('agents-detail-output-format');
  const standardsSection = document.getElementById('agents-detail-output-standards-section');
  const standardsHost = document.getElementById('agents-detail-output-standards');
  const formatSection = document.getElementById('agents-detail-output-format-control');
  const inputRow = document.getElementById('agents-detail-inputs-row');
  const inputHost = document.getElementById('agents-detail-inputs');
  if (!section || !slot) return;
  const isCommander = _isCommanderAgent(agent);
  const isExternalCli = _isExternalCliAgent(agent);
  const standardTags = (isExternalCli) ? [] : _agentTextList(agent, 'standards');
  const isMock = _isAgentProfileMock(agent);
  const canShowFormatControl = !isExternalCli && !isCommander;
  const canEditStandards = !isExternalCli && !isCommander && !!editing && _canEditAgentDefinition(agent);
  const inputRefs = (isExternalCli || isCommander) ? [] : _agentInputRefs(agent);

  if (standardsSection && standardsHost) {
    standardsSection.style.display = (standardTags.length || canEditStandards) ? '' : 'none';
    _mountAgentListAddButton(standardsSection, agent, 'standards', standardTags, editing);
    _renderEditableTagList(standardsHost, agent, 'standards', standardTags, editing);
  }
  if (inputRow && inputHost) {
    inputRow.style.display = inputRefs.length ? '' : 'none';
    inputHost.innerHTML = inputRefs.map(_agentInputChipHtml).join('');
  }
  if (formatSection) formatSection.style.display = canShowFormatControl ? '' : 'none';
  if (!inputRefs.length && !canShowFormatControl) {
    section.style.display = 'none';
    slot.innerHTML = '';
    return;
  }
  section.style.display = '';
  if (!canShowFormatControl) {
    slot.innerHTML = '';
    return;
  }

  const canEdit = !isMock && agent.source === 'custom';

  slot.innerHTML = '';
  const mount = document.createElement('div');
  mount.className = 'ai-select';
  slot.appendChild(mount);

  const options = [
    { value: 'auto',           label: t('agents.output_format_auto'),          hint: t('agents.output_format_auto_hint') },
    { value: 'text',           label: t('agents.output_format_text'),          hint: t('agents.output_format_text_hint') },
    { value: 'dashboard',      label: t('agents.output_format_dashboard'),     hint: t('agents.output_format_dashboard_hint') },
    { value: 'artifact',       label: t('agents.output_format_artifact'),      hint: t('agents.output_format_artifact_hint') },
  ];
  // Map legacy on-disk values to the current 4-option display.
  let current;
  switch (agent.output_format) {
    case 'auto':                                current = 'auto';          break;
    case 'text':
    case 'markdown_only':                       current = 'text';          break;
    case 'dashboard':                           current = 'dashboard';     break;
    case 'artifact':
    case 'allow_artifacts':                     current = 'artifact';      break;
    default:                                    current = 'auto';          break;
  }

  const api = _aiSelectMount(mount, {
    options,
    value: current,
    onChange: async (val) => {
      try {
        const res = await window.cogseed.invoke('agents.update', {
          agent_id: agent.agent_id,
          updates: { output_format: val },
        });
        if (!res || !res.ok) {
          api.setValue(current);
          uiAlert((res && res.error) || t('agents.update_failed'));
        } else if (res.agent) {
          agent.output_format = res.agent.output_format;
          current = val;
        }
      } catch (err) {
        api.setValue(current);
        uiAlert((err && err.message) || t('agents.update_failed'));
      }
    },
  });
  if (!canEdit) {
    // Disable the trigger — read-only display for builtin agents in
    // non-dev mode (mirrors the runtime row pattern).
    const trigger = mount.querySelector('.ai-select-trigger');
    if (trigger) { trigger.setAttribute('disabled', ''); trigger.style.pointerEvents = 'none'; trigger.style.opacity = '0.6'; }
  }
}


/** Render the runtime control in the detail body.
 *
 *  The runtime "kind" is locked at create time:
 *  - `in_process` (CogSeed) agents → never show the selector here. The
 *    runtime row stays hidden; user has no need to see it.
 *  - `cli` agents → show a selector with **CLI options only** (no
 *    CogSeed / in_process option). User can swap which CLI backs the
 *    agent at any time, but can't revert to CogSeed — that would
 *    invalidate the description and inputs which were authored
 *    specifically for a CLI runtime.
 *
 *  Reuses `_aiSelectMount` (see CLAUDE.md "Reuse UI components") and
 *  persists each change via `agents.update({ runtime })`. */
async function _renderAgentDetailRuntime(agent) {
  const section = document.getElementById('agents-detail-runtime-section');
  const slot = document.getElementById('agents-detail-runtime');
  if (!slot || !section) return;
  slot.innerHTML = '';

  // In-process agents: section stays hidden. No selector, no
  // information to surface.
  if (agent.runtime?.kind !== 'cli') {
    section.style.display = 'none';
    return;
  }

  // Re-probe when the detail selector is rendered. A CLI can be installed
  // while CogSeed is already open, and the renderer cache otherwise keeps the
  // old missing result indefinitely.
  const entries = (typeof loadLocalCliEntries === 'function')
    ? await loadLocalCliEntries({ force: true })
    : [];
  const available = entries.filter(e => e.available);
  const seen = new Set(available.map(e => e.type));
  const currentType = agent.runtime.cli;
  const currentEntry = entries.find(e => e.type === currentType);

  // Build CLI-only options: every detected CLI + the bound one if it's
  // missing (with a warning suffix so the user can flip away in one
  // click). CogSeed / in_process is intentionally absent — see fn doc.
  const options = [];
  for (const e of available) {
    options.push({
      value: `cli:${e.type}`,
      label: `${t('agent_modal.runtime_cli_' + e.type)}${e.version ? ` (${e.version})` : ''}`,
    });
  }
  if (!seen.has(currentType)) {
    const baseLabel = t('agent_modal.runtime_cli_' + currentType);
    const labelText = (baseLabel && baseLabel !== 'agent_modal.runtime_cli_' + currentType)
      ? baseLabel : currentType;
    options.push({
      value: `cli:${currentType}`,
      label: labelText,
      hint: (typeof window.getLocalCliUnavailableHint === 'function')
        ? window.getLocalCliUnavailableHint(currentEntry)
        : t('agent.cli_not_found'),
      iconName: 'warning',
    });
  }
  if (options.length === 0) {
    // Defensive — shouldn't happen since we always add the bound CLI
    // above. Hide the row instead of rendering an empty dropdown.
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const mount = document.createElement('div');
  mount.className = 'ai-select agents-detail-runtime-select';
  slot.appendChild(mount);
  _aiSelectMount(mount, {
    options, value: `cli:${currentType}`,
    onChange: async (next) => {
      const m = /^cli:(.+)$/.exec(next);
      if (!m) return;
      const newCli = m[1];
      // Mirror the create-modal behaviour: if the user's current name /
      // description are still the defaults of the previous CLI (or empty),
      // follow the new CLI's defaults. Otherwise, leave their edits alone.
      const updates = { runtime: { kind: 'p3394-gateway', cli: newCli } };
      const lang = (typeof getLang === 'function') ? getLang() : 'en';
      const prev = (typeof getCliDefaults === 'function') ? getCliDefaults(currentType) : null;
      const next2 = (typeof getCliDefaults === 'function') ? getCliDefaults(newCli) : null;
      const prevDescLocal = prev ? pickDesc(prev, lang) : '';
      const curName = (agent.name || '').trim();
      const curDescLocal = pickDesc(agent, lang).trim();
      // Same default-like detection as the create modal: bare default OR
      // dedup-style "<default> 2" / "(2)" suffixes count as untouched.
      const nameUntouched = _isDefaultlikeName(curName, prev?.name);
      const descUntouched = !curDescLocal || (prev && curDescLocal === prevDescLocal);
      if (next2 && nameUntouched) updates.name = next2.name;
      if (next2) {
        if (descUntouched) {
          updates.description_zh = next2.description_zh;
          updates.description_en = next2.description_en;
        }
      }
      try {
        const res = await window.cogseed.invoke('agents.update', {
          agent_id: agent.agent_id, updates,
        });
        if (res?.ok && res.agent) {
          _agentsCache = null;
          const fetched = await apiFetch(`/api/agents/${encodeURIComponent(agent.agent_id)}`);
          const data = await fetched.json();
          if (data.ok && data.agent) _renderAgentDetail(data.agent, _agentEditing);
        } else if (res?.code === 'E_AGENT_NAME_TAKEN') {
          // Name we tried to auto-apply already belongs to another
          // agent. Re-issue the update without the name override so
          // the runtime swap still goes through.
          const safeUpdates = { ...updates };
          delete safeUpdates.name;
          await window.cogseed.invoke('agents.update', {
            agent_id: agent.agent_id, updates: safeUpdates,
          });
          _agentsCache = null;
          const fetched = await apiFetch(`/api/agents/${encodeURIComponent(agent.agent_id)}`);
          const data = await fetched.json();
          if (data.ok && data.agent) _renderAgentDetail(data.agent, _agentEditing);
        }
      } catch (err) {
        _agentsLog.warn('agents.update runtime failed', err);
      }
    },
  });
}

/** Unified execution entry — per-agent default execution config (in-process
 *  agents only): default model + default thinking strength. Persisted via
 *  `agents.update({ default_model, default_thinking })`; the composer's
 *  exec-config chip shows these as the baseline and layers task overrides
 *  on top without ever writing back here. CLI-backed agents keep their
 *  model binding on `runtime.model` (create modal / runtime section) and
 *  manage their own reasoning — nothing to configure here. */
async function _renderAgentDetailExecDefaults(agent) {
  const section = document.getElementById('agents-detail-exec-defaults-section');
  const slot = document.getElementById('agents-detail-exec-defaults');
  if (!section || !slot) return;
  slot.innerHTML = '';
  // Only in-process custom agents are editable; builtin/marketplace/CLI stay hidden.
  const isCli = _isExternalCliAgent(agent);
  if (isCli || agent.source !== 'custom') {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const FOLLOW_GLOBAL = '__follow_global__';
  const entries = (typeof window.getModelChipEntries === 'function')
    ? window.getModelChipEntries()
    : [];
  // Unique providers from the configured priority entries.
  const providers = [];
  const seenProviders = new Set();
  for (const e of entries) {
    if (e && e.provider && !seenProviders.has(e.provider)) {
      seenProviders.add(e.provider);
      providers.push(e);
    }
  }

  const current = agent.default_model || null;

  slot.innerHTML = `
    <div class="agents-detail-exec-row">
      <span class="agents-detail-exec-key">${escapeHtml(t('agents.exec_default_model'))}</span>
      <span class="ai-select agents-detail-exec-provider"></span>
      <span class="ai-select agents-detail-exec-model"></span>
    </div>
    <div class="agents-detail-exec-row">
      <span class="agents-detail-exec-key">${escapeHtml(t('agents.exec_default_thinking'))}</span>
      <span class="ai-select agents-detail-exec-thinking"></span>
    </div>
    <div class="agents-detail-exec-hint">${escapeHtml(t('agents.exec_defaults_hint'))}</div>
  `;

  const providerMount = slot.querySelector('.agents-detail-exec-provider');
  const modelMount = slot.querySelector('.agents-detail-exec-model');
  const thinkingMount = slot.querySelector('.agents-detail-exec-thinking');

  let modelSel = null;
  const currentProvider = current ? current.provider : '';
  const currentModel = current ? current.model : '';

  const providerOptions = [
    { value: FOLLOW_GLOBAL, label: t('agents.exec_follow_global') },
    ...providers.map((e) => ({ value: e.provider, label: e.providerLabel || e.provider })),
  ];
  const providerSel = _aiSelectMount(providerMount, {
    options: providerOptions,
    value: currentProvider || FOLLOW_GLOBAL,
  });

  const setModelSelect = async (providerId, selectedModel) => {
    if (!modelSel) {
      modelSel = _aiSelectMount(modelMount, { options: [], value: '' });
    }
    if (!providerId) {
      modelSel.setOptions([
        { value: FOLLOW_GLOBAL, label: t('agents.exec_follow_global') },
      ]);
      modelSel.setValue(FOLLOW_GLOBAL);
      return;
    }
    modelSel.setOptions([{ value: '__loading__', label: t('common.loading') }]);
    modelSel.setValue('__loading__');
    let models = [];
    try {
      const res = await window.cogseed.invoke('auth.listModels', { provider: providerId });
      if (res && res.ok && Array.isArray(res.models)) models = res.models;
    } catch (_) { /* keep empty */ }
    const options = models
      .map((m) => (m && typeof m === 'object' ? { value: String(m.id || ''), label: String(m.name || m.id || '') } : null))
      .filter((o) => o && o.value);
    if (!options.length) {
      modelSel.setOptions([{ value: '__none__', label: t('model_chip.no_models') }]);
      modelSel.setValue('__none__');
      return;
    }
    modelSel.setOptions(options);
    modelSel.setValue(options.some((o) => o.value === selectedModel) ? selectedModel : options[0].value);
  };

  const persist = async (updates) => {
    try {
      const res = await window.cogseed.invoke('agents.update', { agent_id: agent.agent_id, updates });
      if (!res || !res.agent) {
        _agentsLog.warn('agents.update exec defaults failed', { error: res && res.error });
        return;
      }
      if (typeof loadAgents === 'function') await loadAgents(true);
    } catch (err) {
      _agentsLog.warn('agents.update exec defaults failed', err);
    }
  };

  providerSel.onChange(async (next) => {
    if (next === FOLLOW_GLOBAL) {
      await persist({ default_model: null });
      await setModelSelect('', '');
      return;
    }
    await setModelSelect(next, '');
  });

  // Model select is lazily mounted by setModelSelect; wire its change handler
  // once via a microtask so `modelSel` is bound.
  setTimeout(() => {
    if (!modelSel) return;
    modelSel.onChange(async (next) => {
      const providerId = providerSel.getValue ? providerSel.getValue() : currentProvider;
      if (!providerId || providerId === FOLLOW_GLOBAL || !next || next === '__none__' || next === '__loading__') return;
      await persist({ default_model: { provider: providerId, model: next } });
    });
  }, 0);

  const thinkingOptions = [
    { value: FOLLOW_GLOBAL, label: t('agents.exec_follow_global') },
    { value: 'off', label: t('model_effort.off') },
    { value: 'low', label: t('model_effort.low') },
    { value: 'high', label: t('model_effort.high') },
  ];
  const thinkingSel = _aiSelectMount(thinkingMount, {
    options: thinkingOptions,
    value: agent.default_thinking || FOLLOW_GLOBAL,
  });
  thinkingSel.onChange(async (next) => {
    if (next === FOLLOW_GLOBAL) await persist({ default_thinking: null });
    else if (next === 'off' || next === 'low' || next === 'high') await persist({ default_thinking: next });
  });

  await setModelSelect(currentProvider, currentModel);
}

/** P3394 外接智能体详情：托管网关运行状态 + 停止/启动按钮。
 *  复用现成 IPC p3394.external.list（返回 running/pid/port）与
 *  p3394.external.start/stop；仅对 runtime.kind==='p3394-gateway' 显示。 */
async function _renderAgentDetailGateway(agent) {
  const section = document.getElementById('agents-detail-gateway-section');
  const slot = document.getElementById('agents-detail-gateway');
  if (!section || !slot) return;
  const cli = (agent.runtime?.kind === 'p3394-gateway' && agent.runtime.cli) ? agent.runtime.cli : '';
  if (!cli) {
    section.style.display = 'none';
    slot.innerHTML = '';
    return;
  }
  section.style.display = '';
  const gateways = (typeof loadExternalGateways === 'function')
    ? await loadExternalGateways({ force: true })
    : [];
  const gw = gateways.find((g) => g && g.cli === cli);
  const running = !!(gw && gw.running);
  const statusText = running
    ? t('agents.gateway_running')
      + (gw.pid ? ` · pid ${gw.pid}` : '')
      + (gw.port ? ` · :${gw.port}` : '')
    : t('agents.gateway_offline');
  const action = running ? 'stop' : 'start';
  const btnLabel = running ? t('agents.gateway_stop') : t('agents.gateway_start');
  slot.innerHTML = `
    <div class="agents-detail-gateway-status">
      <span class="agents-detail-gateway-dot ${running ? 'is-on' : 'is-off'}"></span>
      <span class="agents-detail-gateway-text">${escapeHtml(statusText)}</span>
      <button type="button" class="btn btn-sm" data-gateway-action="${action}" data-gateway-cli="${escapeHtml(cli)}">${escapeHtml(btnLabel)}</button>
    </div>`;
  const btn = slot.querySelector('[data-gateway-action]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      if (action === 'stop') {
        await window.cogseed.invoke('p3394.external.stop', { cli });
      } else {
        const entries = (typeof loadLocalCliEntries === 'function')
          ? await loadLocalCliEntries({ force: true })
          : [];
        const detected = entries.find((entry) => entry && entry.type === cli);
        await window.cogseed.invoke('p3394.external.start', {
          cli,
          alias: agent.name || cli,
          ...(detected && detected.path ? { binPath: detected.path } : {}),
        });
      }
    } catch (err) {
      _agentsLog.warn('p3394 gateway toggle failed', { cli, action, error: err && (err.message || err) });
    }
    btn.disabled = false;
    void _renderAgentDetailGateway(agent);
  });
}

/** Project directory setting for external coding agents (claude / codex).
 *  Stored in a local-only main-process config; each conversation copies
 *  the effective value on its first coding-agent dispatch. */
async function _renderAgentDetailProjectDir(agent) {  const section = document.getElementById('agents-detail-project-dir-section');
  const slot = document.getElementById('agents-detail-project-dir');
  if (!section || !slot) return;
  const cli = _isExternalCliAgent(agent) ? agent.runtime.cli : '';
  const supportsProjectDir = typeof cliIsCodingAgent === 'function' && cliIsCodingAgent(cli);
  if (!supportsProjectDir) {
    section.style.display = 'none';
    slot.innerHTML = '';
    return;
  }
  section.style.display = '';
  slot.dataset.agentId = agent.agent_id;

  const canEdit = agent.source === 'custom';

  const renderInfo = (info) => {
    if (_selectedAgent?.id !== agent.agent_id || slot.dataset.agentId !== agent.agent_id) return;
    const mode = info?.mode === 'custom' ? 'custom' : 'workspace';
    const missing = mode === 'custom' && info.exists === false;
    const pathText = String(info?.path || info?.workspace_path || '');
    const badge = mode === 'custom'
      ? t('agents.project_dir_custom')
      : t('agents.project_dir_workspace');
    const status = missing ? t('agents.project_dir_missing') : badge;
    const cardClass = [
      'agent-project-dir-card',
      mode === 'workspace' ? 'is-workspace' : 'is-custom',
      missing ? 'is-missing' : '',
      canEdit ? '' : 'is-disabled',
    ].filter(Boolean).join(' ');
    slot.innerHTML = `
      <div class="${cardClass}">
        ${_agentUiIconHtml(missing ? 'warning' : 'folder-open', 'agent-project-dir-icon')}
        <div class="agent-project-dir-main">
          <div class="agent-project-dir-path" title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</div>
          <div class="agent-project-dir-mode">${escapeHtml(status)}</div>
        </div>
        <div class="agent-project-dir-actions">
          <button type="button" class="btn btn-sm" data-act="pick" ${canEdit ? '' : 'disabled'}>${escapeHtml(t('input.dir.change'))}</button>
          ${mode === 'custom' ? `<button type="button" class="btn btn-sm" data-act="reset" ${canEdit ? '' : 'disabled'}>${escapeHtml(t('agents.project_dir_use_workspace'))}</button>` : ''}
        </div>
      </div>`;
    const pickBtn = slot.querySelector('[data-act="pick"]');
    const resetBtn = slot.querySelector('[data-act="reset"]');
    const pick = async () => {
      if (!canEdit) return;
      try {
        const picked = await window.cogseed.invoke('common.pickDirectory', {
          title: t('agents.label_project_dir'),
        });
        if (!picked || picked.cancelled || !picked.path) return;
        const saved = await window.cogseed.invoke('agents.cliProjectDir.set', {
          agent_id: agent.agent_id,
          path: picked.path,
        });
        if (!saved || !saved.ok) {
          await uiAlert((saved && saved.error) || t('agents.project_dir_save_failed'));
          return;
        }
        renderInfo(saved.info);
      } catch (err) {
        await uiAlert((err && err.message) || t('agents.project_dir_save_failed'));
      }
    };
    pickBtn?.addEventListener('click', (e) => { e.stopPropagation(); pick(); });
    resetBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      try {
        const saved = await window.cogseed.invoke('agents.cliProjectDir.set', {
          agent_id: agent.agent_id,
          path: '',
        });
        if (!saved || !saved.ok) {
          await uiAlert((saved && saved.error) || t('agents.project_dir_save_failed'));
          return;
        }
        renderInfo(saved.info);
      } catch (err) {
        await uiAlert((err && err.message) || t('agents.project_dir_save_failed'));
      }
    });
  };

  slot.innerHTML = `<div class="agent-project-dir-card is-loading">${_agentUiIconHtml('folder-open', 'agent-project-dir-icon')}<div class="agent-project-dir-main"><div class="agent-project-dir-path">${escapeHtml(t('common.loading'))}</div></div></div>`;
  try {
    const res = await window.cogseed.invoke('agents.cliProjectDir.get', { agent_id: agent.agent_id });
    if (!res || !res.ok || !res.info) throw new Error(res?.error || 'failed');
    renderInfo(res.info);
  } catch (err) {
    _agentsLog.warn('load agent project dir failed', err);
    slot.innerHTML = `<div class="agents-detail-placeholder">${escapeHtml(t('agents.project_dir_load_failed'))}</div>`;
  }
}

/** Render the detail-page avatar slot. Custom agents get a clickable avatar
 *  that opens the picker; builtin agents just show theirs read-only. Each
 *  picker change is sent as an `agents.update` IPC and the local cache is
 *  refreshed so the card grid reflects the new combo on next render. */
function _renderAgentDetailAvatar(agent) {
  const slot = document.getElementById('agents-detail-avatar');
  if (!slot) return;
  const isCommander = _isCommanderAgent(agent);
  const isCustom = agent.source === 'custom' && !_isAgentProfileMock(agent);
  const clickable = isCustom || isCommander;
  const avatarHtml = renderAvatarHtml(agent.icon, agent.color, {
    size: 32,
    seed: agent.agent_id,
    clickable,
    extraClass: 'agents-detail-avatar',
  });
  slot.innerHTML = clickable
    ? `<span class="agents-detail-avatar-edit-wrap">${avatarHtml}<span class="agents-detail-avatar-edit-badge" aria-hidden="true">${_agentUiIconHtml('edit-pencil', 'agents-detail-avatar-edit-icon')}</span></span>`
    : avatarHtml;
  if (!clickable) return;
  const trigger = slot.querySelector('.avatar-circle');
  if (!trigger) return;
  trigger.title = t('avatar.change');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isAvatarPickerOpenFor(trigger)) { closeAvatarPicker(); return; }
    const commanderIcon = (typeof COMMANDER_DEFAULT !== 'undefined' && COMMANDER_DEFAULT?.icon) || 'crown';
    const cur = isCommander
      ? { icon: commanderIcon, color: agent.color }
      : { icon: agent.icon, color: agent.color };
    const pickerOpts = isCommander
      ? { allowCommanderCombo: true, hideIcons: true, colorLabelKey: 'avatar.background_label' }
      : {};
    openAvatarPicker(trigger, cur, pickerOpts, async (next) => {
      // Optimistic in-place update — keeps the trigger element (and its
      // click handler) intact so the picker stays interactive.
      const nextIcon = isCommander ? commanderIcon : next.icon;
      agent.icon = nextIcon;
      agent.color = next.color;
      applyAvatarToElement(trigger, nextIcon, next.color, agent.agent_id);
      try {
        if (isCommander) {
          const res = await window.cogseed.invoke('prefs.setCommanderAvatar', { icon: nextIcon, color: next.color });
          if (res?.ok && res.avatar) {
            _commanderAgentAvatar = { icon: nextIcon, color: res.avatar.color };
            if (typeof setCommanderAvatarCache === 'function') setCommanderAvatarCache({ icon: nextIcon, color: res.avatar.color });
            if (_agentsCache) renderAgentsList(_agentsCache);
            if (typeof renderConversationList === 'function') renderConversationList();
            if (typeof renderProjectsSection === 'function') renderProjectsSection();
          }
        } else {
          const res = await window.cogseed.invoke('agents.update', {
            agent_id: agent.agent_id,
            updates: { icon: next.icon, color: next.color },
          });
          if (res?.ok && res.agent) {
            const cached = _agentsCache?.find((a) => a.agent_id === agent.agent_id);
            if (cached) { cached.icon = next.icon; cached.color = next.color; }
            if (_agentsCache) renderAgentsList(_agentsCache);
          }
        }
      } catch (err) {
        _agentsLog.warn(isCommander ? 'prefs.setCommanderAvatar failed' : 'agents.update avatar failed', err);
      }
    });
  });
}

/** Per-agent enable / disable button in the detail header.
 *  Clone-replace to drop any prior click handler bound to a stale
 *  agent id. The button label flips between "enable" and "disable"
 *  (whichever the click would do). */
function _renderAgentEnabledButton(agent) {
  const oldBtn = document.getElementById('agent-enabled-btn');
  if (!oldBtn) return;
  const enabled = agent.enabled !== false;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);
  btn.disabled = false;
  btn.textContent = enabled ? t('component.disable') : t('component.enable');
  btn.title = enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await _flipAgentEnabled(agent.id, !enabled); }
    finally { btn.disabled = false; }
  });
}


function _toggleAgentFieldEditable(on) {
  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  if (nameEl) {
    nameEl.setAttribute('contenteditable', 'false');
    nameEl.classList.remove('is-editing');
    nameEl.hidden = !!on;
  }
  if (nameInput) {
    nameInput.hidden = !on;
    nameInput.classList.toggle('is-editing', on);
    nameInput.readOnly = !on;
    nameInput.setAttribute('aria-label', t('agent_modal.name'));
  }
  for (const el of [descEl, workflowEl]) {
    if (!el) continue;
    el.setAttribute('contenteditable', on ? 'plaintext-only' : 'false');
    el.classList.toggle('is-editing', on);
  }
}

async function toggleAgentEditMode() {
  if (!_selectedAgent) return;
  if (_isAgentProfileMock(_selectedAgent.id)) return;
  if (_agentEditing) {
    await _exitAgentEditMode();
  } else {
    await _enterAgentEditMode();
  }
}

async function _enterAgentEditMode() {
  _agentEditing = true;
  if (_isCommanderAgent(_selectedAgent?.id)) {
    await _renderCommanderAgentDetail(true);
    const chatCol = document.getElementById('agents-chat-col');
    if (chatCol) chatCol.style.display = 'none';
    return;
  }
  // Re-fetch to show raw workflow (not rendered markdown) for editing.
  const res = await apiFetch(`/api/agents/${encodeURIComponent(_selectedAgent.id)}`);
  const data = await res.json();
  const agent = data.ok && data.agent ? { ...data.agent, source: _agentSource(data.agent.source) } : null;
  if (!agent) {
    _agentEditing = false;
    return;
  }
  if (!_canEnterAgentEditMode(agent)) {
    _agentEditing = false;
    return;
  }
  _renderAgentDetail(agent, true);
  // External agents have no LLM-driven authoring. Marketplace installs in
  // the open-source build are memory-only edits. Both hide the edit chat.
  const isExternal = _isExternalCliAgent(agent);
  const isMemoryOnly = !_canEditAgentDefinition(agent) && _canEditAgentMemory(agent);
  const chatCol = document.getElementById('agents-chat-col');
  if (chatCol) chatCol.style.display = (isExternal || isMemoryOnly) ? 'none' : '';
  if (!isExternal && !isMemoryOnly) {
    await _loadAgentChatHistory(_selectedAgent.id);
    setTimeout(() => document.getElementById('agents-chat-input')?.focus(), 50);
  } else if (isExternal) {
    setTimeout(() => document.getElementById('agents-detail-name-input')?.focus(), 50);
  }
  // Wire field blur-save (one-time attach)
  _bindAgentFieldSave();
}

async function _exitAgentEditMode() {
  _agentEditing = false;
  // Abort any in-flight reply so the "done" button stops the stream immediately. The
  // agent chat controller is a singleton; leaving it pending also leaks the
  // streaming-button state into the next agent's edit panel.
  try { _agentChatCtrl?.abort(); } catch (_) { /* ignore */ }
  if (_isCommanderAgent(_selectedAgent?.id)) {
    clearTimeout(_agentFieldSaveTimer);
    _agentFieldSaveTimer = null;
    _pendingAgentField = null;
    document.getElementById('agents-chat-col').style.display = 'none';
    await _renderCommanderAgentDetail(false);
    await loadAgents(true);
    return;
  }
  // Flush any pending save and then re-render in readonly mode.
  // The Done button is the explicit commit point — validate name here so
  // a bad value alerts + reverts rather than silently lingering.
  await _flushAgentFieldSave({ validate: true });
  document.getElementById('agents-chat-col').style.display = 'none';
  const aid = _selectedAgent?.id;
  if (aid) {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(aid)}`);
    const data = await res.json();
    if (data.ok && data.agent) _renderAgentDetail(data.agent, false);
  }
  await loadAgents(true);
}

function _bindAgentFieldSave() {
  const fields = [
    ['agents-detail-name-input', 'name', (el) => el.value],
    ['agents-detail-desc', 'description', (el) => el.innerText],
    ['agents-detail-workflow', 'workflow', (el) => el.innerText],
  ];
  for (const [id, field, readValue] of fields) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    if (field === 'name' && typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(el);
    el.addEventListener('input', () => _scheduleAgentFieldSave(field, readValue(el)));
    el.addEventListener('blur', () => _flushAgentFieldSave());
  }
}

function _restoreAgentNameField() {
  const next = _selectedAgent?.name || '';
  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  if (nameEl) nameEl.textContent = next;
  if (nameInput) nameInput.value = next;
}

function _scheduleAgentFieldSave(field, value) {
  if (!_selectedAgent) return;
  if (_isAgentPlatformSource(_selectedAgent.source)) return;
  _pendingAgentField = { field, value };
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = setTimeout(_flushAgentFieldSave, 800);
}

let _pendingAgentField = null;
// `validate` is only true when the user explicitly commits (clicks "done" →
// `_exitAgentEditMode`). Typing-debounced and blur-triggered flushes pass
// false: a bad name silently skips the save (the DOM keeps the user's
// in-progress text) instead of popping a uiAlert mid-keystroke.
async function _flushAgentFieldSave({ validate = false } = {}) {
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = null;
  if (!_pendingAgentField || !_selectedAgent) return;
  const { field, value } = _pendingAgentField;
  if (field === 'name') {
    const blank = !String(value || '').trim();
    const hasWhitespace = /\s/.test(String(value || ''));
    const reserved = !hasWhitespace && _isReservedAgentName(value);
    const invalid = hasWhitespace || (!reserved && !_isValidAgentNameCharset(value));
    if (blank || reserved || invalid) {
      if (!validate) return;
      _pendingAgentField = null;
      await uiAlert(t(reserved ? 'agents.name_reserved' : 'agents.name_invalid'));
      _restoreAgentNameField();
      return;
    }
  }
  _pendingAgentField = null;
  try {
    const body = { [field]: value };
    const res = await apiFetch(`/api/agents/${encodeURIComponent(_selectedAgent.id)}/update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      // Surface duplicate-name / reserved-name with their localised messages
      // instead of the raw English server text.
      const localised = _agentCreateErrorMessage(data);
      throw new Error(localised || data.error || 'save failed');
    }
    if (field === 'name') {
      const nextName = data.agent?.name || String(value || '').trim();
      _selectedAgent = { ..._selectedAgent, name: nextName };
      const nameEl = document.getElementById('agents-detail-name');
      const nameInput = document.getElementById('agents-detail-name-input');
      if (nameEl) nameEl.textContent = nextName;
      if (nameInput) nameInput.value = nextName;
    }
    // Eagerly refresh — name changes feed the chat-bubble @-mention regex
    // (`_buildMentionRe` reads `_agentsCache`); leaving the cache null until
    // the next picker open means freshly-typed `@<multi-word-name>` only
    // gets the fallback char class, which stops at the first whitespace.
    await loadAgents(true);
    // Repaint the input-box recipient chip if it's bound to this agent —
    // its `name` field is a localStorage snapshot taken at picker time, so
    // without an explicit re-render the chip keeps showing the old name
    // until the next view switch.
    if (field === 'name' && typeof _renderRecipientChip === 'function') {
      try { _renderRecipientChip(); } catch (_) { /* non-fatal */ }
    }
  } catch (e) {
    _agentsLog.warn('save agent field failed', e);
    if (field === 'name') {
      await uiAlert(e.message || t('agents.create_failed'));
      _restoreAgentNameField();
    }
  }
}

// ─── Create agent (modal-first, two tabs: Create / External) ───
//
// "Create" (default tab) — manual authoring of an in-process agent.
// The LLM-driven edit chat opens immediately on save so the workflow
// can be refined.
//
// "External" — bind a local CLI as the runtime. The CLI selector sits
// at the top (default "not selected"); selecting a CLI auto-fills
// name + description from
// CLI_DEFAULTS. The user can override either; subsequent CLI swaps
// only re-fill fields that still match the previous CLI's defaults
// (so a user-edited value is never clobbered).
//
// Track the last-applied CLI defaults so that "switch CLI → fields
// follow" can detect "did the user touch this field?". `null` =
// nothing applied yet (untouched-default state, or the "create" tab).

function _switchAgentTab(tab) {
  const tabs = document.querySelectorAll('#agent-modal-tabs [data-agent-tab]');
  tabs.forEach((el) => el.classList.toggle('is-active', el.dataset.agentTab === tab));
  const panels = document.querySelectorAll('#agent-modal [data-agent-panel]');
  panels.forEach((el) => el.classList.toggle('is-active', el.dataset.agentPanel === tab));
  const msgEl = document.getElementById('agent-form-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'form-msg'; }
  // 每次切到「外接」tab 都重新扫描并展示「正在扫描本机 CLI…」。之前
  // 扫描只发生在打开弹窗时一次，用户切换 tab 看到的总是早已就绪的
  // 结果 → 感知上像「没有扫描」。移到这里后，进入外接面板必然先短暂
  // 显示扫描态，再呈现真实探测结果。
  if (tab === 'external') {
    _refreshExternalCliSelector();
  }
  setTimeout(() => {
    const focusId = tab === 'external' ? 'agent-modal-ext-cli-select' : 'agent-name-input';
    const el = document.getElementById(focusId);
    // ai-select wrapper isn't focusable directly; just leave it alone.
    if (el && typeof el.focus === 'function' && el.tagName !== 'DIV') el.focus();
  }, 30);
}
window._switchAgentTab = _switchAgentTab;

/** 挂载 / 刷新「外接」tab 的 CLI 选择器：先清空 provider 选择，再以
 *  force 重扫（mountExternalCliSelect 内部会短暂显示「正在扫描本机
 *  CLI…」再替换为最终列表）。每次进入外接面板都会执行，让用户能亲
 *  眼看到本机探测正在发生，而不是直接拿到上次的缓存结果。 */
function _refreshExternalCliSelector() {
  _externalCliProviderSelect?.setValue('');
  const providerLoad = _loadExternalCliProviders().catch(() => []);
  if (typeof mountExternalCliSelect === 'function') {
    mountExternalCliSelect((cli) => {
      _applyExternalCliDefaults(cli);
      providerLoad.then(() => _renderExternalCliProviderSelect(cli, _getExternalCliProviderValue(cli)));
    }).catch(() => {});
  }
  if (typeof _renderExternalPanelPeers === 'function') {
    void _renderExternalPanelPeers();
  }
}

/** 「外接」tab 的「已接入节点」管理区：远端 P3394 节点（remote-nodes 配置，
 *  跨机第二台设备等）的列表 + 添加表单 + 行内 测试/启停/移除。
 *
 *  数据源：p3394.remote.list（配置视图，token 打码）+ loadExternalPanelData
 *  的 peers 注册表快照（按 expected_identity 关联出 在线/停用 状态——远端
 *  节点注入注册表后 agent_id 即 expected_identity）。UI 操作走现成 IPC：
 *  p3394.remote.add / p3394.remote.test / p3394.remote.remove；启停是注册表
 *  语义（p3394.peers.toggle，停用后 @ 派发被拒）——remote-nodes 配置本身
 *  没有 enabled 开关，配置态启停由移除+重加承担。 */
function _remoteNodeTestResultText(result) {
  if (!result) return t('agents.remote.test_failed');
  if (result.ok === true) {
    return t('agents.remote.test_ok', { id: result.peer_agent_id || '—' });
  }
  const reason = result.error?.reason || '';
  if (reason === 'identity_mismatch') return t('agents.remote.test_identity_mismatch');
  if (reason === 'auth') return t('agents.remote.test_auth');
  if (reason === 'unreachable') return t('agents.remote.test_unreachable');
  return t('agents.remote.test_failed_with', { reason: result.error?.message || reason || 'unknown' });
}

async function _renderExternalPanelPeers() {
  const slot = document.getElementById('agent-ext-peers');
  if (!slot) return;
  slot.innerHTML = `<div class="agents-ext-peers-empty">${escapeHtml(t('common.loading'))}</div>`;

  // 配置列表（token 打码）+ 注册表快照（在线/停用）。
  let nodes = [];
  try {
    const res = await window.cogseed.invoke('p3394.remote.list', {});
    if (res && res.ok) nodes = Array.isArray(res.nodes) ? res.nodes : [];
  } catch (err) {
    _agentsLog.warn('p3394.remote.list failed', err);
  }
  let peers = [];
  try {
    if (typeof loadExternalPanelData === 'function') {
      const panel = await loadExternalPanelData();
      peers = Array.isArray(panel?.peers) ? panel.peers : [];
    }
  } catch { /* peers 状态缺失不阻塞列表渲染 */ }
  const peerByAgentId = new Map(peers.map((p) => [p.agent_id, p]));

  const rowsHtml = nodes.map((node, idx) => {
    const peer = node.expected_identity ? peerByAgentId.get(node.expected_identity) : undefined;
    const online = !!peer?.online;
    const disabled = !!peer?.disabled;
    const toggleLabel = disabled ? t('agents.remote.toggle_enable') : t('agents.remote.toggle_disable');
    // 共享 UI 原语（ui-button/ui-form）：不新增原生控件（adoption-guard 基线）。
    const testBtn = uiButton({ label: t('agents.remote.test'), size: 'sm', attrs: { 'data-remote-act': 'test', 'data-remote-idx': String(idx) } });
    const toggleBtn = uiButton({
      label: toggleLabel, size: 'sm',
      ...(node.expected_identity ? {} : { disabled: true }),
      attrs: { 'data-remote-act': 'toggle', 'data-remote-idx': String(idx) },
    });
    const removeBtn = uiButton({ label: t('agents.remote.remove'), role: 'danger', size: 'sm', attrs: { 'data-remote-act': 'remove', 'data-remote-idx': String(idx) } });
    return `
      <div class="agents-remote-node-row" data-remote-idx="${idx}">
        <div class="agents-remote-node-main">
          <div class="agents-remote-node-title">
            <span class="agents-detail-gateway-dot ${online ? 'is-on' : 'is-off'}"></span>
            <span class="agents-remote-node-label">${escapeHtml(node.label || node.id)}</span>
            <span class="agents-remote-node-status">${escapeHtml(disabled ? t('agents.remote.disabled') : (online ? t('agents.remote.online') : t('agents.remote.offline')))}</span>
          </div>
          <div class="agents-remote-node-meta">${escapeHtml(node.endpoint || '')}${node.tokenPreview ? ` · ${escapeHtml(node.tokenPreview)}` : ''}</div>
          ${node.expected_identity ? `<div class="agents-remote-node-meta">${escapeHtml(t('agents.remote.expected_identity'))}: ${escapeHtml(node.expected_identity)}</div>` : ''}
          <div class="agents-remote-node-test-result" data-remote-test-result="${idx}"></div>
        </div>
        <div class="agents-remote-node-actions">
          ${testBtn}
          ${toggleBtn}
          ${removeBtn}
        </div>
      </div>`;
  }).join('');

  slot.innerHTML = `
    <div class="agents-remote-nodes">
      <div class="agents-remote-nodes-title">${escapeHtml(t('agents.remote.title'))}</div>
      <div class="agents-remote-nodes-list">${rowsHtml || `<div class="agents-ext-peers-empty">${escapeHtml(t('agents.remote.empty'))}</div>`}</div>
      <form class="agents-remote-node-form" id="agents-remote-node-form" autocomplete="off">
        <div class="agents-remote-node-form-title">${escapeHtml(t('agents.remote.add_title'))}</div>
        <div class="form-hint agents-remote-node-form-hint">${escapeHtml(t('agents.remote.hint'))}</div>
        <div class="agents-remote-node-form-grid">
          ${uiInput({ id: 'agents-remote-node-label', placeholder: t('agents.remote.label') })}
          ${uiInput({ id: 'agents-remote-node-endpoint', placeholder: t('agents.remote.endpoint') })}
          ${uiInput({ id: 'agents-remote-node-identity', placeholder: t('agents.remote.expected_identity') })}
          ${uiInput({ id: 'agents-remote-node-token', type: 'password', placeholder: t('agents.remote.token') })}
        </div>
        ${uiButton({ label: t('agents.remote.add'), role: 'primary', size: 'sm', attrs: { id: 'agents-remote-node-add' } })}
        <div class="form-msg" id="agents-remote-node-msg"></div>
      </form>
    </div>`;

  // 行内操作：测试（三错误码映射文案）/ 启停（注册表 toggle）/ 移除（二次确认）。
  slot.querySelectorAll('[data-remote-act]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      const idx = Number(btn.getAttribute('data-remote-idx'));
      const node = nodes[idx];
      if (!node) return;
      const act = btn.getAttribute('data-remote-act');
      if (act === 'test') {
        const resultEl = slot.querySelector(`[data-remote-test-result="${idx}"]`);
        if (resultEl) resultEl.textContent = t('agents.remote.testing');
        btn.disabled = true;
        try {
          const res = await window.cogseed.invoke('p3394.remote.test', { id: node.id });
          if (resultEl) resultEl.textContent = _remoteNodeTestResultText(res);
        } catch (err) {
          if (resultEl) resultEl.textContent = _remoteNodeTestResultText({ ok: false, error: { reason: '', message: err?.message || String(err) } });
        }
        btn.disabled = false;
        return;
      }
      if (act === 'toggle') {
        if (!node.expected_identity) return;
        const peer = peerByAgentId.get(node.expected_identity);
        btn.disabled = true;
        try {
          await window.cogseed.invoke('p3394.peers.toggle', { agentId: node.expected_identity, disabled: !(peer?.disabled) });
        } catch (err) {
          _agentsLog.warn('p3394.peers.toggle failed', err);
        }
        void _renderExternalPanelPeers();
        return;
      }
      if (act === 'remove') {
        const ok = typeof uiConfirm === 'function'
          ? await uiConfirm(t('agents.remote.remove_confirm', { name: node.label || node.endpoint }))
          : window.confirm(t('agents.remote.remove_confirm', { name: node.label || node.endpoint }));
        if (!ok) return;
        btn.disabled = true;
        try {
          const res = await window.cogseed.invoke('p3394.remote.remove', { id: node.id });
          if (!res || res.ok === false) {
            await uiAlert((res && res.error?.message) || t('agents.remote.remove_failed'));
            btn.disabled = false;
            return;
          }
        } catch (err) {
          await uiAlert(err?.message || t('agents.remote.remove_failed'));
          btn.disabled = false;
          return;
        }
        void _renderExternalPanelPeers();
      }
    });
  });

  // 添加表单：label/endpoint/token/expected_identity → p3394.remote.add。
  // uiButton 渲染的是 type=button（共享原语约定），提交经 requestSubmit
  // 走 form 的 submit 监听（Enter 提交同样生效）。
  const form = slot.querySelector('#agents-remote-node-form');
  const submitAdd = () => { try { form?.requestSubmit(); } catch (_) { /* 旧环境兜底：直接派发 submit */ form?.dispatchEvent(new Event('submit', { cancelable: true })); } };
  slot.querySelector('#agents-remote-node-add')?.addEventListener('click', (e) => {
    e.preventDefault();
    submitAdd();
  });
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = slot.querySelector('#agents-remote-node-msg');
    const endpoint = (slot.querySelector('#agents-remote-node-endpoint')?.value || '').trim();
    const token = (slot.querySelector('#agents-remote-node-token')?.value || '').trim();
    const expectedIdentity = (slot.querySelector('#agents-remote-node-identity')?.value || '').trim();
    const label = (slot.querySelector('#agents-remote-node-label')?.value || '').trim();
    const showMsg = (text, isErr) => {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.className = 'form-msg' + (isErr ? ' err' : '');
    };
    // 远端节点要能被路由/注入注册表，expected_identity（对端 agent id）必填
    //（后端 add 允许缺省，但注入侧会跳过无身份节点——前端直接挡住）。
    if (!endpoint || !token || !expectedIdentity) {
      showMsg(t('agents.remote.form_missing'), true);
      return;
    }
    const addBtn = slot.querySelector('#agents-remote-node-add');
    if (addBtn) addBtn.disabled = true;
    try {
      const res = await window.cogseed.invoke('p3394.remote.add', {
        label,
        endpoint,
        token,
        expected_identity: expectedIdentity,
      });
      if (!res || res.ok === false) {
        showMsg(t('agents.remote.add_failed', { reason: res?.error?.message || res?.error?.reason || 'unknown' }), true);
        if (addBtn) addBtn.disabled = false;
        return;
      }
    } catch (err) {
      showMsg(t('agents.remote.add_failed', { reason: err?.message || String(err) }), true);
      if (addBtn) addBtn.disabled = false;
      return;
    }
    void _renderExternalPanelPeers();
  });
}

// Track which CLI defaults are currently reflected in the External-tab
// inputs. When a user types over a default, the field key drops out of
// this set so subsequent CLI swaps don't overwrite the typed value.
let _extActiveCli = null;
let _extDefaultFieldsAtMount = { name: false, desc: false };

/** Decide whether a current `name` value still counts as "the default
 *  for `defaultName`" — meaning a CLI swap should overwrite it. We
 *  recognise the bare default plus the dedup-style suffixes a user
 *  is likely to add when fighting the name-taken error: "ClaudeCode",
 *  "ClaudeCode2", "ClaudeCode-2", "ClaudeCode(2)", etc. Anything
 *  with non-digit text after the default ("ClaudeCodePro") counts as
 *  user-edited and is kept. */
function _isDefaultlikeName(value, defaultName) {
  if (!value) return true;
  if (!defaultName) return false;
  if (value === defaultName) return true;
  const escaped = defaultName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '\\s*(?:[-_]\\s*)?(?:\\(\\s*\\d+\\s*\\)|\\d+)$');
  return re.test(value);
}

function _applyExternalCliDefaults(cliType, { force = false } = {}) {
  const defaults = (typeof getCliDefaults === 'function') ? getCliDefaults(cliType) : null;
  const nameEl = document.getElementById('agent-ext-name-input');
  const descEl = document.getElementById('agent-ext-desc-input');
  if (!nameEl || !descEl) return;

  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const localizedDesc = defaults ? pickDesc(defaults, lang) : '';
  const targetName = defaults ? defaults.name : '';
  const targetDesc = localizedDesc;

  // Decide per field whether to overwrite. The two checks are independent —
  // a user who edits the name but leaves the description alone keeps their
  // name and gets a refreshed description. "Default-like name" also covers
  // dedup suffixes like "ClaudeCode2" (added to dodge name-taken errors).
  const prev = (typeof getCliDefaults === 'function') ? getCliDefaults(_extActiveCli) : null;
  const prevDescLocalized = prev ? pickDesc(prev, lang) : '';

  const nameUntouched = force || _isDefaultlikeName(nameEl.value, prev?.name);
  const descUntouched = force
    || descEl.value === ''
    || (prev && descEl.value === prevDescLocalized);

  if (cliType === null) {
    // Reverted to "not selected" — only clear fields that still hold
    // the previous CLI's defaults. Keep user-typed text.
    if (nameUntouched) nameEl.value = '';
    if (descUntouched) descEl.value = '';
  } else {
    if (nameUntouched) nameEl.value = targetName;
    if (descUntouched) descEl.value = targetDesc;
  }
  _extActiveCli = cliType;
}

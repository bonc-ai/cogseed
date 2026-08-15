// 个人本体工作区 — classic script (window.renderPersonalOntology)
// 嵌入“认知资产 -> 记忆内容 -> 关于我”：左栏角色模板，右栏模板字段与原文。
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _t(key, fallback) {
    try { if (typeof t === 'function') { const v = t(key); if (v && v !== key) return v; } } catch (_) {}
    return fallback;
  }

  function _tv(key, vars, fallback) {
    try {
      if (typeof t === 'function') { const v = t(key, vars); if (v && v !== key) return v; }
    } catch (_) {}
    if (vars && fallback != null) {
      return String(fallback).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? String(vars[n]) : m));
    }
    return fallback;
  }

  function _notifyFail(prefix, err) {
    const msg = (err && err.message) ? err.message : String(err || '');
    try {
      if (typeof uiAlert === 'function') uiAlert(msg ? `${prefix}: ${msg}` : prefix);
      else console.warn('[personal-ontology]', prefix, msg);
    } catch (_) {}
  }

  /** SVG 图标（AGENTS.md：图标走 icons.js，不用 emoji/文本符号）。 */
  function _icon(name, className) {
    try {
      if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
        return window.uiIconHtml(name, className || 'ui-icon');
      }
    } catch (_) {}
    return '';
  }

  // ── state ────────────────────────────────────────────────────────────────
  let _pocTemplates = [];
  let _pocTemplatesLoaded = false;
  let _pocTemplatesLoadError = '';
  let _pocProjectNames = null; // Map(pid → name)，二期 D5 字段值 @项目 显示用（懒加载）
  let _pocSkillNames = null;  // Map(id → {name, desc})，模板库 bundle 展示用（懒加载）
  let _pocAgentNames = null;  // Map(id → {name, desc})
  let _pocLibraryModalBound = false; // 模板库弹窗持久节点只绑一次
  let _pocLibraryReturnFocus = null;
  const _pocActionLocks = new Set();
  let _pocRecallSyncAttempted = false;
  let _pocRecallSyncPromise = null;
  let _pocRecallSyncWarningSignature = '';
  // 右栏只展示角色模板；旧候选审核仍由 Recall 正式资产页面负责。
  let _pocSelected = { kind: 'template', id: null };
  // 模板文件编辑器 { groupId, templateId, sections, content, view:'form'|'raw' }
  let _pocGroupEditor = null;

  async function _pocInvoke(channel, payload) {
    try {
      const res = await window.cogseed.invoke(channel, payload || {});
      return res || { ok: false, error: 'no response' };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  async function _pocLoadTemplates() {
    const res = await _pocInvoke('personalOntology.templates.list', {});
    if (!res || res.ok === false || !Array.isArray(res.templates)) {
      _pocTemplatesLoadError = (res && res.error) || _t('personalOntology.load_error', '加载失败');
      _pocTemplatesLoaded = true;
      return false;
    }
    _pocTemplates = res.templates;
    _pocTemplatesLoadError = '';
    _pocTemplatesLoaded = true;
    return true;
  }

  function _pocSetControlBusy(el, busy) {
    if (!el) return;
    if (busy) {
      el.__pocWasDisabled = !!el.disabled;
      el.disabled = true;
      el.setAttribute('aria-busy', 'true');
    } else {
      el.disabled = !!el.__pocWasDisabled;
      delete el.__pocWasDisabled;
      el.removeAttribute('aria-busy');
    }
  }

  async function _pocRunOnce(key, el, task) {
    if (_pocActionLocks.has(key)) return false;
    _pocActionLocks.add(key);
    _pocSetControlBusy(el, true);
    try {
      await task();
      return true;
    } finally {
      _pocActionLocks.delete(key);
      _pocSetControlBusy(el, false);
    }
  }

  function _pocToast(key, fallback, variant, vars) {
    try {
      const message = vars ? _tv(key, vars, fallback) : _t(key, fallback);
      if (typeof uiToast === 'function') uiToast(message, { variant: variant || 'success' });
    } catch (_) {}
  }

  // “关于我”只投影正式 PersonalOntology 资产。主进程会过滤 Rule / Template /
  // Skill，且仅高置信字段匹配才会追加，不覆盖用户已填的值。
  function _pocWarnRecallProfileSync(result) {
    const failedCount = Array.isArray(result && result.failed) ? result.failed.length : 0;
    const error = result instanceof Error
      ? result.message
      : (result && result.error) || '';
    const signature = `${error || 'profile-sync-failed'}:${failedCount}`;
    if (_pocRecallSyncWarningSignature === signature) return;
    _pocRecallSyncWarningSignature = signature;
    const message = _t(
      'personalOntology.profile_sync_warning',
      '个人画像自动更新未完成，稍后可重试。',
    );
    try {
      if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
      else console.warn('[personal-ontology]', message, error);
    } catch (_) {}
  }

  function _pocSyncRecallProfileInBackground() {
    if (_pocRecallSyncAttempted || _pocRecallSyncPromise) return;
    _pocRecallSyncAttempted = true;
    _pocRecallSyncPromise = _pocInvoke('personalOntology.profile.syncRecall', {})
      .then(async (res) => {
        const hasFailures = Array.isArray(res && res.failed) && res.failed.length > 0;
        if (!res || res.ok === false || hasFailures) _pocWarnRecallProfileSync(res);
        else _pocRecallSyncWarningSignature = '';
        if (Number(res && res.written) > 0) {
          _pocTemplatesLoaded = false;
          _pocGroupEditor = null;
          await renderPersonalOntology();
        }
      })
      .catch((err) => {
        _pocWarnRecallProfileSync(err);
      })
      .finally(() => {
        _pocRecallSyncPromise = null;
      });
  }

  // 模板文件分节解析（渲染层简易版，格式与主进程 parseTemplateContent 一致）：
  // 按 `## 分节` 切块，块内取 `### 流水` 小节按 § 切条目。
  function _pocParseTemplateSections(content) {
    const out = {};
    const parts = String(content || '').split(/^##\s+(.+)$/m);
    for (let i = 1; i < parts.length; i += 2) {
      const title = parts[i].trim();
      const body = parts[i + 1] || '';
      const flowIdx = body.indexOf('### 流水');
      const flowText = flowIdx === -1 ? '' : body.slice(flowIdx + '### 流水'.length);
      out[title] = flowText.split('\n§\n').map((s) => s.trim()).filter(Boolean);
    }
    return out;
  }

  // 模板文件表单视图：全部分节平铺，每分节 = 字段表单 + 分节流水。
  // 字段/流水操作走复合 id（`groupId::分节`）。
  function _pocRenderTemplateFormView(ed) {
    if (!ed.sections || !ed.sections.length) {
      return `<div class="memory-empty muted">${escapeHtml(_t('memory.group_form_no_fields', '该模板没有分节'))}</div>`;
    }
    return ed.sections.map((sec) => {
      const ref = `${ed.groupId}::${sec.title}`;
      const fields = (sec.fields || []).map((f) => `
        <div class="memory-group-field" data-mem-group-field="${escapeHtml(f.name)}">
          <div class="memory-group-field-name">
            <span class="memory-group-field-name-text">${escapeHtml(f.name)}</span>
            ${f.isCustom ? `<span class="memory-group-field-custom-badge">${escapeHtml(_t('memory.group_field_custom_badge', '自定义'))}</span>` : ''}
          </div>
          <div class="memory-group-field-values">
            ${f.values && f.values.length
              ? f.values.map((v) => `
                <div class="memory-group-field-value">
                  <span class="memory-group-field-value-text">${escapeHtml(v.value)}</span>
                  <span class="memory-group-field-source muted">${escapeHtml(_tv('memory.group_field_value_source', { value: '', source: v.source }))}</span>
                  ${v.project ? `<span class="memory-group-field-project">@${escapeHtml(_pocProjectNames ? (_pocProjectNames.get(v.project) || v.project) : v.project)}</span>` : ''}
                  <button type="button" class="memory-icon-btn" data-poc-group-action="field-edit-value"
                    data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}" data-poc-value="${escapeHtml(v.value)}"
                    title="${escapeHtml(_t('memory.edit', '编辑'))}">${_icon('edit-pencil', 'ui-icon')}</button>
                  <button type="button" class="memory-icon-btn is-muted" data-poc-group-action="field-remove-value"
                    data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}" data-poc-value="${escapeHtml(v.value)}"
                    title="${escapeHtml(_t('memory.delete', '删除'))}">${_icon('x', 'ui-icon')}</button>
                </div>`).join('')
              : `<span class="memory-group-field-empty muted">${escapeHtml(_t('memory.group_field_empty', '暂无值'))}</span>`}
          </div>
          <div class="memory-group-field-add">
            <input type="text" class="memory-group-field-input" data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}"
              placeholder="${escapeHtml(_t('memory.group_field_add_placeholder', '填值…'))}" />
            <button type="button" class="btn btn-sm btn-primary" data-poc-group-action="field-add-value"
              data-poc-ref="${escapeHtml(ref)}" data-poc-field="${escapeHtml(f.name)}">${escapeHtml(_t('memory.save', '保存'))}</button>
          </div>
        </div>`).join('');
      const flows = (ed.entriesBySection && ed.entriesBySection[sec.title]) || [];
      const flowRows = flows.length
        ? flows.map((e) => `
          <div class="memory-group-flow-entry">
            <span class="memory-group-flow-text">${escapeHtml(e)}</span>
            <button type="button" class="btn btn-sm" data-poc-group-action="entry-promote"
              data-poc-ref="${escapeHtml(ref)}" data-poc-entry="${escapeHtml(e)}">${escapeHtml(_t('memory.group_promote', '升格'))}</button>
            <button type="button" class="memory-icon-btn is-muted" data-poc-group-action="entry-remove"
              data-poc-ref="${escapeHtml(ref)}" data-poc-entry="${escapeHtml(e)}" title="${escapeHtml(_t('memory.delete', '删除'))}">${_icon('x', 'ui-icon')}</button>
          </div>`).join('')
        : `<div class="memory-empty muted">${escapeHtml(_t('memory.group_flow_empty', '暂无流水条目'))}</div>`;
      return `<div class="memory-group-template-section">
        <div class="memory-group-template-section-title">${escapeHtml(sec.title)}</div>
        <div class="memory-group-template-section-fields">${fields}</div>
        <div class="memory-group-template-section-flow">
          <div class="memory-group-template-flow-title">${escapeHtml(_t('memory.group_flow_view', '流水'))}</div>
          ${flowRows}
        </div>
      </div>`;
    }).join('');
  }

  function _pocRenderGroupRawView(ed) {
    return `<textarea class="memory-entry-textarea memory-group-editor-textarea" rows="14" data-poc-group-content>${escapeHtml(ed.content || '')}</textarea>`;
  }

  function _pocRenderGroupEditorHtml() {
    const ed = _pocGroupEditor;
    if (!ed) return '';
    const view = ed.view || 'form';
    const ready = !!ed.loaded && !ed.loadError;
    const tab = (key, label) => `<button type="button" class="memory-group-editor-tab${view === key ? ' is-active' : ''}" data-poc-group-action="view-${key}"${ready ? '' : ' disabled'}>${escapeHtml(label)}</button>`;
    const body = !ed.loaded
      ? `<div class="personal-onto-editor-loading" aria-live="polite">${escapeHtml(_t('personalOntology.template_content_loading', '正在加载模板内容...'))}</div>`
      : ed.loadError
        ? `<div class="personal-onto-template-read-error" role="alert">
            <span>${escapeHtml(_t('personalOntology.load_error', '加载失败'))}: ${escapeHtml(ed.loadError)}</span>
            <button type="button" class="btn btn-sm" data-poc-group-action="reload-group">${escapeHtml(_t('personalOntology.retry', '重试'))}</button>
          </div>`
        : (view === 'form' ? _pocRenderTemplateFormView(ed) : _pocRenderGroupRawView(ed));
    return `<div class="personal-onto-group-editor" data-poc-group-editor="${escapeHtml(ed.groupId)}" aria-busy="${ready ? 'false' : 'true'}">
      <div class="personal-onto-group-editor-head">
        <span class="personal-onto-group-editor-title">${escapeHtml(ed.title || ed.groupId)}</span>
        <span class="memory-template-name-suffix">${escapeHtml(_t('memory.templates_suffix', '模板'))}</span>
      </div>
      <div class="memory-group-editor-tabs">
        ${tab('form', _t('memory.group_form_view', '表单'))}
        ${tab('raw', _t('memory.group_raw_view', '原文'))}
      </div>
      <div class="personal-onto-group-editor-body">
        ${body}
      </div>
      <div class="memory-entry-foot">
        <span class="memory-entry-charcount">${ready && ed.content ? ed.content.length : 0}</span>
        <span class="memory-flex"></span>
        ${view === 'raw' && ready ? `<button type="button" class="btn btn-sm btn-primary" data-poc-group-action="save-content">${escapeHtml(_t('memory.save', '保存'))}</button>` : ''}
      </div>
    </div>`;
  }

  async function _pocEnsureProjectNames() {
    // 空间化后项目层已删：项目名映射不可再解析，保留空 map（@project 显示原始值）。
    if (!_pocProjectNames) _pocProjectNames = new Map();
    return _pocProjectNames;
  }

  async function _pocOpenGroup(groupId) {
    const tmpl = _pocTemplates.find((t) => t.installed && t.group_id === groupId);
    if (!tmpl) return;
    _pocSelected = { kind: 'template', id: groupId };
    const editor = {
      groupId,
      title: tmpl.name,
      content: '',
      loaded: false,
      templateId: tmpl.template_id,
      sections: tmpl.sections || [],
      entriesBySection: null,
      view: 'form',
    };
    _pocGroupEditor = editor;
    renderPersonalOntology();
    await _pocEnsureProjectNames(); // 二期 D5：字段值 @项目 显示需要项目名映射
    const res = await _pocInvoke('personalOntology.groups.read', { groupId });
    if (_pocGroupEditor !== editor) return;
    editor.loaded = true;
    if (!res || res.ok === false) {
      editor.loadError = (res && res.error) || _t('personalOntology.load_error', '加载失败');
      renderPersonalOntology();
      return;
    }
    editor.content = res.content || '';
    editor.entriesBySection = _pocParseTemplateSections(editor.content);
    renderPersonalOntology();
  }

  async function _pocRefreshGroupData() {
    const ed = _pocGroupEditor;
    if (!ed) return;
    const [res, tRes] = await Promise.all([
      _pocInvoke('personalOntology.groups.read', { groupId: ed.groupId }),
      _pocInvoke('personalOntology.templates.list', {}),
    ]);
    if (!_pocGroupEditor || _pocGroupEditor.groupId !== ed.groupId) return;
    if (res && res.ok !== false) {
      _pocGroupEditor.content = res.content || '';
      _pocGroupEditor.entriesBySection = _pocParseTemplateSections(_pocGroupEditor.content);
    }
    if (tRes && tRes.ok !== false && Array.isArray(tRes.templates)) {
      _pocTemplates = tRes.templates;
      const tmpl = _pocTemplates.find((t) => t.template_id === ed.templateId);
      _pocGroupEditor.sections = tmpl && tmpl.sections ? tmpl.sections : [];
      _pocGroupEditor.title = (tmpl && tmpl.name) || _pocGroupEditor.title;
    }
    renderPersonalOntology();
  }

  async function _pocGroupAction(action, payload) {
    const res = await _pocInvoke(action, payload);
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.op_failed', '操作失败'), new Error((res && res.error) || ''));
      return false;
    }
    return true;
  }

  // ── 模板管理 ─────────────────────────────────────────────────────────────
  /** 安装模板：有归档 → 让用户选「恢复原数据 / 重建空模板」；无归档 → 直接装。 */
  async function _pocInstallTemplate(templateId) {
    let restoreData = false;
    // 有归档旧数据 → 提供恢复选项
    try {
      const ar = await _pocInvoke('personalOntology.templates.hasArchive', { templateId });
      if (ar && ar.hasArchive) {
        if (typeof uiConfirmDanger === 'function') {
          const restoreOk = await uiConfirmDanger({
            title: _t('personalOntology.template_reinstall_title', '重新安装'),
            message: _t('personalOntology.template_reinstall_prompt', '检测到该模板的归档数据。要恢复原数据，还是重建空模板？'),
            dangerLabel: _t('personalOntology.template_restore_btn', '恢复原数据'),
          });
          // uiConfirmDanger 确认 = 恢复；取消 = 询问是否重建空模板
          if (restoreOk) restoreData = true;
          else {
            const freshOk = (typeof uiConfirm === 'function')
              ? await uiConfirm({ message: _t('personalOntology.template_rebuild_prompt', '重建空模板？（不恢复归档数据）') })
              : true;
            if (!freshOk) return;
          }
        } else {
          restoreData = false;
        }
      }
    } catch (_) {}
    const res = await _pocInvoke('personalOntology.templates.install', { templateId, restoreData });
    if (!res || res.ok === false) {
      if (res && res.error === 'template_limit_reached') {
        try { if (typeof uiAlert === 'function') uiAlert(_t('personalOntology.template_limit', '最多安装 3 个角色模板，请先卸载一个')); } catch (_) {}
        return;
      }
      _notifyFail(_t('personalOntology.templates_install_error', '模板安装失败'), new Error((res && res.error) || ''));
      return;
    }
    try {
      if (typeof uiToast === 'function') {
        if (res.already_installed) uiToast(_t('memory.templates_already_installed', '该模板已安装'), { variant: 'info' });
        else if (res.restored_from_archive) uiToast(_t('personalOntology.template_restored_ok', '模板已安装，归档数据已恢复'), { variant: 'success' });
        else uiToast(_t('memory.templates_installed_ok', '模板安装成功'), { variant: 'success' });
        if (res.conflict_groups && res.conflict_groups.length) {
          uiToast(_t('memory.templates_conflict', { groups: res.conflict_groups.map((g) => g.title).join('、') }), { variant: 'warning' });
        }
      }
    } catch (_) {}
    await _pocLoadTemplates();
    const installed = _pocTemplates.find((t) => t.installed && t.template_id === templateId);
    if (installed) _pocSelected = { kind: 'template', id: installed.group_id };
    _pocGroupEditor = null;
    _pocRecallSyncAttempted = false;
    renderPersonalOntology();
  }

  /** 卸载模板：确认（含全局记忆归档选项）→ 主进程归档 + 台账移除 → 提示归档位置。 */
  async function _pocUninstallTemplate(templateId) {
    const tmpl = _pocTemplates.find((x) => x.template_id === templateId);
    const name = (tmpl && tmpl.name) || templateId;
    // 该角色有没有全局记忆归档可带走
    let memCount = 0;
    try {
      const mc = await _pocInvoke('memory.roleTemplateCount', { templateId });
      if (mc && typeof mc.count === 'number') memCount = mc.count;
    } catch (_) {}
    const archiveMemory = memCount > 0
      ? (typeof uiConfirm === 'function'
          ? await uiConfirm({
              message: _tv('personalOntology.template_uninstall_mem_confirm', { name, n: memCount },
                '「{name}」有 {n} 条全局记忆（该角色来源）。是否一起归档？归档后重装可一并恢复。'),
            })
          : true)
      : false;
    if (!archiveMemory && memCount > 0) {
      // 用户选择不归档全局记忆 → 只卸模板
      const ok2 = (typeof uiConfirmDanger === 'function')
        ? await uiConfirmDanger({
            title: _t('personalOntology.template_uninstall_title', '卸载角色模板'),
            message: _tv('personalOntology.template_uninstall_confirm', { name }, '卸载「{name}」？模板数据将归档保留（可重新安装恢复），不影响全局记忆。'),
            dangerLabel: _t('personalOntology.template_uninstall_btn', '卸载'),
          })
        : true;
      if (!ok2) return;
    }
    if (memCount === 0) {
      const ok = (typeof uiConfirmDanger === 'function')
        ? await uiConfirmDanger({
            title: _t('personalOntology.template_uninstall_title', '卸载角色模板'),
            message: _tv('personalOntology.template_uninstall_confirm', { name }, '卸载「{name}」？模板数据将归档保留（可重新安装恢复），不影响全局记忆。'),
            dangerLabel: _t('personalOntology.template_uninstall_btn', '卸载'),
          })
        : (typeof uiConfirm === 'function'
            ? await uiConfirm({ message: _tv('personalOntology.template_uninstall_confirm', { name }, '卸载「{name}」？模板数据将归档保留（可重新安装恢复），不影响全局记忆。') })
            : true);
      if (!ok) return;
    }
    const res = await _pocInvoke('personalOntology.templates.uninstall', { templateId, archiveMemory: memCount > 0 ? !!archiveMemory : false });
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.template_uninstall_error', '卸载失败'), new Error((res && res.error) || ''));
      return;
    }
    try {
      if (typeof uiToast === 'function') {
        if (res.archived_memory_count > 0) {
          uiToast(_tv('personalOntology.template_uninstalled_mem_ok', { name, n: res.archived_memory_count }, '已卸载「{name}」，模板与 {n} 条全局记忆已一并归档'), { variant: 'success' });
        } else {
          uiToast(_tv('personalOntology.template_uninstalled_ok', { name }, '已卸载「{name}」，数据已归档'), { variant: 'success' });
        }
        if (res.archive_dir) uiToast(_tv('personalOntology.template_archive_path', { path: res.archive_dir }, '归档位置：{path}'), { variant: 'info' });
      }
    } catch (_) {}
    // 当前模板卸载后由渲染器自动切换到下一个已安装模板。
    if (_pocGroupEditor && _pocGroupEditor.templateId === templateId) {
      _pocSelected = { kind: 'template', id: null };
      _pocGroupEditor = null;
    }
    await _pocLoadTemplates();
    renderPersonalOntology();
  }

  /** 懒加载 skill/agent 名称映射（模板库 bundle 展示用）。 */
  async function _pocEnsureResourceNames() {
    if (_pocSkillNames && _pocAgentNames) return;
    try {
      const [skillsRes, agentsRes] = await Promise.all([
        _pocInvoke('skills.list'),
        _pocInvoke('agents.list'),
      ]);
      _pocSkillNames = new Map((skillsRes.skills || []).map((s) => [s.id, { name: s.name || s.id, desc: (s.description_zh || s.description_en || '').trim() }]));
      _pocAgentNames = new Map((agentsRes.agents || []).map((a) => [a.agent_id, { name: a.name || a.agent_id, desc: (a.description_zh || a.description_en || '').trim() }]));
    } catch (_) {
      _pocSkillNames = _pocSkillNames || new Map();
      _pocAgentNames = _pocAgentNames || new Map();
    }
  }

  /** 模板 bundle → skill/agent 行（名称 + 一句能力简介，与工作空间详情同源）。 */
  function _pocRenderBundle(t) {
    const skillIds = (t.bundle && t.bundle.skill_ids) || [];
    const agentIds = (t.bundle && t.bundle.agent_ids) || [];
    if (!skillIds.length && !agentIds.length) return '';
    const rows = [];
    for (const id of skillIds) {
      const info = _pocSkillNames ? _pocSkillNames.get(id) : null;
      rows.push(`<div class="personal-onto-library-res">
        <span class="personal-onto-library-res-tag is-skill">${_t('personalOntology.bundle_skill', '技能')}</span>
        <div class="personal-onto-library-res-main">
          <span class="personal-onto-library-res-name">${escapeHtml((info && info.name) || id)}</span>
          ${info && info.desc ? `<span class="personal-onto-library-res-desc">${escapeHtml(info.desc)}</span>` : ''}
        </div>
      </div>`);
    }
    for (const id of agentIds) {
      const info = _pocAgentNames ? _pocAgentNames.get(id) : null;
      rows.push(`<div class="personal-onto-library-res">
        <span class="personal-onto-library-res-tag is-agent">${_t('personalOntology.bundle_agent', '智能体')}</span>
        <div class="personal-onto-library-res-main">
          <span class="personal-onto-library-res-name">${escapeHtml((info && info.name) || id)}</span>
          ${info && info.desc ? `<span class="personal-onto-library-res-desc">${escapeHtml(info.desc)}</span>` : ''}
        </div>
      </div>`);
    }
    return `<div class="personal-onto-library-res-list">
      <div class="personal-onto-library-res-title">${_t('personalOntology.template_bundle_label', '配套能力')}</div>
      ${rows.join('')}
    </div>`;
  }

  /** 角色模板库弹窗：列出全部模板（已安装带卸载按钮，未安装带安装按钮），超 3 上限置灰。 */
  async function _pocOpenTemplateLibrary() {
    await _pocEnsureResourceNames();
    const installedCount = _pocTemplates.filter((t) => t.installed).length;
    const atLimit = installedCount >= 3;
    const all = _pocTemplates.slice().sort((a, b) => (b.installed ? 1 : 0) - (a.installed ? 1 : 0));
    const listEl = document.getElementById('personal-onto-template-library-list');
    if (!listEl) return;
    listEl.innerHTML = all.length
      ? all.map((t) => {
          const nSections = (t.sections || []).length;
          const nFields = (t.sections || []).reduce((n, s) => n + (s.fields || []).length, 0);
          const uninstallBtn = t.installed
            ? `<button type="button" class="personal-onto-library-uninstall" data-template-id="${escapeHtml(t.template_id)}"
                 title="${escapeHtml(_t('personalOntology.template_uninstall_tip', '卸载（数据归档保留）'))}">${_icon('x', 'ui-icon')}</button>`
            : '';
          const installBtn = t.installed
            ? `<span class="personal-onto-library-installed muted">${_t('personalOntology.template_installed_badge', '已安装')}</span>`
            : `<button type="button" class="btn btn-sm btn-primary personal-onto-library-install" data-template-id="${escapeHtml(t.template_id)}"
                 ${atLimit ? 'disabled' : ''}>${_t('memory.templates_install', '安装')}</button>`;
          return `<div class="personal-onto-library-card${t.installed ? ' is-installed' : ''}" data-template-id="${escapeHtml(t.template_id)}">
            <div class="personal-onto-library-card-head">
              <span class="personal-onto-library-card-name">${escapeHtml(t.name)}</span>
              <span class="personal-onto-library-card-meta">${nSections} ${_t('personalOntology.dest_role_sections', '分节')} · ${nFields} ${_t('personalOntology.dest_role_fields', '字段')}</span>
              ${uninstallBtn}
            </div>
            ${t.description ? `<div class="personal-onto-library-card-desc">${escapeHtml(t.description)}</div>` : ''}
            ${_pocRenderBundle(t)}
            <div class="personal-onto-library-card-foot">
              ${installBtn}
              ${!t.installed && atLimit ? `<span class="personal-onto-library-limit muted">${_t('personalOntology.template_limit_hint', '已达 3 个上限，需先卸载一个')}</span>` : ''}
            </div>
          </div>`;
        }).join('')
      : `<div class="personal-onto-empty">${_t('personalOntology.template_library_empty', '模板库为空')}</div>`;
    // 事件绑定必须在 innerHTML 填充后做（弹窗每次打开都重写列表）
    listEl.querySelectorAll('.personal-onto-library-install').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.templateId;
        if (!tid || btn.disabled) return;
        await _pocRunOnce(`template-install:${tid}`, btn, async () => {
          await _pocInstallTemplate(tid);
          await _pocOpenTemplateLibrary(); // 刷新列表（上限置灰变化）
        });
      });
    });
    listEl.querySelectorAll('.personal-onto-library-uninstall').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tid = btn.dataset.templateId;
        if (!tid) return;
        await _pocRunOnce(`template-uninstall:${tid}`, btn, async () => {
          await _pocUninstallTemplate(tid);
          await _pocOpenTemplateLibrary();
        });
      });
    });
    const overlay = document.getElementById('personal-onto-template-library-modal');
    if (overlay) {
      if (overlay.style.display === 'none') _pocLibraryReturnFocus = document.activeElement || null;
      overlay.style.display = 'flex';
      overlay.setAttribute('aria-hidden', 'false');
      const closeBtn = document.getElementById('personal-onto-template-library-close');
      if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
    }
  }

  function _pocCloseTemplateLibrary() {
    const overlay = document.getElementById('personal-onto-template-library-modal');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.setAttribute('aria-hidden', 'true');
    }
    const returnFocus = _pocLibraryReturnFocus;
    _pocLibraryReturnFocus = null;
    if (returnFocus && typeof returnFocus.focus === 'function') returnFocus.focus();
  }

  // ── 左栏导航渲染 ─────────────────────────────────────────────────────────
  function _pocRenderNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;
    const installedTmpls = _pocTemplates.filter((t) => t.installed);
    const uninstalledCount = _pocTemplates.length - installedTmpls.length;
    const templateRows = installedTmpls.map((tmpl) => {
      const selected = _pocSelected.kind === 'template' && _pocSelected.id === tmpl.group_id;
      return `<div class="personal-onto-nav-template-row${selected ? ' is-active' : ''}">
        <button type="button" class="personal-onto-nav-row is-file${selected ? ' is-active' : ''}" data-poc-nav="template" data-poc-id="${escapeHtml(tmpl.group_id || '')}">
          <span class="personal-onto-nav-file-icon">${_icon('file-text', 'ui-icon')}</span>
          <span class="personal-onto-nav-row-text">${escapeHtml(tmpl.name)}</span>
          <span class="memory-template-name-suffix">${escapeHtml(_t('memory.templates_suffix', '模板'))}</span>
        </button>
        <button type="button" class="personal-onto-template-uninstall" data-poc-nav="template-uninstall" data-poc-template-id="${escapeHtml(tmpl.template_id)}"
                title="${escapeHtml(_t('personalOntology.template_uninstall_tip', '卸载（数据归档保留）'))}">${_icon('x', 'ui-icon')}</button>
      </div>`;
    }).join('');
    nav.innerHTML = `<div class="personal-onto-nav-section">
      <div class="personal-onto-nav-section-head">
        <span>${escapeHtml(_t('personalOntology.nav_templates', '角色模板'))}</span>
        <span class="muted">${installedTmpls.length}</span>
      </div>
      ${templateRows
        ? `<div class="personal-onto-nav-template-list">${templateRows}</div>`
        : `<div class="personal-onto-nav-empty muted">${escapeHtml(_t('personalOntology.dest_no_roles', '尚未安装角色模板，可在「角色模板库」中安装'))}</div>`}
      <button type="button" class="personal-onto-template-library-btn" data-poc-nav="template-library">
        ${_icon('package', 'ui-icon personal-onto-template-library-icon')}
        <span>${_t('personalOntology.template_library', '角色模板库')}</span>
        <span class="personal-onto-template-library-count">${uninstalledCount}</span>
      </button>
    </div>`;
  }

  // ── 右栏渲染 ─────────────────────────────────────────────────────────────
  function _pocRenderMain() {
    const headerEl = document.getElementById('personal-onto-main-header');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!headerEl || !bodyEl) return;

    if (_pocSelected.kind === 'template' && _pocGroupEditor) {
      headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_pocGroupEditor.title || _t('personalOntology.nav_templates', '角色模板'))}</span>`;
      bodyEl.innerHTML = _pocRenderGroupEditorHtml();
      _pocBindGroupEditor(bodyEl);
      return;
    }
    headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_templates', '角色模板'))}</span>`;
    bodyEl.innerHTML = `<div class="personal-onto-empty personal-onto-template-empty">
      <span>${escapeHtml(_t('personalOntology.dest_no_roles', '尚未安装角色模板，可在「角色模板库」中安装'))}</span>
      <button type="button" class="btn btn-sm btn-primary" id="personal-onto-empty-open-library">
        ${_icon('package', 'ui-icon')}<span>${_t('personalOntology.template_library', '角色模板库')}</span>
      </button>
    </div>`;
    const emptyOpen = document.getElementById('personal-onto-empty-open-library');
    if (emptyOpen) emptyOpen.addEventListener('click', () => _pocOpenTemplateLibrary());
  }

  function _pocRenderTemplatesLoadError() {
    const nav = document.getElementById('personal-onto-nav');
    const headerEl = document.getElementById('personal-onto-main-header');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!nav || !headerEl || !bodyEl) return;
    const error = escapeHtml(_pocTemplatesLoadError || _t('personalOntology.load_error', '加载失败'));
    headerEl.innerHTML = `<span class="personal-onto-main-title">${escapeHtml(_t('personalOntology.nav_templates', '角色模板'))}</span>`;
    nav.innerHTML = `<div class="personal-onto-nav-empty personal-onto-load-error" role="alert">${error}</div>`;
    bodyEl.innerHTML = `<div class="personal-onto-empty personal-onto-load-error" role="alert">
      <span>${escapeHtml(_t('personalOntology.load_error', '加载失败'))}: ${error}</span>
      <button type="button" class="btn btn-sm btn-primary" id="personal-onto-load-retry">${escapeHtml(_t('personalOntology.retry', '重试'))}</button>
    </div>`;
    const retry = document.getElementById('personal-onto-load-retry');
    if (retry) {
      retry.addEventListener('click', async () => {
        await _pocRunOnce('templates-load', retry, async () => {
          _pocTemplatesLoaded = false;
          _pocTemplatesLoadError = '';
          await renderPersonalOntology();
        });
      });
    }
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────
  function _pocBindNav() {
    const nav = document.getElementById('personal-onto-nav');
    if (!nav) return;
    nav.querySelectorAll('[data-poc-nav]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        const action = el.getAttribute('data-poc-nav');
        const id = el.getAttribute('data-poc-id');
        if (action === 'template') { _pocOpenGroup(id); }
        else if (action === 'template-library') {
          e.stopPropagation();
          _pocOpenTemplateLibrary();
        }
        else if (action === 'template-uninstall') {
          e.stopPropagation();
          const tid = el.getAttribute('data-poc-template-id');
          if (tid) await _pocRunOnce(`template-uninstall:${tid}`, el, () => _pocUninstallTemplate(tid));
        }
      });
    });
    // 角色模板库弹窗：关闭/遮罩点击 —— 持久节点，只绑一次（防监听器累积）
    const libOverlay = document.getElementById('personal-onto-template-library-modal');
    if (libOverlay && !_pocLibraryModalBound) {
      _pocLibraryModalBound = true;
      libOverlay.addEventListener('click', (e) => {
        if (e.target === libOverlay) _pocCloseTemplateLibrary();
      });
      const closeBtn = document.getElementById('personal-onto-template-library-close');
      if (closeBtn) closeBtn.addEventListener('click', () => _pocCloseTemplateLibrary());
      const cancelBtn = document.getElementById('personal-onto-template-library-cancel');
      if (cancelBtn) cancelBtn.addEventListener('click', () => _pocCloseTemplateLibrary());
      if (typeof document.addEventListener === 'function') {
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && libOverlay.style.display !== 'none') _pocCloseTemplateLibrary();
        });
      }
    }
    // 安装/卸载按钮绑定在 _pocOpenTemplateLibrary 内部完成（每次 innerHTML 重写后重新绑定）
  }

  function _pocBindGroupEditor(root) {
    root.querySelectorAll('[data-poc-group-action]').forEach((el) => {
      el.addEventListener('click', async () => {
        const action = el.getAttribute('data-poc-group-action');
        const ed = _pocGroupEditor;
        if (!ed) return;
        // 模板分节操作使用复合 id（data-poc-ref），原文操作使用模板 group id。
        const groupId = el.getAttribute('data-poc-ref') || ed.groupId;
        const run = async () => {
          if (action === 'view-form' || action === 'view-raw') {
            ed.view = action.slice('view-'.length);
            renderPersonalOntology();
            return;
          }
          if (action === 'reload-group') {
            await _pocOpenGroup(ed.groupId);
            return;
          }
          if (action === 'save-content') {
            const ta = root.querySelector('[data-poc-group-content]');
            if (!ta) return;
            if (await _pocGroupAction('personalOntology.groups.write', { groupId, content: ta.value })) {
              _pocToast('memory.groups_saved', '已保存');
              await _pocRefreshGroupData();
            }
            return;
          }
          if (action === 'field-add-value') {
            const fieldName = el.getAttribute('data-poc-field');
            const input = root.querySelector(`.memory-group-field-input[data-poc-field="${CSS.escape(fieldName)}"][data-poc-ref="${CSS.escape(groupId)}"]`);
            const value = (input && input.value || '').trim();
            if (!value) return;
            if (await _pocGroupAction('personalOntology.groups.fields.append', { groupId, fieldName, value, source: '手动' })) {
              _pocToast('personalOntology.field_value_added', '已添加');
              await _pocRefreshGroupData();
            }
            return;
          }
          if (action === 'field-edit-value') {
            const fieldName = el.getAttribute('data-poc-field');
            const oldValue = el.getAttribute('data-poc-value');
            const newValue = (typeof uiPrompt === 'function') ? await uiPrompt(_t('memory.group_field_edit_prompt', '编辑字段值：'), oldValue) : null;
            if (newValue === null) return;
            const trimmed = String(newValue || '').trim();
            if (!trimmed || trimmed === oldValue) return;
            if (await _pocGroupAction('personalOntology.groups.fields.setValue', { groupId, fieldName, value: trimmed, oldValue })) {
              _pocToast('personalOntology.field_value_updated', '已更新');
              await _pocRefreshGroupData();
            }
            return;
          }
          if (action === 'field-remove-value') {
            const fieldName = el.getAttribute('data-poc-field');
            const value = el.getAttribute('data-poc-value');
            const ok = (typeof uiConfirm === 'function')
              ? await uiConfirm({ message: _tv('personalOntology.field_value_delete_confirm', { value }, '删除字段值「{value}」？') })
              : true;
            if (!ok) return;
            if (await _pocGroupAction('personalOntology.groups.fields.removeValue', { groupId, fieldName, value })) {
              _pocToast('personalOntology.field_value_removed', '已删除');
              await _pocRefreshGroupData();
            }
            return;
          }
          if (action === 'entry-promote') {
            const entryText = el.getAttribute('data-poc-entry');
            const fieldName = (typeof uiPrompt === 'function') ? await uiPrompt(_t('memory.group_promote_prompt', '升格为新字段，字段名：'), '') : null;
            if (fieldName === null) return;
            const trimmed = String(fieldName || '').trim();
            if (!trimmed) return;
            const res = await _pocInvoke('personalOntology.groups.entries.promote', { groupId, entryText, fieldName: trimmed });
            if (res && res.ok !== false) {
              if (res.isCustom) {
                _pocToast('memory.group_promote_custom_done', `已创建自定义字段「${trimmed}」（不在模板字段清单内）`, 'info', { name: trimmed });
              } else {
                _pocToast('personalOntology.field_value_added', '已添加');
              }
              await _pocRefreshGroupData();
            } else {
              _notifyFail(_t('personalOntology.op_failed', '操作失败'), new Error((res && res.error) || ''));
            }
            return;
          }
          if (action === 'entry-remove') {
            const entryText = el.getAttribute('data-poc-entry');
            const ok = (typeof uiConfirm === 'function') ? await uiConfirm({ message: _t('memory.group_entry_delete_confirm', '删除这条流水？') }) : true;
            if (!ok) return;
            if (await _pocGroupAction('personalOntology.groups.entries.remove', { groupId, entryText })) {
              _pocToast('personalOntology.field_value_removed', '已删除');
              await _pocRefreshGroupData();
            }
          }
        };
        if (action === 'view-form' || action === 'view-raw') {
          await run();
          return;
        }
        const item = el.getAttribute('data-poc-field') || el.getAttribute('data-poc-entry') || el.getAttribute('data-poc-value') || '';
        await _pocRunOnce(`group-action:${action}:${groupId}:${item}`, el, run);
      });
    });
  }

  // ── 确认 / 驳回 / 批量 ────────────────────────────────────────────────────
  // 复合 id（groupId::分节）→ 可读标签（模板名.分节名 / 组名）
  function _pocRefLabel(ref) {
    const parts = String(ref || '').split('::');
    const gid = parts[0];
    const sec = parts[1];
    const group = _pocGroups.find((g) => g.group_id === gid);
    if (group) return sec ? `${group.title}.${sec}` : group.title;
    return ref;
  }

  function _destPayloadFor(candidateId) {
    const state = _pocDestFor(candidateId);
    // 全局记忆恒写（确认 = 必进全局记忆）；去向 = 高级分节（精确）或角色模板组（AI 归位）
    let toGroupIds = Array.from(state.groupIds);
    if (!toGroupIds.length && state.roleGroupId) toGroupIds = [state.roleGroupId];
    const payload = { toGlobalMemory: true, toGroupIds };
    if (state.field && state.field !== 'flow') payload.targetField = state.field;
    return payload;
  }

  function _destResultToWarnings(res) {
    const warnings = [];
    if (res && res.globalMemory && res.globalMemory.ok === false) {
      warnings.push(_tv('personalOntology.dest_global_failed', { error: res.globalMemory.error || '' },
        `全局记忆写入失败: ${res.globalMemory.error || ''}`));
    }
    if (res && Array.isArray(res.groups)) {
      res.groups.forEach((g) => {
        if (g.ok === false) {
          warnings.push(_tv('personalOntology.dest_group_failed', { group: _pocRefLabel(g.groupId), error: g.error || '' },
            `分组「${_pocRefLabel(g.groupId)}」写入失败: ${g.error || ''}`));
        }
      });
    }
    return warnings;
  }

  async function confirmCandidate(candidateId) {
    if (!candidateId) return;
    try {
      // routeWithLlm: true —— 确认时经 LLM 对号入座（用户指定字段时 LLM 不覆盖）
      const res = await window.cogseed.invoke('personalOntology.candidates.confirm', {
        candidateId,
        ...(_destPayloadFor(candidateId)),
        routeWithLlm: true,
      });
      const warnings = _destResultToWarnings(res);
      if (res && res.ok === false) {
        _notifyFail(_t('personalOntology.confirm_error', '确认失败'), new Error((res.error || warnings.join('; ')) || ''));
        return;
      }
      try {
        if (typeof uiToast === 'function') {
          if (res.fieldWrites && res.fieldWrites.some((fw) => fw.ok)) {
            const fw = res.fieldWrites.find((x) => x.ok);
            uiToast(_tv('personalOntology.confirm_field_ok', { group: _pocRefLabel(fw.groupId), field: fw.fieldName },
              `已填入 ${_pocRefLabel(fw.groupId)}.${fw.fieldName}`), { variant: 'success' });
          } else if (res.groups && res.groups.some((g) => g.ok)) {
            // 未命中字段 → 进流水区（C-1：单条确认也要有反馈，否则用户以为候选被吞）
            const g = res.groups.find((x) => x.ok);
            uiToast(_tv('personalOntology.confirm_flow_ok', { group: _pocRefLabel(g.groupId) },
              `已进入 ${_pocRefLabel(g.groupId)} 流水区（未匹配到字段）`), { variant: 'info' });
          }
          warnings.forEach((w) => uiToast(w, { variant: 'warning' }));
        }
      } catch (_) {}
      _pocDestState.delete(candidateId);
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.confirm_error', '确认失败'), err);
    }
  }

  async function rejectCandidate(candidateId) {
    if (!candidateId) return;
    const reason = await showRejectReasonModal();
    if (reason === null) return;
    const res = await _pocInvoke('personalOntology.candidates.reject', { candidateId, reason: reason || '' });
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.reject_error', '驳回失败'), new Error((res && res.error) || ''));
      return;
    }
    _pocDestState.delete(candidateId);
    renderPersonalOntology();
  }

  async function confirmAll(pending) {
    if (!pending || !pending.length) return;
    if (!confirm(_t('personalOntology.confirm_all_prompt', `确认全部 ${pending.length} 个候选？`))) return;
    try {
      const failedIds = [];
      const fieldCounts = {};
      let toEntries = 0;
      let okCount = 0;
      for (const c of pending) {
        // 每条候选用各自的选择（角色/分节），不共享第一条的
        const dest = _destPayloadFor(c.candidate_id);
        const state = _pocDestState.get(c.candidate_id);
        const field = state && state.field ? state.field : (c.target_field || 'flow');
        if (field && field !== 'flow') dest.targetField = field;
        const res = await window.cogseed.invoke('personalOntology.candidates.confirm', { candidateId: c.candidate_id, ...dest, routeWithLlm: true });
        if (res && res.ok) {
          okCount++;
          for (const fw of (res.fieldWrites || [])) if (fw.ok) fieldCounts[fw.fieldName] = (fieldCounts[fw.fieldName] || 0) + 1;
          for (const g of (res.groups || [])) {
            const hadFieldWrite = (res.fieldWrites || []).some((fw) => fw.ok && fw.groupId === g.groupId);
            if (g.ok && !hadFieldWrite) toEntries++;
          }
        } else {
          failedIds.push(c.candidate_id);
        }
      }
      try {
        if (typeof uiToast === 'function') {
          if (failedIds.length) uiToast(_tv('personalOntology.confirm_all_partial', { n: failedIds.length }, `${failedIds.length} 条确认失败`), { variant: 'warning' });
          const fieldsLabel = Object.keys(fieldCounts).map((f) => `${f}×${fieldCounts[f]}`).join('、') || '-';
          uiToast(_tv('personalOntology.batch_summary', { n: okCount, fields: fieldsLabel, m: toEntries },
            `${okCount} 条已确认：${fieldsLabel}；流水区 ${toEntries} 条`), { variant: 'success' });
        }
      } catch (_) {}
      pending.forEach((c) => _pocDestState.delete(c.candidate_id));
      renderPersonalOntology();
    } catch (err) {
      _notifyFail(_t('personalOntology.confirm_all_error', '批量确认失败'), err);
    }
  }

  async function rejectAll(pending) {
    if (!pending || !pending.length) return;
    const reason = await showRejectReasonModal();
    if (reason === null) return;
    const candidateIds = pending.map((c) => c.candidate_id);
    const res = await _pocInvoke('personalOntology.candidates.rejectBatch', { candidateIds, reason: reason || '' });
    if (!res || res.ok === false) {
      _notifyFail(_t('personalOntology.reject_all_error', '批量驳回失败'), new Error((res && res.error) || ''));
      return;
    }
    candidateIds.forEach((id) => _pocDestState.delete(id));
    renderPersonalOntology();
    root.querySelectorAll('.memory-group-field-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229 || e.key !== 'Enter') return;
        e.preventDefault();
        const fieldName = input.getAttribute('data-poc-field');
        const ref = input.getAttribute('data-poc-ref');
        const saveBtn = root.querySelector(`button[data-poc-group-action="field-add-value"][data-poc-field="${CSS.escape(fieldName)}"][data-poc-ref="${CSS.escape(ref)}"]`);
        if (saveBtn && !saveBtn.disabled) saveBtn.click();
      });
    });
  }

  // ── 主渲染 ───────────────────────────────────────────────────────────────
  async function renderPersonalOntology() {
    const nav = document.getElementById('personal-onto-nav');
    const bodyEl = document.getElementById('personal-onto-main-body');
    if (!nav || !bodyEl) {
      console.error('[personal-ontology] missing DOM elements');
      return;
    }

    if (!_pocTemplatesLoaded) {
      nav.innerHTML = '<div class="personal-onto-nav-empty muted">' + _t('personalOntology.loading', '加载中...') + '</div>';
      bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.loading', '加载中...') + '</div>';
      await _pocLoadTemplates();
    }

    if (_pocTemplatesLoadError) {
      _pocRenderTemplatesLoadError();
      return;
    }

    try {
      const installed = _pocTemplates.filter((t) => t.installed && t.group_id);
      let selected = installed.find((t) => t.group_id === _pocSelected.id);
      if (!selected && installed.length) {
        selected = installed[0];
        _pocSelected = { kind: 'template', id: selected.group_id };
        _pocGroupEditor = null;
      }
      if (!selected) {
        _pocSelected = { kind: 'template', id: null };
        _pocGroupEditor = null;
      } else if (!_pocGroupEditor || _pocGroupEditor.groupId !== selected.group_id) {
        _pocOpenGroup(selected.group_id);
        return;
      }

      _pocRenderNav();
      _pocBindNav();
      _pocRenderMain();
      _pocSyncRecallProfileInBackground();
    } catch (err) {
      console.error('[personal-ontology] render failed', err);
      bodyEl.innerHTML = '<div class="personal-onto-empty">' + _t('personalOntology.load_error', '加载失败') + ': ' + escapeHtml((err && err.message) || String(err)) + '</div>';
    }
  }

  function refreshPersonalOntology() {
    _pocTemplatesLoaded = false;
    _pocTemplatesLoadError = '';
    _pocGroupEditor = null;
    _pocRecallSyncAttempted = false;
    return renderPersonalOntology();
  }

  window.renderPersonalOntology = renderPersonalOntology;
  window.refreshPersonalOntology = refreshPersonalOntology;
})();

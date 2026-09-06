// agents-create.js — Agent 创建弹窗 + 内联编辑聊天。
// 从 agents.js 按职责拆出（R4）：openAgentModal/closeAgentModal/saveAgentModal
// 双 tab 表单（Create 手工创建 / External 外接 CLI）、_agentCreateErrorMessage
// 错误归一、deleteSelectedAgent，以及详情页的 LLM 内联编辑聊天控制器
// （agents-create.js 末段；详情编辑入口 _enterAgentEditMode 在
// agents-detail.js 中调用这里）。
// createAgentViaIpc 是全部渲染层创建调用的统一入口（agents-create 时
// onboarding.js / conversation.js 也复用它）。
// 依赖 agents.js（模块态/工具/loadAgents/_showAgentsDetailView）与
// agents-detail.js（_enterAgentEditMode）：classic <script> 共享全局词法
// 环境，本文件必须排在两者之后加载（顺序见 index.html）。

/** 统一的智能体创建入口（R3 归一）：渲染层所有 agents.create 调用都走这里
 *  —— 创建弹窗两个 tab（_saveCreateAgent / _saveExternalAgent）、onboarding
 *  的幂等补建（_csEnsureCliAgent）、conversation 的 CLI fallback 现建。
 *  等价于原先 apiFetch('/api/agents/create') 经 ipc-shim 的路径：底层就是
 *  cogseed.invoke('agents.create')；invoke 失败不抛出，而是返回
 *  { ok:false, error }，让调用方沿用自己的 !data.ok / !res.agent 分支处理，
 *  错误提示语义与归一前一致。 */
async function createAgentViaIpc(payload) {
  try {
    return await window.cogseed.invoke('agents.create', payload);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}
if (typeof window !== 'undefined') {
  window.createAgentViaIpc = createAgentViaIpc;
}

function openAgentModal(options = {}) {
  const requestedTab = typeof options === 'string' ? options : options?.initialTab;
  const initialTab = requestedTab === 'external' ? 'external' : 'create';
  const modal = document.getElementById('agent-modal');
  const msgEl = document.getElementById('agent-form-msg');
  msgEl.textContent = '';
  msgEl.className = 'form-msg';

  // Reset both panels' inputs.
  const nameInput = document.getElementById('agent-name-input');
  const descInput = document.getElementById('agent-desc-input');
  const extName = document.getElementById('agent-ext-name-input');
  const extDesc = document.getElementById('agent-ext-desc-input');
  if (nameInput) nameInput.value = '';
  if (descInput) descInput.value = '';
  if (extName) extName.value = '';
  if (extDesc) extDesc.value = '';
  _extActiveCli = null;
  _extDefaultFieldsAtMount = { name: true, desc: true };
  if (typeof window.bindNameLimitControl === 'function') {
    window.bindNameLimitControl(nameInput);
    window.bindNameLimitControl(extName);
  }

  // Wire tabs (idempotent).
  const tabBar = document.getElementById('agent-modal-tabs');
  if (tabBar && !tabBar.dataset.wired) {
    tabBar.querySelectorAll('[data-agent-tab]').forEach((btn) => {
      btn.addEventListener('click', () => _switchAgentTab(btn.dataset.agentTab));
    });
    tabBar.dataset.wired = '1';
  }
  _switchAgentTab(initialTab);

  modal.classList.add('open');
  const focusId = initialTab === 'external' ? 'agent-ext-name-input' : 'agent-name-input';
  setTimeout(() => document.getElementById(focusId)?.focus(), 50);
}
window.openAgentModal = openAgentModal;

function closeAgentModal() {
  document.getElementById('agent-modal').classList.remove('open');
}
window.closeAgentModal = closeAgentModal;

async function saveAgentModal() {
  const msgEl = document.getElementById('agent-form-msg');
  const activeTab = document.querySelector('#agent-modal-tabs .is-active')?.dataset.agentTab || 'create';
  if (activeTab === 'external') return _saveExternalAgent({ msgEl });
  return _saveCreateAgent({ msgEl });
}
window.saveAgentModal = saveAgentModal;

async function _saveCreateAgent({ msgEl }) {
  const rawName = document.getElementById('agent-name-input').value;
  const name = rawName.trim();
  const description = document.getElementById('agent-desc-input').value.trim();

  if (!name) {
    msgEl.textContent = t('agents.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  const hasWhitespace = /\s/.test(rawName);
  const reserved = !hasWhitespace && _isReservedAgentName(name);
  if (hasWhitespace || (!reserved && !_isValidAgentNameCharset(rawName))) {
    msgEl.textContent = t('agents.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  if (reserved) {
    msgEl.textContent = t('agents.name_reserved');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  if (!description) {
    msgEl.textContent = t('agents.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-desc-input').focus();
    return;
  }

  const outputFormat = 'auto';

  const startedAt = performance.now();
  if (window.Monitor) (() => {})('agent_create_submit', { agent_type: 'default', output_format: outputFormat });
  try {
    // Leave the icon unset so the immediately-started agent authoring model
    // can choose semantically from the controlled catalog. The renderer's
    // legacy seed fallback covers the brief pre-authoring state.
    const body = { name, description, category: 'general' };
    const data = await createAgentViaIpc(body);
    if (!data.ok || !data.agent) {
      msgEl.textContent = _agentCreateErrorMessage(data) || t('agents.create_failed');
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'default',
          output_format: outputFormat,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: data.code || '',
        });
        (() => {})('agent_create', {
          agent_type: 'default',
          output_format: outputFormat,
          error_type: 'api',
          error_code: data.code || '',
          error_message: data.error || 'unknown',
        });
      }
      return;
    }
    if (window.Monitor) (() => {})('agent_create_result', {
      result: 'success',
      agent_id: data.agent.agent_id,
      agent_type: 'default',
      output_format: outputFormat,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    closeAgentModal();
    setView('agents');
    await loadAgents(true);
    await _showAgentsDetailView(data.agent.agent_id);
    await _enterAgentEditMode();
    const seed = t('agents.seed_workflow_model', { name, description });
    await _autoSendAgentChat(t('agents.seed_workflow'), { model_text: seed });
  } catch (e) {
    msgEl.textContent = t('agents.network_error', { reason: e.message || e });
    msgEl.className = 'form-msg err';
    if (window.Monitor) {
      (() => {})('agent_create_result', {
        result: 'failure',
        agent_type: 'default',
        output_format: outputFormat,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      (() => {})('agent_create', {
        agent_type: 'default',
        output_format: outputFormat,
        error_type: 'network',
        error_message: e.message || String(e),
      });
    }
  }
}

async function _saveExternalAgent({ msgEl }) {
  const cli = (typeof getExternalCliValue === 'function') ? getExternalCliValue() : null;
  const rawName = document.getElementById('agent-ext-name-input').value;
  const name = rawName.trim();
  const desc = document.getElementById('agent-ext-desc-input').value.trim();

  if (!cli) {
    msgEl.textContent = t('agents.ext_cli_needed');
    msgEl.className = 'form-msg err';
    return;
  }
  if (!name) {
    msgEl.textContent = t('agents.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  const hasWhitespace = /\s/.test(rawName);
  const reserved = !hasWhitespace && _isReservedAgentName(name);
  if (hasWhitespace || (!reserved && !_isValidAgentNameCharset(rawName))) {
    msgEl.textContent = t('agents.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  if (reserved) {
    msgEl.textContent = t('agents.name_reserved');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  if (!desc) {
    msgEl.textContent = t('agents.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-desc-input').focus();
    return;
  }

  const startedAt = performance.now();
  if (window.Monitor) (() => {})('agent_create_submit', { agent_type: 'p3394', cli });
  // P3394 方式外接：先创建智能体记录，再拉起该 CLI 的受管 P3394 网关。
  // 顺序不能反：先起网关会立即收到 hello → 自动投影用默认名抢先创建，
  // 用户命名的同名智能体反而被 "已占用" 拒绝（时序竞态，曾产生双卡）。
  // 先建记录后，投影的 existing_agent 分支会复用本记录，不再重复创建。
  try {
    const entries = await window.loadLocalCliEntries({ force: true });
    const detected = entries.find((e) => e && e.type === cli);
    const body = {
      name,
      description: desc,
      // P3394 外接智能体：每一轮对话都通过桥与受管网关节点协作。
      icon: 'code', color: 'sage',
      runtime: { kind: 'p3394-gateway', cli },
      category: 'general',
    };
    const data = await createAgentViaIpc(body);
    if (!data.ok || !data.agent) {
      msgEl.textContent = _agentCreateErrorMessage(data) || t('agents.create_failed');
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'cli',
          cli,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: data.code || '',
        });
        (() => {})('agent_create', {
          agent_type: 'cli',
          cli,
          error_type: 'api',
          error_code: data.code || '',
          error_message: data.error || 'unknown',
        });
      }
      return;
    }
    const agentId = data.agent.agent_id;
    // 记录已创建，再启动网关。网关 hello 触发自动投影时会复用上面的
    // 记录（team-projection 的 existing_agent 分支），不会重复创建默认名。
    let started;
    try {
      started = await window.cogseed.invoke('p3394.external.start', {
        cli,
        alias: name,
        ...(detected && detected.path ? { binPath: detected.path } : {}),
      });
    } catch (startErr) {
      // 网关启动调用本身抛异常：回滚刚创建的记录，避免留下半成品。
      try { await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }); } catch { /* best effort */ }
      msgEl.textContent = t('agents.network_error', { reason: startErr.message || startErr });
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'p3394',
          cli,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
      return;
    }
    if (!started || !started.ok) {
      // 网关启动失败（脚本缺失 / 注册超时等）：回滚刚创建的记录。投影
      // 映射可能残留指向已删除记录（已有投射记录时节点 hello 不再重建
      // 卡片），属低频边界，后续可清理投影文件恢复。
      try { await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' }); } catch { /* best effort */ }
      msgEl.textContent = t('agents.p3394_gateway_start_failed', {
        reason: (started && started.error) || 'unknown',
      });
      msgEl.className = 'form-msg err';
      if (window.Monitor) {
        (() => {})('agent_create_result', {
          result: 'failure',
          agent_type: 'p3394',
          cli,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: (started && started.error) || '',
        });
      }
      return;
    }
    if (window.Monitor) (() => {})('agent_create_result', {
      result: 'success',
      agent_id: agentId,
      agent_type: 'p3394',
      cli,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    closeAgentModal();
    setView('agents');
    await loadAgents(true);
    // External agents go straight to the detail view but skip the LLM
    // edit-chat — there's nothing to author. The user can still rename
    // or reword the description through the inline name/desc editors.
    await _showAgentsDetailView(agentId);
  } catch (e) {
    msgEl.textContent = t('agents.network_error', { reason: e.message || e });
    msgEl.className = 'form-msg err';
    if (window.Monitor) {
      (() => {})('agent_create_result', {
        result: 'failure',
        agent_type: 'p3394',
        cli,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      (() => {})('agent_create', {
        agent_type: 'p3394',
        cli,
        error_type: 'network',
        error_message: e.message || String(e),
      });
    }
  }
}

/** Normalise IPC-shim error replies into a user-facing message. The
 *  backend tags duplicate-name / reserved-name failures with a `code`
 *  so we surface the localised string instead of the raw "agent name
 *  ... is already in use" English text. */
function _agentCreateErrorMessage(data) {
  if (!data) return '';
  const code = data.code;
  if (code === 'E_AGENT_NAME_TAKEN') return t('agents.name_taken');
  if (code === 'E_AGENT_NAME_RESERVED') return t('agents.name_reserved');
  if (code === 'E_AGENT_NAME_INVALID') return t('agents.name_invalid');
  if (code === 'E_AGENT_NAME_TOO_LONG') return t('agents.name_too_long');
  return data.error || '';
}

async function _autoSendAgentChat(content, extraBody) {
  if (!_selectedAgent) return;
  const container = document.getElementById('agents-chat-messages');
  if (!container) return;
  // Only auto-seed when the chat is empty (fresh agent).
  const existing = container.querySelectorAll('.chat-message');
  if (existing.length > 0) return;
  _ensureAgentChatController();
  await _agentChatCtrl.send(content, extraBody);
}

async function deleteSelectedAgent() {
  if (!_selectedAgent) return;
  if (_isCommanderAgent(_selectedAgent.id)) return;
  if (_isAgentProfileMock(_selectedAgent.id)) return;
  const isMarketplace = _isAgentPlatformSource(_selectedAgent.source);
  if (isMarketplace && !false) return;
  const agentId = _selectedAgent.id;
  if (!(await uiConfirm(t('agents.delete_confirm', { name: _selectedAgent.name || agentId })))) return;
  if (window.Monitor) (() => {})('agent_delete', { agent_id: agentId });
  try {
    const data = isMarketplace
      ? await window.cogseed.invoke('agents.builtin.delete', { agent_id: agentId })
      : await (await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })).json();
    if (!data.ok) throw new Error(data.error || t('agents.delete_failed'));
    _selectedAgent = null; _agentEditing = false;
    document.getElementById('agents-chat-col').style.display = 'none';
    document.getElementById('agents-detail-content').style.display = 'none';
    _showAgentsGridView();
    await loadAgents(true);
    await loadConversations();
  } catch (e) {
    await uiAlert(t('agents.delete_failed_with', { reason: e.message || e }));
  }
}

// ─── Agent inline edit chat ───

let _agentChatCtrl = null;
let _agentEditAttachmentsBound = false;

function _agentEditAttachmentCid(agentId) {
  return agentId ? `agent-edit-${agentId}` : '';
}

function _bindAgentEditAttachments() {
  if (_agentEditAttachmentsBound) return;
  _agentEditAttachmentsBound = true;
  const btn = document.getElementById('agents-chat-attach-btn');
  const area = document.querySelector('.agents-chat-input-area');
  const input = document.getElementById('agents-chat-input');
  const currentCid = () => _agentEditAttachmentCid(_selectedAgent?.id || '');
  if (btn) {
    btn.addEventListener('click', async () => {
      const cid = currentCid();
      if (cid) await _chatAttachPickAndUpload(cid, 'picker');
    });
  }
  if (area) {
    area.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length;
      const hasInternal = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(COGSEED_FILE_DRAG_MIME);
      if (!hasFiles && !hasInternal) return;
      e.preventDefault();
      area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', async (e) => {
      const cid = currentCid();
      if (!cid) return;
      const internal = _chatAttachInternalDragItems(e.dataTransfer);
      if (internal.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachImportPaths(cid, internal, 'internal_drop');
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachUpload(cid, e.dataTransfer.files, 'drop');
      }
    });
  }
  if (input) {
    input.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      const cid = currentCid();
      if (!cid) return;
      e.preventDefault();
      await _chatAttachUpload(cid, e.clipboardData.files, 'paste');
    });
  }
}

async function _buildAgentEditChatExtraBody(_content, agentId, state) {
  const cid = _agentEditAttachmentCid(agentId);
  const items = _chatAttachList(cid);
  if (!items.length) return undefined;
  if (items.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return null;
  }
  const attachments = items.filter((a) => a.status !== 'error').map((a) => a.name);
  if (!attachments.length) return undefined;
  if (state && (state.pending || state.hasQueue)) {
    await uiAlert(t('chat.attach_queue_blocked'));
    return null;
  }
  _chatAttachClear(cid);
  return { attachments, attachment_cid: cid };
}

function _ensureAgentChatController() {
  if (_agentChatCtrl) return _agentChatCtrl;
  _bindAgentEditAttachments();
  _agentChatCtrl = createChatController({
    historyEl: 'agents-chat-messages',
    inputEl: 'agents-chat-input',
    sendBtnEl: 'agents-chat-send-btn',
    getCurrentId: () => _selectedAgent?.id || null,
    historyEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat`,
    streamEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat/send/stream`,
    clearEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat`,
    features: { archive: false, scrollPin: true, queue: true },
    queue: {
      keyPrefix: 'agent',
      panelId: 'agents-chat-queue',
      listId: 'agents-chat-queue-list',
      countId: 'agents-chat-queue-count',
    },
    hooks: {
      buildExtraBody: _buildAgentEditChatExtraBody,
      async onFinal(ev, msgEl, id) {
        // Agent edit chat may have rewritten name / description / workflow;
        // the `updated` object on the final event carries the diff.
        if (ev.updated && Object.keys(ev.updated).length) {
          try {
            const freshRes = await apiFetch(`/api/agents/${encodeURIComponent(id)}`);
            const freshData = await freshRes.json();
            if (freshData.ok && freshData.agent && _selectedAgent?.id === id) {
              _selectedAgent.name = freshData.agent.name;
              _renderAgentDetail(freshData.agent, true);
              _agentsCache = null;
              await loadAgents(true);
              // Repaint the chat input recipient chip in case its bound
              // agent was the one just renamed by the edit chat.
              if (typeof _renderRecipientChip === 'function') {
                try { _renderRecipientChip(); } catch (_) { /* non-fatal */ }
              }
            }
          } catch (e) {
            _agentsLog.warn('refresh after updated fields failed', e);
          }
        }
      },
    },
  });
  return _agentChatCtrl;
}

async function _loadAgentChatHistory(agentId) {
  _ensureAgentChatController();
  await _agentChatCtrl.loadHistory();
  await _chatAttachRefreshFromServer(_agentEditAttachmentCid(agentId));
  // Custom empty-state message for fresh agents — controller's default is
  // "no messages..."; replace it with an agent-specific prompt when empty.
  const container = document.getElementById('agents-chat-messages');
  const empty = container?.querySelector('.empty');
  const defaultEmptyText = t('chat.empty');
  if (empty && (empty.textContent === defaultEmptyText || empty.textContent.includes('无对话记录') || empty.textContent.includes('No messages'))) {
    empty.textContent = t('agents.edit_chat_empty');
  }
}

async function clearAgentChat() {
  if (!_selectedAgent) return;
  if (!(await uiConfirm(t('agents.clear_confirm')))) return;
  _ensureAgentChatController();
  await _agentChatCtrl.clear();
}

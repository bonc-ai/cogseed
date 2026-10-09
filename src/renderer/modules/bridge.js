// cogseed-bridge permission prompts — when an external CLI agent (claude
// code / codex) asks to call one of the user's connected services through
// the bridge, main pushes `bridge:permission` and this module shows the
// allow-once / always-allow / deny choice. No answer (user closes the
// dialog or walks away) denies on the main-side timeout; replying to a
// stale request is harmless (`handled:false`).
//
// Requests queue FIFO so two concurrent CLI runs can't stack overlapping
// dialogs.

const _bridgeLog = createLogger('bridge');

const _bridgePermissionQueue = [];
let _bridgeDialogOpen = false;

async function _showBridgePermissionDialog(info) {
  const agent = info.agent_name || info.agent_id || '';
  const connector = info.connector_name || info.connector_id || '';
  const tool = info.tool_name || '';
  const choice = await uiChoice({
    title: t('bridge.permission.title'),
    message: t('bridge.permission.message', { agent, connector, tool }),
    cancelLabel: t('bridge.permission.deny'),
    choices: [
      { id: 'allow_once', label: t('bridge.permission.allow_once') },
      { id: 'allow_always', label: t('bridge.permission.allow_always'), style: '' },
    ],
  });
  const allow = choice === 'allow_once' || choice === 'allow_always';
  try {
    await window.cogseed.invoke('bridge.permission_response', {
      request_id: info.request_id,
      allow,
      always: choice === 'allow_always',
    });
    // conv-core M2.2：弹窗路径已答复，撤掉过程面板里的镜像卡（若存在）。
    if (typeof window.chatStreamDismissBashPermission === 'function') {
      try { window.chatStreamDismissBashPermission(info.request_id); } catch (_e) { /* ignore */ }
    }
  } catch (err) {
    _bridgeLog.warn('permission response failed', { error: err && err.message });
  }
}

async function _drainBridgePermissionQueue() {
  if (_bridgeDialogOpen) return;
  _bridgeDialogOpen = true;
  try {
    while (_bridgePermissionQueue.length) {
      const info = _bridgePermissionQueue.shift();
      await _showBridgePermissionDialog(info);
    }
  } finally {
    _bridgeDialogOpen = false;
  }
}

if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
  try {
    window.cogseed.onPushEvent('bridge:permission', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      _bridgePermissionQueue.push(info);
      // conv-core M2.2：外部服务调用审批镜像到会话过程面板（同 bash 桥接
      // 模式；弹窗照常，面板卡回复走同一 bridge.permission_response 通道，
      // 主进程幂等先到者生效）。
      if (typeof window.chatStreamBridgeBashPermission === 'function') {
        try {
          window.chatStreamBridgeBashPermission({
            request_id: info.request_id,
            agent_name: info.agent_name || info.agent_id || '',
            operation: info.tool_name ? `外部服务调用 ${info.tool_name}` : '外部服务调用',
            subject: info.connector_name || info.connector_id || '',
          }, { source: 'bridge' });
        } catch (_err) { /* 镜像失败不影响弹窗 */ }
      }
      _drainBridgePermissionQueue();
    });
  } catch (_err) { /* push channel unavailable; bridge calls deny on timeout */ }
}

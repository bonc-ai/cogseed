// External-agent launch-confirmation prompts — when a conversation
// is about to hand a message to an EXTERNAL CLI agent (claude code / codex
// / opencode / workbuddy …) for the first time in that conversation (per
// cid × agent × cli), main pushes `local-agents:launch-confirm` and this
// module shows the allow / deny choice. No answer (user closes the dialog
// or walks away) denies on the main-side timeout; replying to a stale
// request is harmless (`handled:false`).
//
// Requests queue FIFO so two concurrent CLI runs can't stack overlapping
// dialogs.

const _launchConfirmLog = createLogger('local-agents:launch-confirm');

const _launchConfirmQueue = [];
let _launchConfirmDialogOpen = false;

async function _showLaunchConfirmDialog(info) {
  const agent = info.agent_name || info.agent_id || '';
  const cli = info.cli || '';
  const choice = await uiChoice({
    title: t('cli_launch_confirm.title'),
    message: t('cli_launch_confirm.message', { agent, cli }),
    cancelLabel: t('cli_launch_confirm.deny'),
    choices: [
      { id: 'allow', label: t('cli_launch_confirm.allow') },
    ],
  });
  const allow = choice === 'allow';
  try {
    await window.cogseed.invoke('local-agents.launch_confirm_response', {
      request_id: info.request_id,
      allow,
      always: false,
    });
  } catch (err) {
    _launchConfirmLog.warn('launch confirm response failed', { error: err && err.message });
  }
}

async function _drainLaunchConfirmQueue() {
  if (_launchConfirmDialogOpen) return;
  _launchConfirmDialogOpen = true;
  try {
    while (_launchConfirmQueue.length) {
      const info = _launchConfirmQueue.shift();
      await _showLaunchConfirmDialog(info);
    }
  } finally {
    _launchConfirmDialogOpen = false;
  }
}

if (window.cogseed && typeof window.cogseed.onPushEvent === 'function') {
  try {
    window.cogseed.onPushEvent('local-agents:launch-confirm', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      _launchConfirmQueue.push(info);
      _drainLaunchConfirmQueue();
    });
  } catch (_err) { /* push channel unavailable; launch denies on timeout */ }
}

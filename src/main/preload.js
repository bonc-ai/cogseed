/**
 * Preload — exposes a minimal, explicitly-whitelisted API to the renderer
 * via contextBridge. No other Node capabilities leak into window.
 *
 * Contract (renderer-visible surface):
 *   window.orkas.ping()                            → { ok, pong, ts }
 *   window.orkas.diagnostics()                     → boot-time summary
 *   window.orkas.invoke(channel, payload)          → { ok, ...result } | { ok:false, error }
 *   window.orkas.stream(channel, payload, onEvent) → { promise, cancel }
 *       - promise resolves when the stream ends (normally or cancelled)
 *       - cancel() aborts the stream
 *       - onEvent(ev) called with each SSE-shape event
 *
 * Why {promise, cancel} instead of AbortSignal: with sandbox+contextIsolation
 * in place, objects crossing contextBridge have their prototype chain
 * stripped, so an AbortSignal from the renderer loses addEventListener.
 * A plain function is cloneable across contexts.
 *
 * Channel names are free-form strings routed by main/ipc/index.js.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Synchronous i18n boot — handed to the renderer via contextBridge before any
// renderer-side script runs. The renderer's i18n module reads window.__cogseedI18nBoot
// at script-tag execution time (line 1118 of index.html, after all data-i18n
// elements have been parsed), so applyDomI18n() can translate the DOM before
// the first paint. Falls back to a null bundle on failure — i18n.js then runs
// its old async initI18n() path. sendSync blocks for one short IPC round-trip
// (~1-2 ms); the trade is paying that for zero language-flash on startup.
let _i18nBoot = null;
try {
  const res = ipcRenderer.sendSync('cogseed:bootI18n');
  if (res && res.ok && res.lang && res.tables && Object.prototype.hasOwnProperty.call(res.tables, res.lang)) {
    _i18nBoot = { lang: res.lang, tables: res.tables };
  }
} catch (_) { /* main not ready / handler missing → renderer falls back to async */ }

let _streamCounter = 0;
function nextRequestId() {
  _streamCounter += 1;
  return `r${Date.now().toString(36)}-${_streamCounter.toString(36)}`;
}

function invoke(channel, payload) {
  return ipcRenderer.invoke('cogseed.invoke', { channel, payload: payload || {} });
}

const EXPENSE_WORKBENCH_GESTURE_TTL_MS = 1500;
const EXPENSE_WORKBENCH_PAGE_INSTANCE_PATTERN = /^ewpage_[A-Za-z0-9_-]{43}$/;
const EXPENSE_WORKBENCH_OPEN_TICKET_PATTERN = /^ewopen_[A-Za-z0-9_-]{43}$/;
const EXPENSE_WORKBENCH_CAPABILITY_PATTERN = /^ewcap_[A-Za-z0-9_-]{43}$/;
let _expenseWorkbenchCapability = '';
let _expenseWorkbenchPageInstance = '';
let _expenseWorkbenchPreparedOpen = null;
let _expenseWorkbenchGesture = null;
let _expenseWorkbenchRequestCounter = 0;
let _expenseWorkbenchLifecycleObserver = null;

function expenseWorkbenchElementFromPath(event, predicate) {
  const path = event && typeof event.composedPath === 'function'
    ? event.composedPath()
    : [event && event.target];
  for (const node of path) {
    if (node && typeof node.getAttribute === 'function' && predicate(node)) return node;
  }
  return null;
}

function captureExpenseWorkbenchGesture(event) {
  _expenseWorkbenchGesture = null;
  if (!event || event.isTrusted !== true || (typeof event.button === 'number' && event.button !== 0)) return;

  const detailButton = expenseWorkbenchElementFromPath(event, (node) => node.id === 'agent-manage-btn');
  if (detailButton && !detailButton.disabled && !detailButton.hidden
      && detailButton.getAttribute('aria-hidden') !== 'true') {
    const agentId = String(detailButton.getAttribute('data-expense-agent-id') || '');
    if (agentId) {
      _expenseWorkbenchGesture = { agentId, gesture: 'agent_detail', capturedAt: Date.now() };
      return;
    }
  }

  const useButton = expenseWorkbenchElementFromPath(
    event,
    (node) => typeof node.hasAttribute === 'function' && node.hasAttribute('data-agent-use'),
  );
  const card = useButton && typeof useButton.closest === 'function'
    ? useButton.closest('.agent-card[data-id]')
    : null;
  if (useButton && card && !useButton.disabled && useButton.getAttribute('aria-disabled') !== 'true') {
    const agentId = String(card.getAttribute('data-id') || '');
    if (agentId) _expenseWorkbenchGesture = { agentId, gesture: 'agent_card', capturedAt: Date.now() };
  }
}

function consumeExpenseWorkbenchGesture(agentId, gesture) {
  const captured = _expenseWorkbenchGesture;
  _expenseWorkbenchGesture = null;
  if (!captured || captured.agentId !== agentId || captured.gesture !== gesture
      || Date.now() - captured.capturedAt > EXPENSE_WORKBENCH_GESTURE_TTL_MS) {
    throw new Error('expense workbench requires a current trusted user action');
  }
}

function nextExpenseWorkbenchRequestNonce() {
  _expenseWorkbenchRequestCounter += 1;
  return `ewreq_${Date.now().toString(36)}_${_expenseWorkbenchRequestCounter.toString(36)}`;
}

function isExpenseWorkbenchSurfaceActive() {
  if (typeof document.getElementById !== 'function') return false;
  const panel = document.getElementById('panel-agents');
  const detail = document.getElementById('agents-detail-view');
  const host = document.getElementById('agent-management-surface');
  return !!panel && !!detail && !!host
    && panel.classList.contains('active')
    && detail.style.display !== 'none'
    && host.hidden === false;
}

function requireExpenseWorkbenchCapability() {
  if (!_expenseWorkbenchCapability || !_expenseWorkbenchPageInstance
      || !isExpenseWorkbenchSurfaceActive()) {
    throw new Error('expense workbench management surface is not active');
  }
  return {
    host_capability: _expenseWorkbenchCapability,
    page_instance: _expenseWorkbenchPageInstance,
  };
}

function expenseWorkbenchInvoke(channel, operationScope, payload) {
  const capability = requireExpenseWorkbenchCapability();
  return invoke(channel, {
    ...(payload || {}),
    ...capability,
    request_nonce: nextExpenseWorkbenchRequestNonce(),
    operation_scope: operationScope,
  });
}

async function closeExpenseWorkbenchCapability() {
  const capability = _expenseWorkbenchCapability;
  const pageInstance = _expenseWorkbenchPageInstance;
  _expenseWorkbenchCapability = '';
  _expenseWorkbenchPageInstance = '';
  _expenseWorkbenchPreparedOpen = null;
  if (!capability || !pageInstance) return { ok: true, closed: true };
  try {
    return await invoke('expenseWorkbench.close', {
      host_capability: capability,
      page_instance: pageInstance,
      request_nonce: nextExpenseWorkbenchRequestNonce(),
      operation_scope: 'close',
    });
  } catch (error) {
    throw error;
  }
}

function bindExpenseWorkbenchLifecycle() {
  if (_expenseWorkbenchLifecycleObserver || typeof MutationObserver !== 'function'
      || typeof document.getElementById !== 'function') return;
  const panel = document.getElementById('panel-agents');
  const detail = document.getElementById('agents-detail-view');
  const host = document.getElementById('agent-management-surface');
  if (!panel || !detail || !host) return;
  _expenseWorkbenchLifecycleObserver = new MutationObserver(() => {
    if (_expenseWorkbenchCapability && !isExpenseWorkbenchSurfaceActive()) {
      closeExpenseWorkbenchCapability().catch(() => {});
    }
  });
  _expenseWorkbenchLifecycleObserver.observe(panel, { attributes: true, attributeFilter: ['class'] });
  _expenseWorkbenchLifecycleObserver.observe(detail, { attributes: true, attributeFilter: ['style'] });
  _expenseWorkbenchLifecycleObserver.observe(host, { attributes: true, attributeFilter: ['hidden'] });
}

const expenseWorkbench = Object.freeze({
  prepareOpen: async (agentIdValue, gestureValue) => {
    const agentId = String(agentIdValue || '');
    const gesture = String(gestureValue || '');
    if (gesture !== 'agent_card' && gesture !== 'agent_detail') {
      throw new Error('invalid expense workbench open gesture');
    }
    consumeExpenseWorkbenchGesture(agentId, gesture);
    await closeExpenseWorkbenchCapability();
    const response = await ipcRenderer.invoke('orkas.expenseWorkbenchHost.prepareOpen', {
      agent_id: agentId,
      gesture,
    });
    if (!response || response.ok !== true
        || typeof response.open_ticket !== 'string'
        || !EXPENSE_WORKBENCH_OPEN_TICKET_PATTERN.test(response.open_ticket)
        || typeof response.page_instance !== 'string'
        || !EXPENSE_WORKBENCH_PAGE_INSTANCE_PATTERN.test(response.page_instance)) {
      throw new Error(response && response.error ? response.error : 'expense workbench open authorization failed');
    }
    _expenseWorkbenchPreparedOpen = {
      agentId,
      openTicket: response.open_ticket,
      pageInstance: response.page_instance,
    };
    return {
      ok: true,
      expires_at: typeof response.expires_at === 'string' ? response.expires_at : '',
    };
  },
  open: async (agentId) => {
    const normalizedAgentId = String(agentId || '');
    const prepared = _expenseWorkbenchPreparedOpen;
    _expenseWorkbenchPreparedOpen = null;
    if (!prepared || prepared.agentId !== normalizedAgentId) {
      throw new Error('expense workbench open authorization is missing or belongs to another Agent');
    }
    const response = await ipcRenderer.invoke('orkas.expenseWorkbenchHost.open', {
      open_ticket: prepared.openTicket,
      page_instance: prepared.pageInstance,
    });
    if (!response || response.ok !== true
        || typeof response.host_capability !== 'string'
        || !EXPENSE_WORKBENCH_CAPABILITY_PATTERN.test(response.host_capability)) {
      throw new Error(response && response.error ? response.error : 'expense workbench could not be opened');
    }
    _expenseWorkbenchCapability = response.host_capability;
    _expenseWorkbenchPageInstance = prepared.pageInstance;
    bindExpenseWorkbenchLifecycle();
    if (!isExpenseWorkbenchSurfaceActive()) {
      await closeExpenseWorkbenchCapability().catch(() => {});
      throw new Error('expense workbench page is no longer active');
    }
    return {
      ok: true,
      expires_at: typeof response.expires_at === 'string' ? response.expires_at : '',
      management_surface: response.management_surface === 'expense_workbench'
        ? response.management_surface
        : 'expense_workbench',
    };
  },
  status: () => expenseWorkbenchInvoke('expenseWorkbench.status', 'status', {}),
  configure: () => expenseWorkbenchInvoke('expenseWorkbench.pickAndConfigure', 'configure', {}),
  invoke: (operationValue, payload) => {
    const operation = String(operationValue || '');
    return expenseWorkbenchInvoke('expenseWorkbench.invoke', `invoke:${operation}`, {
      operation,
      payload: payload || {},
    });
  },
  invokeExternal: (operationValue, payload) => {
    const operation = String(operationValue || '');
    return expenseWorkbenchInvoke('expenseWorkbench.invokeExternal', `external:${operation}`, {
      operation,
      payload: payload || {},
    });
  },
  pickAndAddMaterials: (applicationId) => expenseWorkbenchInvoke(
    'expenseWorkbench.pickAndAddMaterials',
    `materials:add:${String(applicationId || '')}`,
    { application_id: String(applicationId || '') },
  ),
  approveApplication: (applicationId, approvalRole, decision, expectedArtifactHash, comment) => {
    const normalizedApplicationId = String(applicationId || '');
    const normalizedApprovalRole = String(approvalRole || '');
    const normalizedDecision = String(decision || '');
    const normalizedArtifactHash = String(expectedArtifactHash || '');
    return expenseWorkbenchInvoke(
      'expenseWorkbench.approveApplication',
      `approve:${normalizedApplicationId}:${normalizedApprovalRole}:${normalizedDecision}:${normalizedArtifactHash}`,
      {
        application_id: normalizedApplicationId,
        approval_role: normalizedApprovalRole,
        decision: normalizedDecision,
        expected_artifact_hash: normalizedArtifactHash,
        comment: String(comment || ''),
      },
    );
  },
  confirmAndSubmit: (applicationId, version, payloadHash) => expenseWorkbenchInvoke(
    'expenseWorkbench.confirmAndSubmit',
    `submit:${String(applicationId || '')}:${String(version)}:${String(payloadHash || '')}`,
    {
      application_id: String(applicationId || ''),
      version,
      payload_hash: String(payloadHash || ''),
    },
  ),
  close: async () => {
    try {
      return await closeExpenseWorkbenchCapability();
    } catch (_) {
      return { ok: true, closed: true };
    }
  },
});

window.addEventListener('click', captureExpenseWorkbenchGesture, true);
window.addEventListener('DOMContentLoaded', bindExpenseWorkbenchLifecycle, { once: true });
if (document.readyState !== 'loading') bindExpenseWorkbenchLifecycle();

/**
 * Resolve genuine DOM File objects to OS paths inside preload and immediately
 * hand them to main. Raw paths are never exposed to renderer JavaScript, and
 * file bytes never cross contextBridge/base64 IPC.
 */
function importLocalFiles(scope, files, opts) {
  const list = Array.isArray(files) ? files : Array.from(files || []);
  const entries = [];
  for (const file of list.slice(0, 200)) {
    try {
      const localPath = webUtils && typeof webUtils.getPathForFile === 'function'
        ? webUtils.getPathForFile(file)
        : '';
      if (!localPath) continue;
      entries.push({
        path: localPath,
        name: String((file && file.name) || ''),
        size: Math.max(0, Number((file && file.size) || 0)),
      });
    } catch (_) { /* synthetic/non-local File; caller can use the small-file fallback */ }
  }
  return ipcRenderer.invoke('cogseed.importLocalFiles', {
    scope: scope === 'project' ? 'project' : 'contexts',
    projectId: opts && opts.projectId ? String(opts.projectId) : '',
    targetDir: opts && opts.targetDir ? String(opts.targetDir) : '',
    entries,
  });
}

/**
 * Fire-and-forget log record forwarded to main, where it lands in the
 * daily file under a `renderer/<module>` scope. Use via the renderer-side
 * `createLogger(module)` wrapper — never call this directly from UI code.
 */
function logRecord(record) {
  try {
    // invoke is awaited-able but callers don't need to; swallow errors so
    // a logging failure never breaks user interaction.
    ipcRenderer.invoke('cogseed.invoke', {
      channel: 'log.record',
      payload: record || {},
    }).catch(() => {});
  } catch (_) { /* preload must not throw */ }
}

// Push-event subscription — for main-initiated broadcasts where the renderer doesn't drive
// the lifecycle (unlike `stream` which the renderer starts). Channel names are restricted to
// a known prefix list so the renderer can't tap into arbitrary internal IPC traffic.
const PUSH_EVENT_CHANNELS = new Set();
const PUSH_EVENT_PREFIXES = ['marketplace:', 'conversations:', 'connectors:', 'client-config:', 'delete_file.', 'bridge:', 'bash:', 'interactive-cli:', 'messaging:', 'personal-context:'];
function isAllowedPushChannel(channel) {
  if (typeof channel !== 'string') return false;
  return PUSH_EVENT_CHANNELS.has(channel) || PUSH_EVENT_PREFIXES.some((p) => channel.startsWith(p));
}

/** Subscribe to a main-initiated push event. Returns an `unsubscribe()` function.
 *  Throws if the channel isn't in the allow-list (see PUSH_EVENT_PREFIXES). */
function onPushEvent(channel, handler) {
  if (!isAllowedPushChannel(channel)) {
    throw new Error(`push channel not allowed: ${channel}`);
  }
  if (typeof handler !== 'function') throw new Error('handler must be a function');
  const listener = (_evt, payload) => {
    try { handler(payload); } catch (_) { /* swallow — listener must not throw */ }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function stream(channel, payload, onEvent) {
  const requestId = nextRequestId();
  const channelKey = `stream:${requestId}`;
  let settled = false;
  let cancelled = false;

  const promise = new Promise((resolve, reject) => {
    const listener = (_evt, ev) => {
      if (!ev || settled) return;
      if (ev.type === 'done') {
        settled = true;
        ipcRenderer.removeListener(channelKey, listener);
        if (cancelled) reject(Object.assign(new Error('stream cancelled'), { name: 'AbortError' }));
        else resolve();
        return;
      }
      try { onEvent && onEvent(ev); }
      catch (err) {
        settled = true;
        ipcRenderer.removeListener(channelKey, listener);
        ipcRenderer.send('cogseed.streamCancel', requestId);
        reject(err);
      }
    };

    ipcRenderer.on(channelKey, listener);
    ipcRenderer.send('cogseed.streamStart', { requestId, channel, payload: payload || {} });
  });

  const cancel = () => {
    if (settled || cancelled) return;
    cancelled = true;
    ipcRenderer.send('cogseed.streamCancel', requestId);
  };

  return { promise, cancel };
}

// Quality validator — renderer reads persisted ValidationReports to display the
// violation list when a write / install was rejected.
const quality = {
  readSkillReport: (id) => invoke('quality.readSkillReport', { id }),
  readAgentReport: (id) => invoke('quality.readAgentReport', { id }),
};

// Global recycle bin. Unlike `sync`, this stays available in offline builds:
// it contains both cloud-sync tombstones (when sync exists) and local in-app
// delete snapshots.
const recycleBin = {
  list: () => invoke('recycle.list'),
  restore: (id) => invoke('recycle.restore', { id: String(id || '') }),
  delete: (id) => invoke('recycle.delete', { id: String(id || '') }),
};

// Expose the sync-fetched i18n bundle on its own bridge key so the renderer
// can pick it up at module load. Read-only — the renderer never mutates it.
contextBridge.exposeInMainWorld('__cogseedI18nBoot', _i18nBoot);
contextBridge.exposeInMainWorld('__orkasI18nBoot', _i18nBoot);

const cogseedApi = {
  ping: () => ipcRenderer.invoke('cogseed.ping'),
  diagnostics: () => ipcRenderer.invoke('cogseed.diagnostics'),
  importLocalFiles,
  env: () => ipcRenderer.invoke('cogseed.env'),
  relaunch: () => ipcRenderer.invoke('cogseed.relaunch'),
  reportUserActivity: () => ipcRenderer.send('cogseed.userActivity'),
  getNativeSearchEnabled: () => invoke('devtools.getNativeSearchEnabled'),
  setNativeSearchEnabled: (enabled) => invoke('devtools.setNativeSearchEnabled', { enabled }),
  getLanguage: () => invoke('config.getLanguage'),
  setLanguage: (language) => invoke('config.setLanguage', { language }),
  getLocales: () => invoke('config.getLocales'),
  recycleBin,
  quality,
  expenseWorkbench,
  invoke,
  stream,
  onPushEvent,
  log: logRecord,
};
const orkasApi = new Proxy(cogseedApi, { get: (_target, prop) => cogseedApi[prop] });
contextBridge.exposeInMainWorld('cogseed', cogseedApi);
contextBridge.exposeInMainWorld('orkas', orkasApi);

// Final-package launch smoke. The main process adds this private renderer
// argument only when the release validator starts an isolated hidden window.
// A successful ping proves the preload bridge and main IPC handler both ran;
// DOMContentLoaded proves the packaged renderer was read and initialized.
if (process.argv.includes('--orkas-packaged-launch-smoke')) {
  window.addEventListener('DOMContentLoaded', () => {
    ipcRenderer.invoke('cogseed.ping')
      .then((ping) => ipcRenderer.invoke('cogseed.packagedLaunchSmokeReady', {
        preloadLoaded: true,
        ping: ping && ping.pong,
        rendererReadyState: document.readyState,
      }))
      .catch((error) => {
        console.error('[packaged-launch-smoke] preload/renderer readiness failed', error);
      });
  }, { once: true });
}

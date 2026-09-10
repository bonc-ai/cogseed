// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Settings-side owner for execution and collaboration administration. The
// Run Center consumes the same schema-v1 projections for monitoring only;
// gateway, Worktree, diagnostics, Agent, and channel management live here.
(function initCogSeedRunCenterSettings(root) {
  'use strict';

  const state = {
    active: false,
    bound: false,
    loadPromise: null,
    loadRevision: 0,
    registry: null,
    registryLoading: false,
    registryError: '',
    registryRevision: 0,
    gatewayBusy: {},
    gatewayErrors: {},
    worktrees: null,
    worktreesLoading: false,
    worktreesError: '',
    worktreeNotice: '',
    worktreeRevision: 0,
    worktreeBranch: '',
    worktreeBaseRef: 'HEAD',
    worktreeBusy: '',
    worktreeRowErrors: {},
    diagnostics: null,
    diagnosticsLoading: false,
    diagnosticsError: '',
    diagnosticsRevision: 0,
    pendingAnchor: '',
  };

  const log = typeof createLogger === 'function'
    ? createLogger('run-center-settings')
    : { warn() {} };

  function list(value) { return Array.isArray(value) ? value : []; }

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function text(key, fallback, params) {
    const value = typeof t === 'function' ? t(key, params) : key;
    return value && value !== key ? value : fallback || key;
  }

  function icon(name, className) {
    return typeof root.uiIconHtml === 'function' ? root.uiIconHtml(name, className) : '';
  }

  function button(options) {
    return typeof root.uiButton === 'function' ? root.uiButton(options) : '';
  }

  function empty(options) {
    return typeof root.uiEmptyState === 'function' ? root.uiEmptyState(options) : '';
  }

  function host(id) { return document.getElementById(id); }

  function invoke(channel, payload) {
    if (!root.cogseed?.invoke) return Promise.reject(new Error('IPC unavailable'));
    return root.cogseed.invoke(channel, payload);
  }

  function runtimeCli(runtime) {
    if (!runtime || runtime.sourceKind !== 'local-cli') return '';
    const value = String(runtime.runtimeKind || '').trim().toLocaleLowerCase();
    return /^[a-z0-9_-]+$/.test(value) ? value : '';
  }

  function activeTasksForCli(projection, cli) {
    return list(projection?.agents).reduce((count, agent) => {
      const match = String(agent?.runtimeKind || '').match(/^(?:cli|p3394-gateway):([a-z0-9_-]+)$/i);
      return count + (match?.[1]?.toLocaleLowerCase() === cli ? Number(agent?.stats?.active || 0) : 0);
    }, 0);
  }

  function gatewayRows(projection) {
    return list(projection?.runtimes).map((runtime) => {
      const cli = runtimeCli(runtime);
      return {
        runtimeId: String(runtime?.runtimeId || ''),
        displayName: String(runtime?.displayName || runtime?.runtimeKind || ''),
        sourceKind: String(runtime?.sourceKind || ''),
        runtimeKind: String(runtime?.runtimeKind || ''),
        installed: runtime?.installed === true,
        online: runtime?.online === true,
        enabled: runtime?.enabled === true,
        supported: runtime?.health !== 'unsupported',
        dispatchable: runtime?.dispatchable === true,
        health: String(runtime?.health || 'unknown'),
        cli,
        gatewayRunning: runtime?.gatewayRunning === true,
        gatewayControllable: runtime?.gatewayControllable === true,
        activeTaskCount: cli ? activeTasksForCli(projection, cli) : 0,
      };
    });
  }

  function canRemoveWorktree(item) {
    return !!(item
      && item.verifiable === true
      && item.dirty === false
      && typeof item.path === 'string'
      && item.path
      && typeof item.branch === 'string'
      && item.branch
      && typeof item.name === 'string'
      && item.name.startsWith('cogseed-worktree-'));
  }

  function worktreeErrorMessage(error) {
    const code = String(error?.code || error?.message || '');
    const suffix = code.startsWith('E_WORKTREE_')
      ? code.slice('E_WORKTREE_'.length).toLocaleLowerCase() : '';
    if (suffix) {
      const key = `run_center.worktree_error_${suffix}`;
      const translated = text(key, '');
      if (translated && translated !== key) return translated;
    }
    return text('run_center.worktree_error_unknown', 'The Worktree operation stopped safely.');
  }

  const SENSITIVE_DIAGNOSTIC_KEY = /(?:prompt|content|payload|output|credential|secret|token|password|argument|tool.?args?|path|working.?dir|endpoint|url)/i;
  const SENSITIVE_DIAGNOSTIC_TEXT = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|https?:\/\/|\bBearer\s+|\b(?:api[_-]?key|token|password|secret)\s*[:=]|\bsk-[A-Za-z0-9_-]{12,})/i;

  function sanitizeDiagnostics(value, depth = 0) {
    if (depth > 8) return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeDiagnostics(item, depth + 1)).filter((item) => item !== undefined);
    }
    if (value && typeof value === 'object') {
      const clean = {};
      for (const [key, entry] of Object.entries(value)) {
        if (SENSITIVE_DIAGNOSTIC_KEY.test(key)) continue;
        const next = sanitizeDiagnostics(entry, depth + 1);
        if (next !== undefined) clean[key] = next;
      }
      return clean;
    }
    if (typeof value === 'string' && SENSITIVE_DIAGNOSTIC_TEXT.test(value)) return '[redacted]';
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) return value;
    return undefined;
  }

  function mountOwnedSurfaces() {
    const agentsHost = host('run-center-settings-agents-host');
    const agentsPanel = host('panel-agents');
    if (agentsHost && agentsPanel && agentsPanel.parentElement !== agentsHost) {
      agentsPanel.classList.add('settings-embedded-panel');
      agentsHost.appendChild(agentsPanel);
    }
    const channelsHost = host('run-center-settings-channels-host');
    const touchpoints = document.querySelector('.touchpoint-settings-shell');
    if (channelsHost && touchpoints && touchpoints.parentElement !== channelsHost) {
      touchpoints.classList.add('settings-embedded-touchpoints');
      channelsHost.appendChild(touchpoints);
    }
  }

  function renderRegistry() {
    const target = host('run-center-settings-gateways');
    if (!target) return;
    const projection = state.registry;
    if (state.registryLoading && !projection) {
      target.innerHTML = empty({ kind: 'quiet', title: text('settings.execution.gateways_loading', 'Loading gateways…') });
      return;
    }
    if (state.registryError && !projection) {
      target.innerHTML = empty({
        kind: 'actionable',
        title: text('settings.execution.gateways_failed', 'Gateways are unavailable'),
        hint: state.registryError,
        icon: 'warning',
        action: {
          label: text('run_center.retry_load', 'Try again'),
          icon: 'refresh',
          attrs: { 'data-run-center-settings-gateways-retry': true },
        },
      });
      return;
    }
    const rows = gatewayRows(projection);
    const channels = list(projection?.channels);
    const warning = state.registryError
      ? `<div class="run-center-settings-warning" role="status">${icon('warning')}<span>${escapeText(text('settings.execution.stale', 'Showing the latest safe data. Refresh failed.', { error: state.registryError }))}</span></div>`
      : state.registryLoading
        ? `<div class="run-center-settings-refreshing" role="status">${escapeText(text('settings.execution.refreshing', 'Refreshing…'))}</div>` : '';
    const runtimeList = rows.length ? `<div class="run-center-settings-runtime-list">${rows.map((runtime) => {
      const busyAction = runtime.cli ? state.gatewayBusy[runtime.cli] : '';
      const locked = runtime.activeTaskCount > 0;
      const disabled = !runtime.cli || !runtime.gatewayControllable || locked || !!busyAction;
      const action = runtime.gatewayRunning ? 'stop' : 'start';
      const actionLabel = busyAction
        ? text(busyAction === 'start' ? 'run_center.agent_gateway_connecting' : 'run_center.agent_gateway_disconnecting', 'Working…')
        : text(runtime.gatewayRunning ? 'agents.gateway_stop' : 'agents.gateway_start', runtime.gatewayRunning ? 'Stop' : 'Start');
      const detail = locked
        ? text('run_center.agent_gateway_busy_help', 'An active task is using this gateway.')
        : !runtime.installed
          ? text('run_center.agent_gateway_not_installed_help', 'Install this executor first.')
          : !runtime.supported
            ? text('run_center.agent_gateway_unsupported_help', 'This gateway is unsupported.')
            : text('run_center.agent_gateway_help', 'Managed P3394 gateway control.');
      const status = text(`run_center.agent_health_${runtime.health}`, runtime.health);
      const control = runtime.cli ? button({
        label: actionLabel,
        role: runtime.gatewayRunning ? 'danger' : 'secondary',
        size: 'sm',
        loading: !!busyAction,
        disabled,
        attrs: {
          'data-run-center-settings-gateway': runtime.cli,
          'data-run-center-settings-gateway-action': action,
          'aria-label': text('run_center.agent_gateway_toggle_aria', `${actionLabel} ${runtime.displayName}`, { name: runtime.displayName }),
        },
      }) : '';
      const rowError = runtime.cli && state.gatewayErrors[runtime.cli]
        ? `<div class="run-center-settings-row-error" role="alert">${escapeText(state.gatewayErrors[runtime.cli])}</div>` : '';
      return `<article class="run-center-settings-runtime-row" data-runtime-id="${escapeText(runtime.runtimeId)}"><div><strong>${escapeText(runtime.displayName)}</strong><span>${escapeText(status)} · ${escapeText(runtime.dispatchable ? text('settings.execution.dispatchable', 'Runnable') : text('settings.execution.not_dispatchable', 'Not runnable'))}</span><small>${escapeText(detail)}</small></div><div class="run-center-settings-runtime-actions"><span>${escapeText(text(runtime.gatewayRunning ? 'run_center.agent_gateway_connected' : 'run_center.agent_gateway_disconnected', runtime.gatewayRunning ? 'On' : 'Off'))}</span>${control}</div>${rowError}</article>`;
    }).join('')}</div>` : empty({ kind: 'quiet', title: text('settings.execution.no_runtimes', 'No external executors detected') });
    const channelList = channels.length ? `<ul class="run-center-settings-channel-list">${channels.map((channel) => `<li><span>${icon('message-square')}</span><div><strong>${escapeText(channel.displayName || channel.channelId)}</strong><small>${escapeText(channel.platform || '')}</small></div><span class="run-center-agent-health is-${escapeText(channel.health || 'unknown')}">${escapeText(text(`run_center.agent_health_${channel.health}`, channel.health || 'unknown'))}</span></li>`).join('')}</ul>`
      : empty({ kind: 'quiet', title: text('settings.execution.no_channels', 'No message channels configured') });
    target.innerHTML = `${warning}<div class="run-center-settings-subsection"><header><h3>${escapeText(text('settings.execution.gateway_list', 'Managed gateways'))}</h3>${button({ label: text('common.refresh', 'Refresh'), size: 'sm', icon: 'refresh', attrs: { 'data-run-center-settings-gateways-retry': true } })}</header>${runtimeList}</div><div class="run-center-settings-subsection"><header><h3>${escapeText(text('settings.execution.channel_list', 'Message channel status'))}</h3></header>${channelList}</div>`;
  }

  function renderWorktrees() {
    const target = host('run-center-settings-worktrees');
    if (!target) return;
    const projection = state.worktrees;
    if (state.worktreesLoading && !projection) {
      target.innerHTML = empty({ kind: 'quiet', title: text('run_center.worktrees_loading', 'Loading Worktrees…') });
      return;
    }
    if (state.worktreesError && !projection) {
      target.innerHTML = empty({
        kind: 'actionable',
        title: text('settings.execution.worktrees_failed', 'Worktrees are unavailable'),
        hint: state.worktreesError,
        icon: 'warning',
        action: { label: text('run_center.retry_load', 'Try again'), icon: 'refresh', attrs: { 'data-run-center-settings-worktrees-retry': true } },
      });
      return;
    }
    const items = list(projection?.worktrees);
    const form = typeof root.uiForm === 'function' && typeof root.uiField === 'function'
      ? root.uiForm({
          ariaLabel: text('run_center.worktree_create_title', 'Create isolated Worktree'),
          columns: 2,
          fields: [
            root.uiField({
              id: 'run-center-settings-worktree-branch',
              label: text('run_center.worktree_branch', 'Branch'),
              required: true,
              control: { value: state.worktreeBranch, placeholder: text('run_center.worktree_branch_placeholder', 'dev/your-name'), disabled: !!state.worktreeBusy, attrs: { maxlength: 200, 'data-run-center-settings-worktree-branch': true } },
            }),
            root.uiField({
              id: 'run-center-settings-worktree-base',
              label: text('run_center.worktree_base', 'Base ref'),
              control: { value: state.worktreeBaseRef, placeholder: 'HEAD', disabled: !!state.worktreeBusy, attrs: { maxlength: 300, 'data-run-center-settings-worktree-base': true } },
            }),
          ],
          actions: [{
            label: text(state.worktreeBusy === 'create' ? 'run_center.worktree_creating' : 'run_center.worktree_create', 'Create Worktree'),
            role: 'primary',
            icon: 'plus',
            loading: state.worktreeBusy === 'create',
            disabled: !!state.worktreeBusy,
            attrs: { 'data-run-center-settings-worktree-create': true },
          }],
        }) : '';
    const rows = items.length ? `<ul class="run-center-settings-worktree-list">${items.map((item) => {
      const removable = canRemoveWorktree(item);
      const busy = state.worktreeBusy === item.path;
      const status = item.verifiable
        ? text(item.dirty ? 'run_center.worktree_dirty' : 'run_center.worktree_clean', item.dirty ? 'Dirty' : 'Clean')
        : text('run_center.worktree_unverified', 'Unverified');
      const rowError = state.worktreeRowErrors[item.path]
        ? `<div class="run-center-settings-row-error" role="alert">${escapeText(state.worktreeRowErrors[item.path])}</div>` : '';
      return `<li><div class="run-center-settings-worktree-heading"><span>${icon('git-branch')}</span><div><strong>${escapeText(item.branch || item.name)}</strong><small>${escapeText(item.name || '')}${item.head ? ` · ${escapeText(String(item.head).slice(0, 12))}` : ''}</small></div><span class="${removable ? 'is-clean' : 'is-blocked'}">${escapeText(status)}</span></div><code>${escapeText(item.path || '')}</code><div class="run-center-settings-worktree-actions">${button({
        label: text(busy ? 'run_center.worktree_removing' : 'run_center.worktree_remove', 'Remove Worktree'),
        role: 'danger',
        size: 'sm',
        icon: 'trash',
        loading: busy,
        disabled: !!state.worktreeBusy || !removable,
        attrs: {
          'data-run-center-settings-worktree-remove': item.path,
          'data-run-center-settings-worktree-branch': item.branch,
        },
      })}</div>${rowError}</li>`;
    }).join('')}</ul>` : empty({ kind: 'quiet', title: text('run_center.worktree_empty', 'No CogSeed-managed Worktrees') });
    const warning = state.worktreesError
      ? `<div class="run-center-settings-warning" role="status">${icon('warning')}<span>${escapeText(state.worktreesError)}</span>${button({ label: text('run_center.retry_load', 'Try again'), size: 'sm', attrs: { 'data-run-center-settings-worktrees-retry': true } })}</div>` : '';
    target.innerHTML = `${projection ? `<div class="run-center-settings-repository"><span>${escapeText(text('run_center.worktree_repository', 'Current repository'))}</span><strong>${escapeText(projection.repository?.branch || text('run_center.worktree_detached', 'Detached HEAD'))}</strong><code>${escapeText(projection.repository?.path || '')}</code></div>` : ''}<div data-run-center-settings-worktree-form>${form}</div>${warning}${state.worktreeNotice ? `<div class="run-center-settings-success" role="status">${escapeText(state.worktreeNotice)}</div>` : ''}${rows}<div class="run-center-settings-safety">${icon('shield')}<span>${escapeText(text('run_center.worktree_safety', 'Only verified, clean, managed Worktrees can be removed. Active-process safety is rechecked before removal.'))}</span></div>`;
  }

  function renderDiagnostics() {
    const target = host('run-center-settings-diagnostics');
    if (!target) return;
    const data = state.diagnostics;
    if (state.diagnosticsLoading && !data) {
      target.innerHTML = empty({ kind: 'quiet', title: text('run_center.diagnostics_loading', 'Loading diagnostics…') });
      return;
    }
    if (state.diagnosticsError && !data) {
      target.innerHTML = empty({
        kind: 'actionable',
        title: text('run_center.diagnostics_load_failed', 'Diagnostics are unavailable'),
        hint: state.diagnosticsError,
        icon: 'warning',
        action: { label: text('run_center.retry_load', 'Try again'), icon: 'refresh', attrs: { 'data-run-center-settings-diagnostics-retry': true } },
      });
      return;
    }
    const metric = (label, value) => `<div><span>${escapeText(text(label, label))}</span><strong>${escapeText(value == null ? '—' : value)}</strong></div>`;
    const warning = state.diagnosticsError
      ? `<div class="run-center-settings-warning" role="status">${icon('warning')}<span>${escapeText(text('settings.execution.stale', 'Showing the latest safe data. Refresh failed.', { error: state.diagnosticsError }))}</span></div>` : '';
    const content = data ? `<div class="run-center-diagnostic-metrics">${metric('run_center.diagnostic_tasks', data.taskCount)}${metric('run_center.diagnostic_sessions', data.sessionCount)}${metric('run_center.diagnostic_active', data.activeTaskCount)}${metric('run_center.diagnostic_attention', data.attentionTaskCount)}</div><div class="run-center-settings-diagnostics-actions">${button({ label: text('common.refresh', 'Refresh'), size: 'sm', icon: 'refresh', loading: state.diagnosticsLoading, attrs: { 'data-run-center-settings-diagnostics-retry': true } })}${button({ label: text('run_center.diagnostics_export', 'Export sanitized JSON'), role: 'primary', size: 'sm', icon: 'download', attrs: { 'data-run-center-settings-diagnostics-export': true } })}</div><div class="run-center-settings-safety">${icon('shield')}<span>${escapeText(text('run_center.diagnostics_privacy', 'The export excludes private content, credentials, arguments, output, and paths.'))}</span></div>` : '';
    target.innerHTML = `${warning}${content}`;
  }

  function renderAll() {
    mountOwnedSurfaces();
    renderRegistry();
    renderWorktrees();
    renderDiagnostics();
  }

  async function refreshRegistry() {
    const revision = ++state.registryRevision;
    state.registryLoading = true;
    state.registryError = '';
    renderRegistry();
    try {
      const projection = await invoke('cogseed.agent.list');
      if (!state.active || revision !== state.registryRevision) return;
      state.registry = projection;
      state.registryError = '';
    } catch (error) {
      if (!state.active || revision !== state.registryRevision) return;
      state.registryError = error?.message || String(error);
      log.warn('agent registry refresh failed', { error: state.registryError });
    } finally {
      if (state.active && revision === state.registryRevision) {
        state.registryLoading = false;
        renderRegistry();
      }
    }
  }

  async function refreshWorktrees() {
    const revision = ++state.worktreeRevision;
    state.worktreesLoading = true;
    state.worktreesError = '';
    renderWorktrees();
    try {
      const projection = await invoke('cogseed.worktree.list');
      if (!state.active || revision !== state.worktreeRevision) return;
      state.worktrees = projection;
      state.worktreesError = '';
    } catch (error) {
      if (!state.active || revision !== state.worktreeRevision) return;
      state.worktreesError = worktreeErrorMessage(error);
      log.warn('worktree refresh failed', { error: error?.message || String(error) });
    } finally {
      if (state.active && revision === state.worktreeRevision) {
        state.worktreesLoading = false;
        renderWorktrees();
      }
    }
  }

  async function refreshDiagnostics() {
    const revision = ++state.diagnosticsRevision;
    state.diagnosticsLoading = true;
    state.diagnosticsError = '';
    renderDiagnostics();
    try {
      const diagnostics = await invoke('cogseed.dashboard.diagnostics');
      if (!state.active || revision !== state.diagnosticsRevision) return;
      state.diagnostics = sanitizeDiagnostics(diagnostics);
      state.diagnosticsError = '';
    } catch (error) {
      if (!state.active || revision !== state.diagnosticsRevision) return;
      state.diagnosticsError = error?.message || String(error);
      log.warn('diagnostics refresh failed', { error: state.diagnosticsError });
    } finally {
      if (state.active && revision === state.diagnosticsRevision) {
        state.diagnosticsLoading = false;
        renderDiagnostics();
      }
    }
  }

  async function refreshAgentManagement() {
    if (typeof loadAgents !== 'function') return;
    try {
      await loadAgents(false);
      if (typeof refreshSelectedAgentDetail === 'function') await refreshSelectedAgentDetail();
    } catch (error) {
      log.warn('agent management refresh failed', { error: error?.message || String(error) });
    }
  }

  async function toggleGateway(cli, action) {
    const safeCli = String(cli || '').trim().toLocaleLowerCase();
    if (!/^[a-z0-9_-]+$/.test(safeCli) || state.gatewayBusy[safeCli]) return;
    const runtime = gatewayRows(state.registry).find((item) => item.cli === safeCli);
    const expectedAction = runtime?.gatewayRunning ? 'stop' : 'start';
    if (!runtime || action !== expectedAction || !runtime.gatewayControllable || runtime.activeTaskCount > 0) return;
    state.gatewayBusy = { ...state.gatewayBusy, [safeCli]: action };
    const nextErrors = { ...state.gatewayErrors };
    delete nextErrors[safeCli];
    state.gatewayErrors = nextErrors;
    renderRegistry();
    try {
      const result = await invoke(action === 'start' ? 'p3394.external.start' : 'p3394.external.stop', { cli: safeCli });
      if (!result?.ok) throw new Error(String(result?.error || 'gateway_action_failed'));
      if (state.active) await refreshRegistry();
    } catch (error) {
      if (state.active) {
        state.gatewayErrors = {
          ...state.gatewayErrors,
          [safeCli]: text('run_center.agent_gateway_failed', 'Could not change this gateway.'),
        };
        log.warn('gateway action failed', { cli: safeCli, action, error: error?.message || String(error) });
      }
    } finally {
      const busy = { ...state.gatewayBusy };
      delete busy[safeCli];
      state.gatewayBusy = busy;
      if (state.active) renderRegistry();
    }
  }

  async function createWorktree() {
    if (state.worktreeBusy) return;
    const branch = state.worktreeBranch.trim();
    if (!branch) {
      state.worktreesError = text('run_center.worktree_branch_required', 'Enter a branch name.');
      renderWorktrees();
      host('run-center-settings-worktree-branch')?.focus?.();
      return;
    }
    state.worktreeBusy = 'create';
    state.worktreesError = '';
    state.worktreeNotice = '';
    renderWorktrees();
    try {
      await invoke('cogseed.worktree.create', { branch, baseRef: state.worktreeBaseRef.trim() || 'HEAD' });
      if (!state.active) return;
      state.worktreeBranch = '';
      state.worktreeNotice = text('run_center.worktree_created', 'Worktree created locally.');
      await refreshWorktrees();
    } catch (error) {
      if (state.active) state.worktreesError = worktreeErrorMessage(error);
    } finally {
      state.worktreeBusy = '';
      if (state.active) renderWorktrees();
    }
  }

  async function removeWorktree(path, branch) {
    if (state.worktreeBusy) return;
    const item = list(state.worktrees?.worktrees).find((entry) => entry.path === path && entry.branch === branch);
    if (!canRemoveWorktree(item)) return;
    if (!root.confirm?.(text('run_center.worktree_remove_confirm', `Remove the clean Worktree for “${branch}”?`, { branch }))) return;
    state.worktreeBusy = path;
    state.worktreeNotice = '';
    const nextErrors = { ...state.worktreeRowErrors };
    delete nextErrors[path];
    state.worktreeRowErrors = nextErrors;
    renderWorktrees();
    try {
      await invoke('cogseed.worktree.remove', { path, expectedBranch: branch });
      if (!state.active) return;
      state.worktreeNotice = text('run_center.worktree_removed', 'Worktree removed; the branch was kept.');
      await refreshWorktrees();
    } catch (error) {
      if (state.active) {
        state.worktreeRowErrors = { ...state.worktreeRowErrors, [path]: worktreeErrorMessage(error) };
      }
    } finally {
      state.worktreeBusy = '';
      if (state.active) renderWorktrees();
    }
  }

  function exportDiagnostics() {
    if (!state.diagnostics) return;
    const safe = sanitizeDiagnostics(state.diagnostics);
    const payload = JSON.stringify({ format: 'cogseed-run-center-diagnostics', ...safe }, null, 2);
    const url = URL.createObjectURL(new Blob([`${payload}\n`], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `cogseed-run-center-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    root.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function bind() {
    const container = host('settings-execution-collaboration');
    if (!container || state.bound) return;
    state.bound = true;
    container.addEventListener('click', (event) => {
      const control = event.target?.closest?.('[data-run-center-settings-gateways-retry], [data-run-center-settings-gateway], [data-run-center-settings-worktrees-retry], [data-run-center-settings-worktree-create], [data-run-center-settings-worktree-remove], [data-run-center-settings-diagnostics-retry], [data-run-center-settings-diagnostics-export]');
      if (!control) return;
      if (control.dataset.runCenterSettingsGatewaysRetry !== undefined) { refreshRegistry(); return; }
      if (control.dataset.runCenterSettingsGateway !== undefined) {
        toggleGateway(control.dataset.runCenterSettingsGateway, control.dataset.runCenterSettingsGatewayAction);
        return;
      }
      if (control.dataset.runCenterSettingsWorktreesRetry !== undefined) { refreshWorktrees(); return; }
      if (control.dataset.runCenterSettingsWorktreeCreate !== undefined) { createWorktree(); return; }
      if (control.dataset.runCenterSettingsWorktreeRemove !== undefined) {
        removeWorktree(control.dataset.runCenterSettingsWorktreeRemove, control.dataset.runCenterSettingsWorktreeBranch);
        return;
      }
      if (control.dataset.runCenterSettingsDiagnosticsRetry !== undefined) { refreshDiagnostics(); return; }
      if (control.dataset.runCenterSettingsDiagnosticsExport !== undefined) exportDiagnostics();
    });
    container.addEventListener('submit', (event) => {
      if (!event.target?.closest?.('[data-run-center-settings-worktree-form]')) return;
      event.preventDefault();
      createWorktree();
    });
    container.addEventListener('input', (event) => {
      if (event.target?.matches?.('[data-run-center-settings-worktree-branch]')) {
        state.worktreeBranch = event.target.value || '';
        if (!event.isComposing) state.worktreesError = '';
      }
      if (event.target?.matches?.('[data-run-center-settings-worktree-base]')) {
        state.worktreeBaseRef = event.target.value || '';
      }
    });
    root.addEventListener?.('i18n-change', () => {
      if (state.active) renderAll();
    });
  }

  const ANCHORS = Object.freeze({
    agents: 'settings-execution-agents',
    gateways: 'settings-execution-gateways',
    channels: 'settings-execution-gateways',
    touchpoints: 'settings-execution-gateways',
    worktrees: 'settings-execution-worktrees',
    diagnostics: 'settings-execution-diagnostics',
    models: 'settings-model-authorizations',
  });

  function focusAnchor(anchor) {
    const id = ANCHORS[anchor] || ANCHORS.agents;
    const target = host(id);
    if (!target) return;
    target.scrollIntoView?.({ block: 'start', behavior: root.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth' });
    target.focus?.({ preventScroll: true });
  }

  async function load(options = {}) {
    state.active = true;
    state.pendingAnchor = options.anchor || state.pendingAnchor || root.__settingsConfigurationAnchor || '';
    mountOwnedSurfaces();
    bind();
    renderAll();
    if (!state.loadPromise) {
      const revision = ++state.loadRevision;
      const pending = Promise.all([
        refreshAgentManagement(),
        refreshRegistry(),
        refreshWorktrees(),
        refreshDiagnostics(),
      ]).finally(() => {
        if (state.loadRevision === revision && state.loadPromise === pending) state.loadPromise = null;
      });
      state.loadPromise = pending;
    }
    await state.loadPromise;
    if (state.active) root.setTimeout(() => focusAnchor(state.pendingAnchor), 0);
  }

  function activate(anchor) {
    state.active = true;
    state.pendingAnchor = anchor || state.pendingAnchor || '';
    void load({ anchor: state.pendingAnchor });
  }

  function deactivate() {
    state.active = false;
    state.loadRevision += 1;
    state.loadPromise = null;
    state.registryRevision += 1;
    state.worktreeRevision += 1;
    state.diagnosticsRevision += 1;
    state.registryLoading = false;
    state.worktreesLoading = false;
    state.diagnosticsLoading = false;
    state.gatewayBusy = {};
    state.worktreeBusy = '';
  }

  root.CogSeedRunCenterSettings = Object.freeze({
    activate,
    deactivate,
    load,
    refreshRegistry,
    refreshWorktrees,
    refreshDiagnostics,
    gatewayRows,
    canRemoveWorktree,
    sanitizeDiagnostics,
    focusAnchor,
    __state: state,
  });
})(window);

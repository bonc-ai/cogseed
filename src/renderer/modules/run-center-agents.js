// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

// Renders only the normalized Agent Registry projection. Runtime paths,
// credentials, endpoints, and private CLI session identifiers never enter it.
(function initCogSeedRunCenterAgents(root) {
  'use strict';

  const EXECUTOR_NAMES = Object.freeze({
    claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw', opencode: 'OpenCode',
    hermes: 'Hermes', workbuddy: 'WorkBuddy', gemini: 'Gemini', aider: 'Aider',
  });

  function list(value) { return Array.isArray(value) ? value : []; }

  function groupKey(value) {
    return String(value || '').trim().toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  }

  function executorCli(item) {
    const runtimeKind = String(item?.runtimeKind || '').trim().toLocaleLowerCase();
    const runtimeMatch = runtimeKind.match(/^(?:cli|p3394-gateway):([a-z0-9_-]+)$/);
    if (runtimeMatch) return runtimeMatch[1];
    if (item?.sourceKind === 'local-cli' && /^[a-z0-9_-]+$/.test(runtimeKind)) return runtimeKind;
    const runtimeId = String(item?.runtimeId || '').trim().toLocaleLowerCase();
    const idMatch = runtimeId.match(/^local-cli:([a-z0-9_-]+)$/);
    if (idMatch) return idMatch[1];
    const agentId = groupKey(item?.agentId);
    if (Object.prototype.hasOwnProperty.call(EXECUTOR_NAMES, agentId)) return agentId;
    const displayName = groupKey(item?.displayName);
    return Object.prototype.hasOwnProperty.call(EXECUTOR_NAMES, displayName) ? displayName : '';
  }

  function executorKey(item) {
    const cli = executorCli(item);
    if (cli) return `cli:${cli}`;
    if (item?.agentId) return `agent:${item.agentId}`;
    if (item?.runtimeId) return `runtime:${item.runtimeId}`;
    return `unknown:${groupKey(item?.displayName) || 'executor'}`;
  }

  function aggregateHealth(items) {
    const values = items.map((item) => item.health || 'unknown');
    for (const value of ['error', 'busy', 'ready', 'unsupported', 'offline', 'disabled']) {
      if (values.includes(value)) return value;
    }
    return 'unknown';
  }

  function aggregateStats(items) {
    return items.reduce((sum, item) => ({
      active: sum.active + Number(item.stats?.active || 0),
      completed: sum.completed + Number(item.stats?.completed || 0),
      failed: sum.failed + Number(item.stats?.failed || 0),
    }), { active: 0, completed: 0, failed: 0 });
  }

  function matchesState(item, filter) {
    if (filter === 'available') return item.dispatchable === true;
    if (filter === 'busy') return item.health === 'busy' || Number(item.stats?.active || 0) > 0;
    if (filter === 'attention') return item.health === 'error' || Number(item.stats?.failed || 0) > 0;
    if (filter === 'offline') return item.dispatchable !== true;
    return true;
  }

  function matchesQuery(item, query) {
    if (!query) return true;
    return [item.displayName, item.agentId, item.runtimeId, item.sourceKind, item.runtimeKind]
      .filter(Boolean)
      .some((value) => String(value).toLocaleLowerCase().includes(query));
  }

  function buildModel(projection, query = '', filter = 'all') {
    const agents = list(projection?.agents);
    const runtimes = list(projection?.runtimes);
    const channels = list(projection?.channels);
    const nativeAll = agents.filter((agent) => agent.sourceKind === 'cogseed');
    const externalAll = agents.filter((agent) => agent.sourceKind !== 'cogseed');
    const groups = new Map();
    for (const agent of externalAll) {
      const key = executorKey(agent);
      const group = groups.get(key) || { key, displayName: agent.displayName || agent.agentId, entries: [], runtimes: [] };
      group.entries.push(agent);
      groups.set(key, group);
    }
    for (const runtime of runtimes) {
      const key = executorKey(runtime);
      const group = groups.get(key) || { key, displayName: runtime.displayName || runtime.runtimeKind || runtime.runtimeId, entries: [], runtimes: [] };
      group.runtimes.push(runtime);
      groups.set(key, group);
    }
    const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
    const nativeAgents = nativeAll.filter((agent) => matchesQuery(agent, normalizedQuery) && matchesState(agent, filter));
    const externalExecutorsAll = [...groups.values()].map((group) => {
      const items = [...group.entries, ...group.runtimes];
      const runtime = group.runtimes.find((item) => item.sourceKind === 'local-cli') || group.runtimes[0];
      const stats = aggregateStats(group.entries);
      const installed = items.some((item) => item.installed === true);
      const dispatchable = items.some((item) => item.dispatchable === true);
      const gatewayControllable = runtime?.gatewayControllable === true;
      const gatewayRunning = runtime?.gatewayRunning === true;
      const current = group.entries.find((item) => item.currentTaskId)
        || group.entries.find((item) => item.currentConversationId)
        || group.entries[0];
      let health = aggregateHealth(items);
      if (stats.active > 0) health = 'busy';
      else if (items.some((item) => item.health === 'error')) health = 'error';
      else if (dispatchable) health = 'ready';
      else if (items.some((item) => item.health === 'unsupported')) health = 'unsupported';
      else if (!installed) health = 'offline';
      else if (gatewayControllable && !gatewayRunning) health = 'disconnected';
      return {
        ...group,
        cli: executorCli(runtime || group.entries[0]),
        displayName: EXECUTOR_NAMES[executorCli(runtime || group.entries[0])] || group.displayName,
        stats,
        health,
        installed,
        dispatchable,
        gatewayControllable,
        gatewayRunning,
        currentTaskId: current?.currentTaskId,
        currentConversationId: current?.currentConversationId,
        latest: items.map((item) => item.lastActiveAt).filter(Boolean).sort().at(-1),
      };
    });
    const externalExecutors = externalExecutorsAll.filter((group) => {
      const queryMatch = !normalizedQuery || [group.displayName, ...group.entries.flatMap((item) => [item.agentId, item.sourceKind, item.runtimeKind]), ...group.runtimes.flatMap((item) => [item.runtimeId, item.sourceKind, item.runtimeKind])]
        .filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(normalizedQuery));
      return queryMatch && matchesState(group, filter);
    });
    const nativeStats = aggregateStats(nativeAgents);
    const allStats = aggregateStats(agents);
    return {
      agents,
      runtimes,
      channels,
      nativeAgents,
      nativeGroup: nativeAgents.length ? {
        members: nativeAgents,
        stats: nativeStats,
        health: aggregateHealth(nativeAgents),
        dispatchable: nativeAgents.some((item) => item.dispatchable),
        latest: nativeAgents.map((item) => item.lastActiveAt).filter(Boolean).sort().at(-1),
      } : null,
      externalExecutors,
      counts: {
        native: nativeAll.length,
        external: externalExecutorsAll.length,
        busy: allStats.active,
        attention: allStats.failed,
      },
    };
  }

  function render(projection, options) {
    const { text, esc, icon, formatDate, stateView, dynamicLabel } = options;
    if (options.loading && !projection) return stateView('run_center.agents_loading');
    if (options.error && !projection) return stateView('run_center.agents_failed', options.error);
    const model = buildModel(projection, options.search, options.filter);
    const health = (value) => dynamicLabel('run_center.agent_health_', value, 'run_center.agent_health_unknown');
    const metric = (value, label) => `<span><b>${esc(value)}</b>${esc(text(label))}</span>`;
    const activity = (value) => value ? text('run_center.agent_last_active', { time: formatDate(value) }) : '';
    const stats = (value) => {
      const items = [
        value.active ? text('run_center.agent_active_tasks', { count: value.active }) : '',
        value.completed ? text('run_center.agent_completed_tasks', { count: value.completed }) : '',
        value.failed ? text('run_center.agent_failed_tasks', { count: value.failed }) : '',
      ].filter(Boolean);
      return items.length ? `<div class="run-center-registry-stats">${items.map((item) => `<span>${esc(item)}</span>`).join('')}</div>` : '';
    };
    const actions = (agent) => `<div class="run-center-registry-actions">${agent.currentTaskId ? `<button type="button" class="btn btn-sm" data-run-center-agent-task="${esc(agent.currentTaskId)}">${icon('panel-list')}<span>${esc(text('run_center.agent_open_current_task'))}</span></button>` : ''}${agent.currentConversationId ? `<button type="button" class="run-center-icon-btn" data-run-center-agent-conversation="${esc(agent.currentConversationId)}" title="${esc(text('run_center.agent_open_current_conversation'))}" aria-label="${esc(text('run_center.agent_open_current_conversation'))}">${icon('message-square')}</button>` : ''}</div>`;

    const memberRow = (agent) => `<article class="run-center-registry-instance is-native"><div class="run-center-registry-instance-main"><strong>${esc(agent.displayName || agent.agentId)}</strong>${activity(agent.lastActiveAt) ? `<small>${esc(activity(agent.lastActiveAt))}</small>` : ''}</div><span class="run-center-agent-health is-${esc(agent.health || 'unknown')}">${esc(health(agent.health))}</span>${stats(agent.stats || {})}${actions(agent)}</article>`;
    const nativeGroup = model.nativeGroup ? `<section class="run-center-registry-section is-native"><header><div><h2>${esc(text('run_center.native_agents_section'))}</h2><p>${esc(text('run_center.native_agents_section_detail'))}</p></div></header><details class="run-center-native-agent-group"><summary><span class="run-center-registry-type-icon">${icon('users')}</span><div class="run-center-registry-identity"><strong>${esc(text('run_center.native_agent_group'))}</strong><span>${esc(text('run_center.native_agent_group_detail'))}</span></div><span class="run-center-native-count">${esc(text('run_center.native_agent_members', { count: model.nativeGroup.members.length }))}</span>${stats(model.nativeGroup.stats)}${icon('chevron-down', 'run-center-agent-group-chevron')}</summary><div class="run-center-agent-group-body">${model.nativeGroup.members.map(memberRow).join('')}</div></details></section>` : '';

    const externalRows = model.externalExecutors.map((executor) => {
      const busyAction = String(options.busyGateway || '');
      const isGatewayBusy = busyAction.startsWith(`${executor.cli}:`);
      const gatewayAction = busyAction.endsWith(':start') ? 'start' : 'stop';
      const gatewayLocked = executor.stats.active > 0;
      const gatewayDisabled = !executor.gatewayControllable || gatewayLocked || isGatewayBusy;
      const gatewayStateKey = isGatewayBusy
        ? (gatewayAction === 'start' ? 'run_center.agent_gateway_connecting' : 'run_center.agent_gateway_disconnecting')
        : executor.gatewayRunning
          ? 'run_center.agent_gateway_connected'
          : 'run_center.agent_gateway_disconnected';
      const gatewayHelpKey = gatewayLocked
        ? 'run_center.agent_gateway_busy_help'
        : !executor.installed
          ? 'run_center.agent_gateway_not_installed_help'
          : executor.health === 'unsupported'
            ? 'run_center.agent_gateway_unsupported_help'
            : 'run_center.agent_gateway_help';
      const detailKey = executor.runtimes.some((runtime) => runtime.sourceKind === 'p3394' && runtime.runtimeKind === 'p3394-remote')
        ? 'run_center.agent_executor_remote_detail'
        : !executor.installed
          ? 'run_center.agent_executor_not_installed_detail'
          : executor.health === 'unsupported'
            ? 'run_center.agent_executor_unsupported_detail'
            : 'run_center.agent_executor_installed_detail';
      const gatewayControl = executor.cli ? `<label class="toggle-switch run-center-executor-toggle" title="${esc(text(gatewayHelpKey))}"><span class="run-center-executor-toggle-copy"><strong>${esc(text('run_center.agent_gateway_control'))}</strong><small>${esc(text(gatewayStateKey))}</small></span><input type="checkbox" data-run-center-agent-gateway="${esc(executor.cli)}" aria-label="${esc(text('run_center.agent_gateway_toggle_aria', { name: executor.displayName }))}"${executor.gatewayRunning ? ' checked' : ''}${gatewayDisabled ? ' disabled' : ''}></label>` : '';
      const rowError = executor.cli && options.gatewayError === executor.cli ? `<small class="run-center-executor-error" role="status">${esc(text('run_center.agent_gateway_failed'))}</small>` : '';
      return `<article class="run-center-executor-row"><span class="run-center-registry-mark">${esc(String(executor.displayName || '?').slice(0, 1).toLocaleUpperCase())}</span><div class="run-center-registry-identity"><strong>${esc(executor.displayName)}</strong><span>${esc(text(detailKey))}</span>${activity(executor.latest) ? `<small>${esc(activity(executor.latest))}</small>` : ''}</div><span class="run-center-agent-health is-${esc(executor.health)}">${esc(health(executor.health))}</span>${stats(executor.stats)}${actions(executor)}${gatewayControl}${rowError}</article>`;
    }).join('');
    const hasExternalMatches = !!externalRows;
    const externalContent = `<div class="run-center-executor-list">${externalRows}</div>`;

    const channelRows = model.channels.map((channel) => `<li class="run-center-registry-row is-channel">
      <span class="run-center-registry-type-icon">${icon('message-square')}</span>
      <div class="run-center-registry-identity"><strong>${esc(channel.displayName || channel.channelId)}</strong><span>${esc(channel.platform || text('run_center.agent_channel_unknown'))}</span>${activity(channel.lastActiveAt) ? `<small>${esc(activity(channel.lastActiveAt))}</small>` : ''}</div>
      <span class="run-center-agent-health is-${esc(channel.health || 'unknown')}">${esc(health(channel.health))}</span>
      <span class="run-center-channel-role">${esc(text('run_center.agent_channel_role'))}</span>
    </li>`).join('');

    return `<div class="run-center-agent-registry">
      ${options.error ? `<div class="run-center-registry-warning" role="status">${icon('warning')}<span>${esc(text('run_center.agents_stale', { error: options.error }))}</span></div>` : ''}
      <div class="run-center-registry-summary" aria-label="${esc(text('run_center.agents_summary'))}">${metric(model.counts.native, 'run_center.agent_native_count')}${metric(model.counts.external, 'run_center.agent_external_count')}${metric(model.counts.busy, 'run_center.agent_busy_task_count')}${metric(model.counts.attention, 'run_center.agent_attention_task_count')}</div>
      <div class="run-center-registry-toolbar is-global"><label>${icon('search')}<input type="search" value="${esc(options.search || '')}" data-run-center-agent-search placeholder="${esc(text('run_center.agent_search_placeholder'))}" aria-label="${esc(text('run_center.agent_search_placeholder'))}"></label><div class="run-center-registry-filters">${['all', 'available', 'busy', 'attention', 'offline'].map((value) => `<button type="button" data-run-center-agent-filter="${value}" aria-pressed="${String((options.filter || 'all') === value)}" class="${(options.filter || 'all') === value ? 'is-active' : ''}">${esc(text(`run_center.agent_filter_${value}`))}</button>`).join('')}</div></div>
      ${nativeGroup}
      <section class="run-center-registry-section is-external"><header><div><h2>${esc(text('run_center.external_agents_section'))}</h2><p>${esc(text('run_center.external_agents_section_detail'))}</p></div></header>${hasExternalMatches ? externalContent : stateView(model.counts.external ? 'run_center.agents_no_matches' : 'run_center.runtimes_empty')}</section>
      ${channelRows ? `<section class="run-center-registry-section"><header><div><h2>${esc(text('run_center.channels_section'))}</h2><p>${esc(text('run_center.channels_section_detail'))}</p></div></header><ul>${channelRows}</ul></section>` : ''}
    </div>`;
  }

  root.CogSeedRunCenterAgents = Object.freeze({ buildModel, render });
})(window);

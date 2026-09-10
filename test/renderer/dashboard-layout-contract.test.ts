// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
const html = read('src/renderer/index.html');
const lazy = read('src/renderer/modules/lazy-features.js');
const boot = read('src/renderer/modules/boot.js');
const runCenter = read('src/renderer/modules/run-center.js');
const globalRunCenter = read('src/renderer/modules/run-center-global.js');
const runCenterModel = read('src/renderer/modules/run-center-model.js');
const board = read('src/renderer/modules/run-center-board.js');
const detail = read('src/renderer/modules/run-center-detail.js');
const agents = read('src/renderer/modules/run-center-agents.js');
const css = read('src/renderer/style.css');
const zh = JSON.parse(read('src/renderer/locales/zh.json'));
const en = JSON.parse(read('src/renderer/locales/en.json'));

describe('unified Agent Operations Center layout contract', () => {
  it('moves the primary entry to the top toolbar while retaining a hidden compatibility target', () => {
    expect(html).toMatch(/id="run-center-btn"[^>]*hidden[^>]*aria-hidden="true"/);
    expect(html).toContain('id="run-center-global-entry"');
    expect(html).not.toMatch(/<button[^>]*id="run-center-global-btn"/);
    expect(globalRunCenter).toContain("className: 'run-center-global-btn'");
    expect(globalRunCenter).toContain("id: 'run-center-global-btn'");
    expect(globalRunCenter).toContain("badge.id = 'run-center-global-badge'");
    expect(globalRunCenter).toContain("root.uiEmptyState(options)");
    expect(html).toContain('id="panel-run-center"');
    expect(html).not.toContain('id="dashboard-btn"');
    expect(html).not.toContain('id="panel-dashboard"');
    expect(css).toMatch(/\.sidebar-btn#run-center-btn\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
    expect(lazy).not.toContain('dashboard: [');
    expect(zh['run_center.title']).toBe(zh['run_center.global_title']);
    expect(en['run_center.title']).toBe(en['run_center.global_title']);
  });

  it('does not expose a dead return control when no Run Center context exists', () => {
    expect(html).toMatch(/id="run-center-return-btn"[\s\S]{0,240}?hidden/);
    expect(css).toMatch(/\.chat-header-details-btn\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
    expect(boot).toContain('runCenterReturnButton.hidden = !window.__runCenterReturnContext');
  });

  it('redirects the legacy dashboard route to the unified Agent view', () => {
    expect(boot).toContain("const openLegacyAgentDashboard = view === 'dashboard'");
    expect(boot).toContain("if (openLegacyAgentDashboard) view = 'run-center'");
    expect(boot).toContain("openLegacyAgentDashboard ? 'agents' : opts.runCenterView");
    expect(boot).not.toContain("view === 'dashboard' ? 'panel-dashboard'");
  });

  it('normalizes legacy Run Center deep links before panel routing', () => {
    for (const route of ['overview', 'board', 'runs', 'tasks', 'sessions', 'history', 'execution', 'collaboration']) {
      expect(boot).toContain(`'${route}'`);
    }
    expect(boot).toContain('const runCenterInitialView = legacyRunCenterView || requestedRunCenterView;');
    expect(boot).toContain("if (legacyRunCenterView) view = 'run-center'");
  });

  it('exposes exactly three top-level views in the Phase 1 order', () => {
    const definition = runCenter.match(/const VIEW_DEFINITIONS = Object\.freeze\(\[[\s\S]*?\]\);/)?.[0] || '';
    expect(definition.match(/\['/g) || []).toHaveLength(3);
    const views = [
      "['tasks', 'run_center.view_tasks']",
      "['agents', 'run_center.view_agents']",
      "['collaboration', 'run_center.view_collaboration']",
    ];
    for (const view of views) expect(definition).toContain(view);
    expect(views.map((view) => definition.indexOf(view))).toEqual(
      [...views.map((view) => definition.indexOf(view))].sort((left, right) => left - right),
    );
    expect(definition).not.toContain("['overview'");
    expect(definition).not.toContain("['runs'");
    expect(definition).not.toContain("['history'");
    expect(runCenter).toContain("const views = VIEW_DEFINITIONS.map(([view]) => view)");
    expect(lazy).toContain("'./modules/run-center-agents.js'");
    expect(runCenter).toContain("invoke('cogseed.agent.list')");
    expect(runCenter).toContain('rootWindow.openRunCenterView');
  });

  it('uses one compact navigation and action row without a visible duplicate page title', () => {
    expect(runCenter).toContain('<header class="run-center-header is-compact"><h1 class="ui-visually-hidden">');
    expect(runCenter).toMatch(/<header class="run-center-header is-compact">[\s\S]*?<nav class="run-center-navigation">[\s\S]*?<div class="run-center-header-actions">/);
    expect(css).toMatch(/#panel-run-center \.run-center-header\s*{[^}]*min-height:\s*44px;[^}]*border-bottom:\s*1px solid var\(--rc-line\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-header\.is-compact \.run-center-navigation\s*{[^}]*height:\s*44px;[^}]*overflow:\s*hidden;/);
  });

  it('nests current and history under Tasks with their required default modes', () => {
    expect(runCenter).toContain('data-run-center-task-scope="${value}"');
    expect(runCenter).toContain("['current', 'run_center.scope_current']");
    expect(runCenter).toContain("['history', 'run_center.scope_history']");
    expect(runCenter).toContain("catch { return 'board'; }");
    expect(runCenter).toContain("detailTab: 'summary'");
    expect(runCenter).toContain("['queue', 'list', 'run_center.mode_queue']");
    expect(runCenter).toContain("['board', 'layout-grid', 'run_center.mode_board']");
    expect(runCenter).toContain('data-run-center-mode="${mode}"');
    expect(runCenter).toContain("const runHistory = state.view === 'history'");
    expect(runCenter).toContain("} else if (nextView === 'history') {");
    expect(runCenter).toContain("state.runMode = 'queue';");
    expect(runCenter).toContain("is-${esc(state.runMode)}-mode");
    expect(runCenter).toContain('is-history');
    expect(runCenter).toContain('<aside class="run-center-run-list-pane');
    expect(runCenter).toContain('<main class="run-center-run-detail-pane">${detailView.renderDetails()}</main>');
    expect(detail).toContain("['summary', 'run_center.detail_summary']");
    expect(detail).toContain("['history', 'run_center.detail_history']");
    expect(detail).toContain('data-run-center-detail-tab="${tab}"');
    expect(detail).toContain("activeTab === 'history' ? historyTabHtml(model)");
    expect(detail).toContain("activeTab === 'collaboration' ? renderCollaboration()");
    expect(runCenter).not.toContain('detailsDrawerHtml');
    expect(runCenter).toContain('class="run-center-layout is-collaboration"');
    expect(runCenter).toContain("state.view === 'collaboration'");
    expect(runCenter).toContain('function collaborationWorkspaceHtml()');
    expect(runCenter).toContain('run-center-collaboration-run-list');
  });

  it('keeps refresh states, derived data, and ARIA tab relationships explicit', () => {
    expect(runCenter).toContain("refreshing: false");
    expect(runCenter).toContain("stale: false");
    expect(runCenter).toContain('data-run-center-state="${esc(state.dataState)}"');
    expect(runCenter).toContain('aria-busy="${String(state.loading || state.refreshing)}"');
    expect(runCenter).toContain('data-run-center-stale-retry');
    expect(runCenter).toContain('if (derivedProjection !== state.board)');
    expect(runCenter).toContain('runModels: derived.runs, sequenceByKey: derived.sequence');
    expect(runCenter).toContain('filteredRunProjection === state.board');
    expect(runCenter).toContain('filteredRunSignature === signature');
    expect(runCenter).toContain('filteredRuns: filteredActiveRuns, archivedRuns: filteredArchivedRuns');
    expect(board).toContain('Array.isArray(options.runModels) ? options.runModels : buildRunModels(projection)');
    expect(board).toContain('Array.isArray(options.filteredRuns)');
    expect(board).toContain('Array.isArray(options.archivedRuns)');

    expect(runCenter).toContain('id="run-center-task-scope-${value}" role="tab"');
    expect(runCenter).toContain('aria-controls="run-center-panel-tasks" aria-selected="${String(scope === value)}"');
    expect(runCenter).toContain('function handleTaskScopeKeydown(event)');
    expect(runCenter).toContain('function handleDetailTabKeydown(event)');
    expect(runCenter).toContain('function handleAttemptKeydown(event)');
    expect(detail).toContain('id="run-center-detail-tab-${tab}" role="tab" aria-controls="run-center-detail-panel"');
    expect(detail).toContain('id="run-center-detail-panel" role="tabpanel" aria-labelledby="run-center-detail-tab-${activeTab}"');
    expect(detail).toContain('id="run-center-attempt-tab-${index}" role="tab" aria-controls="run-center-attempt-panel"');
    expect(detail).toContain('id="run-center-attempt-panel" role="tabpanel"');
    expect(detail).toContain('return root.uiButton(options)');
    expect(detail).toContain('return root.uiIconButton(options)');
    expect(runCenter).toContain("rootWindow.uiEmptyState(options)");
    expect(runCenter).toContain("className: 'run-center-query-clear'");
    expect(runCenter).toContain("'data-run-center-stale-retry': true");

    expect(globalRunCenter).toContain("target.setAttribute('aria-busy', String(state.loading || state.refreshing))");
    expect(globalRunCenter).toContain("target.setAttribute('aria-labelledby', 'run-center-quick-title')");
    expect(globalRunCenter).toContain('data-run-center-global-retry');
  });

  it('maps every legacy secondary route to the new Tasks scopes', () => {
    const aliases = runCenter.match(/const VIEW_ALIASES = Object\.freeze\(\{[\s\S]*?\}\);/)?.[0] || '';
    for (const route of ['overview', 'runs', 'tasks', 'board']) {
      expect(aliases).toMatch(new RegExp(`${route}: 'runs'`));
    }
    for (const route of ['history', 'sessions', 'execution']) {
      expect(aliases).toMatch(new RegExp(`${route}: 'history'`));
    }
    expect(aliases).toContain("agents: 'agents'");
    expect(aliases).toContain("collaboration: 'collaboration'");
  });

  it('keeps the global projection resident without loading Chart.js or the full Run Center', () => {
    expect(html).toContain('<script src="./modules/run-center-model.js"></script>');
    expect(html).toContain('<script src="./modules/run-center-global.js"></script>');
    expect(lazy).not.toContain('chart.umd.min.js');
    expect(lazy).toContain("{ src: './modules/run-center.js' }");
    expect(globalRunCenter).toContain("invoke('cogseed.task.list')");
    expect(globalRunCenter).toContain("root.cogseed.stream('cogseed.dashboard.watch'");
    expect(globalRunCenter).not.toContain('Chart');
    expect(globalRunCenter).not.toContain('loadRendererFeature');
    expect(runCenterModel).toContain('function buildGlobalSnapshot');
    expect(board).toContain('const { logicalRunKey, safeTime, buildRunSequence, userStateForTask, buildRunModels } = root.CogSeedRunCenterModel;');
  });

  it('keeps every queue filter visible in the empty state and preserves compact navigation alignment', () => {
    const queueHtml = runCenter.match(/function queueHtml\(\) \{[\s\S]*?return board\.renderQueue/)?.[0] || '';
    expect(queueHtml).toContain("state.runAgentFilter !== 'all'");
    expect(queueHtml).toContain("state.runTimeFilter !== 'all'");
    expect(queueHtml).toContain('state.showArchived');
    expect(runCenter).toContain("message.includes('E_RUN_CENTER_SPACE_WORKSPACE_MISMATCH')");
    expect(css).not.toMatch(/@container run-center \(max-width:\s*720px\)\s*\{[\s\S]*?#panel-run-center \.run-center-navigation\s*\{[^}]*margin-top:\s*9px;/);
    expect(css).not.toMatch(/@media \(max-width:\s*720px\)\s*\{[\s\S]*?#panel-run-center \.run-center-navigation\s*\{[^}]*margin-top:\s*9px;/);
  });

  it('opens collaboration only when the selected run has collaboration evidence', () => {
    expect(detail).toContain('function collaborationAvailable(collaboration, task)');
    expect(detail).toContain('const hasCollaboration = collaborationAvailable(collaboration, task);');
    expect(detail).toContain("hasCollaboration ? ['collaboration', 'run_center.detail_collaboration'] : null");
    expect(detail).toContain("state.detailTab === 'collaboration' && !hasCollaboration ? 'summary' : state.detailTab");
    expect(detail).toContain("'data-run-center-detail-tab': 'collaboration'");
    expect(runCenter).toContain("else if (nextView === 'collaboration') {");
    expect(runCenter).toContain('state.view = nextView;');
    expect(runCenter).toContain("state.detailTab = 'collaboration';");
    expect(runCenter).toContain('collaborationWorkspaceHtml()');
  });

  it('keeps logical run, attempt, and sequence identity stable across refreshes', () => {
    expect(runCenterModel).toContain('function logicalRunKey(task)');
    expect(runCenterModel).toContain('function buildRunModels(projection)');
    expect(runCenterModel).toContain('function buildRunSequence(runs)');
    expect(board).toContain('data-dashboard-board-run-key="${esc(run.key)}"');
    expect(board).toContain('data-run-center-queue-run-key="${esc(run.key)}"');
    expect(runCenter).toContain('selectedRunKey:');
    expect(runCenter).toContain('selectedAttemptKey:');
    expect(runCenter).toContain('function runSequenceByKey()');
    expect(board).toContain('function buildAttemptModels(run)');
    expect(board).toContain('function reconcileAttemptSelection(run, preferredKey, preferredTaskId)');
    expect(detail).toContain('data-run-center-attempt-index="${index}"');
    expect(runCenter).toContain('runKey: run.key, attemptKey: attempt?.key ||');
    expect(runCenter).toContain('retainedSelection ? state.selectedAttemptKey :');
    expect(runCenter).toContain('state.selectedRunKey');
  });

  it('groups built-in roles while keeping external executors and channels semantically separate', () => {
    expect(agents).toContain('run_center.native_agents_section');
    expect(agents).toContain('run_center.native_agent_group');
    expect(agents).toContain('run_center.external_agents_section');
    expect(agents).toContain('run_center.channels_section');
    expect(agents).toContain('run_center.agent_channel_role');
    expect(agents).not.toContain('.endpoint');
    expect(agents).not.toContain('.token');
    expect(agents).not.toContain('.path');
    expect(css).toMatch(/\.run-center-executor-row\s*\{[^}]*grid-template-columns:\s*34px minmax\(180px, 1\.2fr\) auto minmax\(160px, \.7fr\) 150px;/);
    expect(css).toMatch(/\.run-center-executor-row > \.run-center-agent-health\s*\{[^}]*grid-column:\s*3;/);
    expect(css).toMatch(/\.run-center-executor-row > \.run-center-registry-stats\s*\{[^}]*grid-column:\s*4;/);
    expect(css).toMatch(/\.run-center-executor-row > \.run-center-registry-actions\s*\{[^}]*grid-column:\s*5;/);
    expect(css).not.toContain('.run-center-executor-toggle');
  });

  it('keeps the queue/board split usable on desktop and narrow surfaces', () => {
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\s*{[\s\S]*?grid-template-columns:\s*minmax\(300px, 350px\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\.is-board-mode:not\(\.is-detail-open\)\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\.is-board-mode\.is-detail-open\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) clamp\(340px, 30%, 440px\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\.is-board-mode:not\(\.is-detail-open\) \.run-center-run-detail-pane\s*{[^}]*display:\s*none;/);
    expect(css).toMatch(/#panel-run-center \.run-center-run-list-pane\.is-board \.dashboard-board-scroll\s*{[^}]*height:\s*100%;[^}]*box-sizing:\s*border-box;/);
    expect(css).toMatch(/#panel-run-center \.run-center-run-list-pane\.is-board \.dashboard-board-columns\s*{[^}]*height:\s*100%;[^}]*min-height:\s*0;/);
    expect(css).toMatch(/#panel-run-center \.dashboard-board-columns\s*{[^}]*width:\s*100%;[^}]*align-items:\s*stretch;/);
    expect(css).toMatch(/#panel-run-center \.dashboard-board-column\s*{[^}]*height:\s*100%;[^}]*min-height:\s*100%;[^}]*flex-direction:\s*column;/);
    expect(css).toMatch(/#panel-run-center \.dashboard-board-column\.is-empty\s*{[^}]*display:\s*flex;[^}]*flex:\s*1 1 220px;/);
    expect(css).toMatch(/#panel-run-center \.dashboard-board-column\.is-empty \.dashboard-board-column-empty\s*{[^}]*height:\s*100%;[^}]*border:\s*1px dashed var\(--rc-line-strong\);/);
    expect(css).toMatch(/#panel-run-center \.dashboard-board-column-list\s*{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;/);
    expect(css).toMatch(/#panel-run-center \.run-center-run-detail-pane\s*{[\s\S]*?min-height:\s*0;/);
    expect(css).toMatch(/#panel-run-center \.run-center-run-detail-header\s*{[^}]*min-width:\s*0;[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) max-content;/);
    expect(css).toMatch(/#panel-run-center \.run-center-detail-actions\s*{[^}]*min-width:\s*max-content;[^}]*justify-self:\s*end;/);
    expect(css).toMatch(/#panel-run-center \.run-center-detail-actions \.run-center-icon-btn\s*{[^}]*flex:\s*0 0 auto;/);
    expect(css).toMatch(/#panel-run-center \.run-center-mode-switch\s*{[\s\S]*?display:\s*inline-flex;/);
    expect(css).toMatch(/#panel-run-center \.run-center-queue-item\s*{[\s\S]*?min-height:\s*84px;/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?#panel-run-center \.run-center-layout\.is-runs,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?#panel-run-center \.run-center-layout\.is-runs\.is-board-mode\.is-detail-open\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?#panel-run-center \.run-center-layout\.is-runs\.is-detail-open \.run-center-run-list-pane\s*{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?#panel-run-center \.run-center-shell:has\(\.run-center-layout\.is-runs\.is-detail-open\) > \.run-center-task-summary,[\s\S]*?> \.run-center-query-bar\s*{\s*display:\s*none;/);
    expect(css).toMatch(/@container run-center \(max-width:\s*420px\)[\s\S]*?\.run-center-mode-switch button span\s*{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?body:has\(:is\(#panel-run-center, #panel-workspace\)\.active\) \.sidebar\s*{[\s\S]*?width:\s*48px !important;/);
    expect(css).toContain('.sidebar-actions .sidebar-btn > span:not([data-ui-icon]):not(.sidebar-btn-icon)');
  });

  it('keeps coarse-pointer targets and reduced-motion behavior safe at narrow widths', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.run-center-quick-item-action\.ui-icon-button \{ width: 44px; height: 44px; \}/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*?#panel-run-center \.run-center-attempt,[\s\S]*?min-height: 44px;/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*?#panel-run-center \.run-center-detail-back \{ width: 44px; height: 44px; \}/);
    expect(css).toMatch(/@container run-center \(max-width: 420px\)[\s\S]*?#panel-run-center \.run-center-detail-actions \.run-center-icon-btn \{ width: 44px; height: 44px; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?scroll-behavior: auto !important;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.ui-icon\.is-spinning,[\s\S]*?animation: none;/);
  });

  it('defines the unified control-plane copy in Simplified Chinese and English', () => {
    for (const language of ['zh', 'en']) {
      const locale = JSON.parse(read(`src/renderer/locales/${language}.json`));
      for (const key of [
        'run_center.view_overview', 'run_center.view_board', 'run_center.view_agents',
        'run_center.mode_queue', 'run_center.mode_board', 'run_center.detail_summary',
        'run_center.detail_history', 'run_center.detail_collaboration',
        'run_center.collaboration_runs', 'run_center.selected_run', 'run_center.run_sequence',
        'run_center.history_runs', 'run_center.attempt_badge_latest',
        'run_center.save_planned', 'run_center.start_planned', 'run_center.status_planned',
        'run_center.native_agents_section', 'run_center.native_agent_group',
        'run_center.external_agents_section', 'run_center.channels_section',
        'run_center.single_agent_title', 'run_center.execution_path',
      ]) expect(locale[key], `${language}:${key}`).toBeTruthy();
    }
  });
});

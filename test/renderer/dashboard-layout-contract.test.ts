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
const board = read('src/renderer/modules/run-center-board.js');
const agents = read('src/renderer/modules/run-center-agents.js');
const css = read('src/renderer/style.css');

describe('unified Agent Operations Center layout contract', () => {
  it('removes the duplicate Agent Dashboard entry and panel', () => {
    expect(html).toContain('id="run-center-btn"');
    expect(html).toContain('id="panel-run-center"');
    expect(html).not.toContain('id="dashboard-btn"');
    expect(html).not.toContain('id="panel-dashboard"');
    expect(lazy).not.toContain('dashboard: [');
  });

  it('redirects the legacy dashboard route to the unified Agent view', () => {
    expect(boot).toContain("const openLegacyAgentDashboard = view === 'dashboard'");
    expect(boot).toContain("if (openLegacyAgentDashboard) view = 'run-center'");
    expect(boot).toContain("openLegacyAgentDashboard ? 'agents' : opts.runCenterView");
    expect(boot).not.toContain("view === 'dashboard' ? 'panel-dashboard'");
  });

  it('normalizes legacy Run Center deep links before panel routing', () => {
    expect(boot).toContain("const legacyRunCenterView = view === 'board' || view === 'runs' || view === 'collaboration'");
    expect(boot).toContain("const effectiveRunCenterView = legacyRunCenterView || requestedRunCenterView");
    expect(boot).toContain("if (legacyRunCenterView) view = 'run-center'");
  });

  it('exposes exactly five top-level views in the restored daily-user order', () => {
    const definition = runCenter.match(/const VIEW_DEFINITIONS = Object\.freeze\(\[[\s\S]*?\]\);/)?.[0] || '';
    expect(definition.match(/\['/g) || []).toHaveLength(5);
    const views = [
      "['overview', 'run_center.view_overview']",
      "['runs', 'run_center.view_board']",
      "['history', 'run_center.view_runs']",
      "['agents', 'run_center.view_agents']",
      "['collaboration', 'run_center.view_collaboration']",
    ];
    for (const view of views) expect(definition).toContain(view);
    expect(views.map((view) => definition.indexOf(view))).toEqual(
      [...views.map((view) => definition.indexOf(view))].sort((left, right) => left - right),
    );
    expect(definition).not.toContain("['board'");
    expect(runCenter).toContain("const views = VIEW_DEFINITIONS.map(([view]) => view)");
    expect(lazy).toContain("'./modules/run-center-agents.js'");
    expect(runCenter).toContain("invoke('cogseed.agent.list')");
    expect(runCenter).toContain('rootWindow.openRunCenterView');
  });

  it('keeps queue and board modes alongside dedicated history and collaboration views', () => {
    expect(runCenter).toContain("runMode: 'queue'");
    expect(runCenter).toContain("detailTab: 'summary'");
    expect(runCenter).toContain("['queue', 'list', 'run_center.mode_queue']");
    expect(runCenter).toContain("['board', 'layout-grid', 'run_center.mode_board']");
    expect(runCenter).toContain('data-run-center-mode="${mode}"');
    expect(runCenter).toContain("const runHistory = state.view === 'history'");
    expect(runCenter).toContain("is-${esc(state.runMode)}-mode");
    expect(runCenter).toContain('is-history');
    expect(runCenter).toContain('<aside class="run-center-run-list-pane');
    expect(runCenter).toContain('<main class="run-center-run-detail-pane">${detailsHtml()}</main>');
    expect(runCenter).toContain("['summary', 'run_center.detail_summary']");
    expect(runCenter).toContain("['history', 'run_center.detail_history']");
    expect(runCenter).toContain('data-run-center-detail-tab="${tab}"');
    expect(runCenter).toContain("activeTab === 'history' ? historyTabHtml(model)");
    expect(runCenter).toContain("activeTab === 'collaboration' ? collaborationHtml()");
    expect(runCenter).not.toContain('detailsDrawerHtml');
    expect(runCenter).toContain('class="run-center-layout is-collaboration"');
    expect(runCenter).toContain("state.view === 'collaboration'");
    expect(runCenter).toContain('function collaborationWorkspaceHtml()');
    expect(runCenter).toContain('run-center-collaboration-run-list');
  });

  it('opens collaboration only when the selected run has collaboration evidence', () => {
    expect(runCenter).toContain('function collaborationAvailable(collaboration, task)');
    expect(runCenter).toContain('const hasCollaboration = collaborationAvailable(collaboration, task);');
    expect(runCenter).toContain("hasCollaboration ? ['collaboration', 'run_center.detail_collaboration'] : null");
    expect(runCenter).toContain("state.detailTab === 'collaboration' && !hasCollaboration ? 'summary' : state.detailTab");
    expect(runCenter).toContain('data-run-center-detail-tab="collaboration"');
    expect(runCenter).toContain("else if (nextView === 'collaboration') {");
    expect(runCenter).toContain("state.view = 'collaboration';");
    expect(runCenter).toContain("state.detailTab = 'collaboration';");
    expect(runCenter).toContain('collaborationWorkspaceHtml()');
  });

  it('keeps logical run, attempt, and sequence identity stable across refreshes', () => {
    expect(board).toContain('function logicalRunKey(task)');
    expect(board).toContain('function buildRunModels(projection)');
    expect(board).toContain('function buildRunSequence(runs)');
    expect(board).toContain('data-dashboard-board-run-key="${esc(run.key)}"');
    expect(board).toContain('data-run-center-queue-run-key="${esc(run.key)}"');
    expect(runCenter).toContain('selectedRunKey:');
    expect(runCenter).toContain('selectedAttemptKey:');
    expect(runCenter).toContain('function runSequenceByKey()');
    expect(runCenter).toContain('function buildAttemptModels(run)');
    expect(runCenter).toContain('function reconcileAttemptSelection(run, preferredKey, preferredTaskId)');
    expect(runCenter).toContain('data-run-center-attempt-index="${index}"');
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
  });

  it('keeps the queue/board split usable on desktop and narrow surfaces', () => {
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\s*{[\s\S]*?grid-template-columns:\s*minmax\(300px, 350px\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\.is-board-mode\s*{[\s\S]*?grid-template-columns:\s*minmax\(0, 1\.5fr\) minmax\(340px, \.66fr\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-run-detail-pane\s*{[\s\S]*?min-height:\s*0;/);
    expect(css).toMatch(/#panel-run-center \.run-center-mode-switch\s*{[\s\S]*?display:\s*inline-flex;/);
    expect(css).toMatch(/#panel-run-center \.run-center-queue-item\s*{[\s\S]*?min-height:\s*84px;/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?#panel-run-center \.run-center-layout\.is-runs,[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?#panel-run-center \.run-center-layout\.is-runs\.is-detail-open \.run-center-run-list-pane\s*{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/@container run-center \(max-width:\s*420px\)[\s\S]*?\.run-center-mode-switch button span\s*{[\s\S]*?display:\s*none;/);
    expect(css).toMatch(/@media \(max-width:\s*720px\)[\s\S]*?body:has\(#panel-run-center\.active\) \.sidebar\s*{[\s\S]*?width:\s*48px !important;/);
    expect(css).toContain('.sidebar-actions .sidebar-btn > span:not([data-ui-icon]):not(.sidebar-btn-icon)');
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
        'run_center.native_agents_section', 'run_center.native_agent_group',
        'run_center.external_agents_section', 'run_center.channels_section',
        'run_center.single_agent_title', 'run_center.execution_path',
      ]) expect(locale[key], `${language}:${key}`).toBeTruthy();
    }
  });
});

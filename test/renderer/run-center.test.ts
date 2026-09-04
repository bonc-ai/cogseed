// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Run Center renderer contract', () => {
  it('uses one lazy-loaded Run Center with five daily-user views', () => {
    const html = read('src/renderer/index.html');
    const boot = read('src/renderer/modules/boot.js');
    const state = read('src/renderer/modules/state.js');
    const manifest = read('src/renderer/modules/lazy-features.js');

    expect(html).toContain('id="run-center-btn"');
    expect(html).toContain('id="panel-run-center"');
    expect(html).toMatch(/id="panel-run-center"[\s\S]*?class="app-top-drag-strip"/);
    expect(html).not.toContain('id="dashboard-btn"');
    expect(html).not.toContain('id="panel-dashboard"');
    expect(boot).toContain("view === 'run-center' ? 'panel-run-center'");
    expect(boot).toContain("_loadViewFeature('run-center', 'run-center'");
    expect(state).toContain("_setViewFromSidebar('run-center')");
    expect(manifest).toContain("'run-center': [");
    expect(manifest).toContain("'./modules/run-center-board.js'");
    expect(manifest).toContain("'./modules/run-center-overview.js'");
    expect(manifest).toContain("'./modules/run-center-agents.js'");
    expect(manifest).toContain("'./modules/run-center.js'");
    expect(manifest).not.toContain('dashboard: [');
    expect(boot).toContain("const openLegacyAgentDashboard = view === 'dashboard'");
    expect(boot).toContain("if (openLegacyAgentDashboard) view = 'run-center'");
    expect(boot).toContain("openLegacyAgentDashboard ? 'agents' : opts.runCenterView");
    expect(html).not.toContain('<script src="./modules/run-center.js"></script>');
    expect(read('src/renderer/modules/run-center.js')).toContain('overviewAnalysisOpen: true');
  });

  it('keeps the macOS window top draggable without swallowing Run Center actions', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/\.is-macos \.run-center-header\s*{[\s\S]*?-webkit-app-region:\s*drag;/);
    expect(css).toMatch(/\.is-macos \.run-center-header-actions button\s*{[\s\S]*?-webkit-app-region:\s*no-drag;/);
  });

  it('uses a persistent queue-detail workspace with a full-width mobile detail state', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/#run-center-root\s*{[\s\S]*?container:\s*run-center \/ inline-size;/);
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\s*\{[\s\S]*?grid-template-columns:\s*minmax\(300px, 350px\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\.is-board-mode:not\(\.is-detail-open\)\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(css).toMatch(/#panel-run-center \.run-center-layout\.is-runs\.is-board-mode\.is-detail-open\s*\{[^}]*clamp\(340px, 30%, 440px\);/);
    expect(css).toMatch(/#panel-run-center \.dashboard-board-column\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*100%;/);
    expect(css).toMatch(/#panel-run-center \.run-center-queue-scroll\s*\{[\s\S]*?overflow:\s*auto;/);
    expect(css).toMatch(/#panel-run-center \.run-center-queue-item\.is-selected\s*\{[\s\S]*?background:\s*var\(--rc-surface-muted\);/);
    expect(css).toMatch(/#panel-run-center \.dashboard-board-card\.is-selected\s*\{[\s\S]*?background:\s*var\(--rc-surface-muted\);/);
    expect(css).toMatch(/\.run-center-tab:focus-visible\s*{[\s\S]*?outline:/);
    expect(css).toMatch(/\.run-center-overview-statuses button\.is-attention > small i\s*{[^}]*background:\s*var\(--danger\);/);
    expect(css).toMatch(/\.run-center-overview-statuses button\.is-completed > small i\s*{[^}]*background:\s*var\(--success\);/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?\.run-center-layout\.is-runs\.is-detail-open \.run-center-run-list-pane\s*\{\s*display:\s*none;/);
    expect(css).toMatch(/@container run-center \(max-width:\s*720px\)[\s\S]*?\.run-center-detail-back\s*\{\s*display:\s*inline-grid;/);
    expect(css).toMatch(/\.dashboard-board-columns\.has-items \.dashboard-board-column\.is-empty\s*{[^}]*display:\s*none;/);
    expect(css).toMatch(/\.run-center-status\.is-needs_review\s*{[^}]*var\(--warning/);
  });

  it('uses the constrained CogSeed projection and action IPC surface', () => {
    const source = read('src/renderer/modules/run-center.js');
    const conversationInfo = read('src/renderer/modules/conversation-info.js');

    expect(source).toContain("invoke('cogseed.task.list')");
    expect(source).not.toContain("invoke('cogseed.session.list')");
    expect(source).toContain("invoke('cogseed.session.read'");
    expect(source).toContain("invoke('cogseed.agent.list')");
    expect(source).toContain("invoke('cogseed.task.action'");
    expect(source).toContain('CogSeedRunCenterBoard?.recommendedActionAvailable?.(');
    expect(source).toContain('data-run-center-action="archive"');
    expect(source).toContain("text('run_center.archive_confirm')");
    expect(source).toContain("invoke(isReassign ? 'cogseed.task.reassign' : 'cogseed.task.start'");
    expect(source).toContain("rootWindow.cogseed.stream('cogseed.dashboard.watch'");
    expect(source).toContain("invoke('agents.list', { summary: true })");
    expect(source).toContain("invoke('cogseed.collaboration.action'");
    expect(source).toContain("invoke('cogseed.dashboard.diagnostics'");
    expect(source).toContain("invoke('cogseed.worktree.list'");
    expect(source).toContain("invoke('cogseed.worktree.create'");
    expect(source).toContain("invoke('cogseed.worktree.remove'");
    expect(source).toContain('cogseed-run-center-diagnostics-');
    expect(source).toContain('data-run-center-worktrees-open');
    expect(source).toContain('data-run-center-tools-toggle');
    expect(source).toContain('aria-controls="run-center-tools-menu"');
    expect(source).toContain('aria-expanded="${String(state.toolsOpen)}"');
    expect(source).toContain("document.addEventListener('keydown'");
    expect(source).toContain('data-run-center-worktree-remove');
    expect(source).toContain("text('run_center.worktree_remove_confirm', { branch })");
    expect(source).not.toContain("invoke('cogseed.worktree.remove', { path: worktreePath, force:");
    expect(source).toContain('data-run-center-source-filter');
    expect(source).toContain('req-run-center-');
    expect(source).not.toContain('cogseed_agent.task.');
    expect(conversationInfo).toContain("invoke('cogseed.task.action'");
    expect(conversationInfo).not.toContain('cogseed_agent.task.');
    expect(conversationInfo).toContain('req-conversation-info-');
    expect(conversationInfo).not.toContain('data-cogseed-request-id');
    expect(source).toContain("stateView('run_center.load_failed', state.error)");
    expect(source).toContain("dynamicLabel('run_center.event_'");
  });

  it('keeps board filters deterministic and excludes archived cards by default', () => {
    const context: any = { window: {}, Object, String, Array, Map, Set, Date, Math, Number };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);

    const board = context.window.CogSeedRunCenterBoard;
    const projection = {
      tasks: [
        { taskId: 'pending', executionId: 'execution-pending', sessionId: 'session-a', conversationId: 'conversation-a', column: 'pending', sourceKind: 'cogseed', title: 'Pending', updatedAt: '2026-08-26T10:00:00.000Z' },
        { taskId: 'running', executionId: 'execution-running', sessionId: 'session-a', conversationId: 'conversation-a', sessionTitle: 'Agent conversation', column: 'running', sourceKind: 'agent', agentId: 'agent-1', worktreeName: 'cogseed-worktree-dev-review', title: 'Running', updatedAt: '2026-08-26T11:00:00.000Z' },
        { taskId: 'archived', executionId: 'execution-archived', sessionId: 'session-b', status: 'failed', errorCode: 'provider_error', column: 'archived', sourceKind: 'agent', title: 'Archived', updatedAt: '2026-08-26T09:00:00.000Z' },
      ],
    };
    expect(board.filteredTasks(projection, '', 'all').map((task: any) => task.taskId)).toEqual(['pending', 'running']);
    expect(board.filteredTasks(projection, '', 'pending').map((task: any) => task.taskId)).toEqual(['pending']);
    expect(board.filteredTasks(projection, '', 'running').map((task: any) => task.taskId)).toEqual(['running']);
    expect(board.filteredTasks(projection, 'archived', 'all', true).map((task: any) => task.taskId)).toEqual(['archived']);
    expect(board.filterRuns(board.buildRunModels(projection), { search: '', filter: 'all' }).map((run: any) => run.aggregateTask.taskId)).toEqual(['pending', 'running']);
    expect(board.userStateForTask(projection.tasks[2]).action).toBe('');
    expect(board.filteredTasks(projection, '', 'all', false, 'agent').map((task: any) => task.taskId)).toEqual(['running']);
    expect(board.filteredTasks(projection, 'Researcher', 'all', false, 'all', (agentId: string) => agentId ? 'Researcher' : '').map((task: any) => task.taskId)).toEqual(['running']);
    expect(board.filteredTasks(projection, 'dev-review', 'all').map((task: any) => task.taskId)).toEqual(['running']);
    expect(board.taskForSession(projection, 'session-a', '', 'all', 'agent').taskId).toBe('running');
    const filteredRuns = board.filterRuns(board.buildRunModels(projection), {
      search: '', filter: 'all', sourceFilter: 'all', agentFilter: 'agent-1', timeFilter: 'today',
      now: '2026-08-27T11:00:00.000Z', agentName: (agentId: string) => agentId,
    });
    expect(filteredRuns.map((run: any) => run.aggregateTask.taskId)).toEqual(['running']);
    expect(board.shouldShowSessionTitle('Local CLI task', 'Local CLI task')).toBe(false);
    expect(board.shouldShowSessionTitle('Review the change', 'Release review')).toBe(true);
    expect(board.shouldShowSessionTitle('Review the change', '')).toBe(false);
    expect(board.uniqueCardMeta('Commander turn', [
      { value: 'Agent conversation' }, { value: 'Agent conversation' }, { value: 'Codex' },
    ]).map((item: any) => item.value)).toEqual(['Agent conversation', 'Codex']);
    expect(board.uniqueCardMeta('Agent conversation', [
      { value: 'Agent conversation' }, { value: '' },
    ])).toHaveLength(0);

    const labels: Record<string, string> = {
      'run_center.conversation_mode_agent': 'Agent conversation',
      'run_center.source_agent': 'Agent conversation',
    };
    const html = board.render(projection, {
      text: (key: string) => labels[key] || key,
      esc: (value: unknown) => String(value ?? ''),
      icon: (name: string) => `<i>${name}</i>`,
      statusKey: (status: string) => `run_center.status_${status}`,
      statusClass: () => 'run-center-status',
      formatDate: (value: string) => value,
      stateView: (key: string) => key,
      search: '', filter: 'all', sourceFilter: 'all', selectedTaskId: '', showArchived: false,
      agentName: (agentId: string) => agentId === 'agent-1' ? 'Researcher' : agentId,
    });
    expect(html.match(/dashboard-board-column is-empty/g)).toHaveLength(2);
    expect(html).toMatch(/dashboard-board-column is-empty" data-dashboard-board-column="attention"/);
    expect(html).toMatch(/dashboard-board-column is-empty" data-dashboard-board-column="completed"/);
    expect(html.match(/Researcher/g)).toHaveLength(1);
    expect(html).not.toContain('Agent conversation');

    const filteredBoardHtml = board.render(projection, {
      ...{
        text: (key: string) => labels[key] || key,
        esc: (value: unknown) => String(value ?? ''), icon: (name: string) => `<i>${name}</i>`,
        statusKey: (status: string) => `run_center.status_${status}`, statusClass: () => 'run-center-status',
        formatDate: (value: string) => value, stateView: (key: string) => key,
      },
      search: '', filter: 'all', sourceFilter: 'all', agentFilter: 'agent-1', timeFilter: 'today',
      now: '2026-08-27T11:00:00.000Z', selectedTaskId: '', showArchived: false,
      agentName: (agentId: string) => agentId === 'agent-1' ? 'Researcher' : agentId,
    });
    expect(filteredBoardHtml.match(/data-dashboard-board-task-id=/g)).toHaveLength(1);
    expect(filteredBoardHtml).toContain('data-dashboard-board-task-id="running"');
  });

  it('renders one representative card per logical run without merging independent executions', () => {
    const context: any = { window: {}, Object, String, Array, Map, Set };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);

    const board = context.window.CogSeedRunCenterBoard;
    const projection = {
      groups: [
        { groupId: 'group-review', parentTaskId: 'group-parent', progress: { completed: 1, total: 2, failed: 0, attention: 1 } },
        { coordinationId: 'coord-archive', parentTaskId: 'archive-parent' },
      ],
      tasks: [
        { taskId: 'group-child', groupId: 'group-review', executionId: 'execution-child', sessionId: 'session-review', column: 'attention', status: 'failed', title: 'Newer child', updatedAt: '2026-08-27T12:00:00.000Z' },
        { taskId: 'group-parent', groupId: 'group-review', executionId: 'execution-parent', sessionId: 'session-review', column: 'running', status: 'running', title: 'Review run', updatedAt: '2026-08-27T10:00:00.000Z' },
        { taskId: 'execution-one-old', executionId: 'execution-one', sessionId: 'shared-session', conversationId: 'shared-conversation', column: 'pending', status: 'pending', title: 'Older attempt', updatedAt: '2026-08-27T08:00:00.000Z' },
        { taskId: 'execution-one-new', executionId: 'execution-one', sessionId: 'shared-session', conversationId: 'shared-conversation', column: 'running', status: 'running', title: 'Current attempt', updatedAt: '2026-08-27T09:00:00.000Z' },
        { taskId: 'execution-two', executionId: 'execution-two', sessionId: 'shared-session', conversationId: 'shared-conversation', column: 'running', status: 'running', title: 'Independent execution', updatedAt: '2026-08-27T09:30:00.000Z' },
        { taskId: 'group-review', column: 'completed', status: 'completed', title: 'Standalone with colliding ID', updatedAt: '2026-08-27T07:00:00.000Z' },
        { taskId: 'standalone-b', column: 'completed', status: 'completed', title: 'Standalone B', updatedAt: '2026-08-27T06:00:00.000Z' },
        { taskId: 'archive-child', coordinationId: 'coord-archive', column: 'completed', status: 'completed', title: 'Completed child', updatedAt: '2026-08-27T05:00:00.000Z' },
        { taskId: 'archive-parent', coordinationId: 'coord-archive', column: 'archived', status: 'cancelled', title: 'Archived run', updatedAt: '2026-08-27T04:00:00.000Z' },
      ],
    };

    expect(board.logicalRunKey({ groupId: 'g', coordinationId: 'c', executionId: 'e', sessionId: 's', conversationId: 'v', taskId: 't' })).toBe('group:g');
    expect(board.logicalRunKey({ coordinationId: 'c', executionId: 'e', sessionId: 's', conversationId: 'v', taskId: 't' })).toBe('coordination:c');
    expect(board.logicalRunKey({ executionId: 'e', sessionId: 's', conversationId: 'v', taskId: 't' })).toBe('execution:e');
    expect(board.logicalRunKey({ sessionId: 's', conversationId: 'v', taskId: 't' })).toBe('session:s');
    expect(board.logicalRunKey({ conversationId: 'v', taskId: 't' })).toBe('conversation:v');
    expect(board.logicalRunKey({ taskId: 't' })).toBe('task:t');

    const logical = board.logicalTasks(projection);
    expect(logical.map((task: any) => task.taskId)).toEqual([
      'group-parent', 'execution-one-new', 'execution-two', 'group-review', 'standalone-b', 'archive-parent',
    ]);
    expect(logical.find((task: any) => task.taskId === 'group-parent')).toMatchObject({
      taskId: 'group-parent', column: 'attention', status: 'failed', updatedAt: '2026-08-27T12:00:00.000Z',
    });
    expect(logical.find((task: any) => task.taskId === 'archive-parent')).toMatchObject({
      taskId: 'archive-parent', column: 'archived', status: 'cancelled', updatedAt: '2026-08-27T05:00:00.000Z',
    });
    expect(board.filteredLogicalTasks(projection, '', 'attention').map((task: any) => task.taskId)).toEqual(['group-parent']);
    expect(board.filteredLogicalTasks(projection, '', 'running').map((task: any) => task.taskId)).toEqual(['execution-one-new', 'execution-two']);

    const renderOptions = {
      text: (key: string) => key,
      esc: (value: unknown) => String(value ?? ''),
      icon: (name: string) => `<i>${name}</i>`,
      statusKey: (status: string) => `run_center.status_${status}`,
      statusClass: () => 'run-center-status',
      formatDate: (value: string) => value,
      stateView: (key: string) => key,
      search: '', filter: 'all', sourceFilter: 'all', selectedTaskId: 'group-child', showArchived: true,
      agentName: (agentId: string) => agentId,
    };
    const html = board.render(projection, renderOptions);
    expect(html.match(/data-dashboard-board-task-id=/g)).toHaveLength(6);
    expect(html).toMatch(/class="dashboard-board-card is-selected"[^>]*data-dashboard-board-task-id="group-parent"/);
    expect(html).not.toContain('data-dashboard-board-task-id="group-child"');
    expect(html).not.toContain('data-dashboard-board-task-id="execution-one-old"');
    expect(html).not.toContain('data-dashboard-board-task-id="archive-child"');
    expect(html.match(/data-dashboard-board-run-key="[^"]+"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html).toMatch(/data-dashboard-board-run-key="group:group-review"[^>]*tabindex="0"/);
    expect(html).toContain('run_center.archive</span><b>1</b>');
    expect(html).toContain('<time datetime="2026-08-27T12:00:00.000Z">2026-08-27T12:00:00.000Z</time>');
    const defaultAttentionColumn = html.match(/data-dashboard-board-column="attention">([\s\S]*?)<\/section>/)?.[1] || '';
    expect(defaultAttentionColumn).toContain('data-dashboard-board-task-id="group-parent"');
    expect(defaultAttentionColumn).toContain('run_center.status_failed');

    const focusedHtml = board.render(projection, { ...renderOptions, focusedRunKey: 'execution:execution-two' });
    expect(focusedHtml.match(/data-dashboard-board-run-key="[^"]+"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(focusedHtml).toMatch(/data-dashboard-board-run-key="execution:execution-two"[^>]*tabindex="0"/);

    const attentionHtml = board.render(projection, {
      text: (key: string) => key,
      esc: (value: unknown) => String(value ?? ''),
      icon: (name: string) => `<i>${name}</i>`,
      statusKey: (status: string) => `run_center.status_${status}`,
      statusClass: () => 'run-center-status',
      formatDate: (value: string) => value,
      stateView: (key: string) => key,
      search: '', filter: 'attention', sourceFilter: 'all', selectedTaskId: 'group-child', showArchived: false,
      agentName: (agentId: string) => agentId,
    });
    const attentionColumn = attentionHtml.match(/data-dashboard-board-column="attention">([\s\S]*?)<\/section>/)?.[1] || '';
    expect(attentionColumn).toContain('data-dashboard-board-task-id="group-parent"');
    expect(attentionColumn).toContain('run_center.status_failed');
    expect(attentionHtml).not.toContain('data-dashboard-board-task-id="group-child"');
  });

  it('builds privacy-safe run names, stable sequence labels, and one recommended recovery action', () => {
    const context: any = { window: {}, Object, String, Array, Map, Set, Date, Math, Number };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);

    const board = context.window.CogSeedRunCenterBoard;
    const shared = {
      sessionId: 'session-shared', conversationId: 'conversation-safe', sourceKind: 'agent',
      agentId: 'reviewer', title: 'raw prompt must not render', worktreeName: '/private/worktree',
    };
    const tasks = [
      { ...shared, taskId: 'task-one', executionId: 'execution-00000001', status: 'failed', column: 'attention', createdAt: '2026-08-27T08:00:00.000Z', updatedAt: '2026-08-27T08:10:00.000Z' },
      { ...shared, taskId: 'task-two', executionId: 'execution-00000002', status: 'recoverable', column: 'attention', createdAt: '2026-08-27T09:00:00.000Z', updatedAt: '2026-08-27T09:10:00.000Z' },
      { ...shared, taskId: 'task-three', executionId: 'execution-00000003', status: 'waiting_user', column: 'attention', createdAt: '2026-08-27T10:00:00.000Z', updatedAt: '2026-08-27T10:10:00.000Z' },
      { ...shared, taskId: 'task-four', executionId: 'execution-00000004', status: 'completed', column: 'attention', resultDeliveryState: 'pending-recovery', createdAt: '2026-08-27T11:00:00.000Z', updatedAt: '2026-08-27T11:10:00.000Z' },
    ];
    const runs = board.buildRunModels({ tasks });
    const options = {
      text: (key: string) => ({
        'run_center.task_kind_agent': 'Agent task',
        'run_center.task_kind_cogseed': 'CogSeed task',
      }[key] || key),
      agentName: () => 'Reviewer',
      formatDate: (value: string) => value.slice(11, 16),
      conversationTitle: (conversationId: string) => conversationId === 'conversation-safe' ? 'Release review' : '',
    };
    const displayed = board.buildDisplayRuns(runs, options);

    expect(runs).toHaveLength(4);
    expect(displayed.map((item: any) => item.sequence)).toEqual([
      { index: 1, count: 4 }, { index: 2, count: 4 }, { index: 3, count: 4 }, { index: 4, count: 4 },
    ]);
    expect(displayed.every((item: any) => item.title === 'Release review')).toBe(true);
    expect(displayed.map((item: any) => item.userState.action)).toEqual(['retry', 'resume', 'open-task', 'recover-result']);

    const fallback = board.displayRun(runs[0], { ...options, conversationTitle: () => '' }, displayed[0].sequence);
    expect(fallback.title).toBe('Agent task · Reviewer · 08:10 · #00000001');
    expect(fallback.title).not.toContain(tasks[0].title);
    expect(fallback.title).not.toContain(tasks[0].worktreeName);

    expect(board.userStateForTask({ status: 'needs_review' }).action).toBe('open-handling');
    expect(board.userStateForTask({ status: 'failed', errorCode: 'provider_error' }).action).toBe('configure-model');
    expect(board.userStateForTask({ status: 'failed', errorCode: 'model_preflight' }).action).toBe('configure-model');
    expect(board.userStateForTask({ status: 'failed', errorCode: 'task_failed' }).action).toBe('retry');
    expect(board.userStateForTask({ status: 'running', column: 'running' }).attention).toBe(false);
  });

  it('builds an overview with health, trend, source, and Agent load signals', () => {
    const context: any = { window: {}, Object, String, Array, Map, Set, Date, Math };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
    vm.runInContext(read('src/renderer/modules/run-center-overview.js'), context);

    const overview = context.window.CogSeedRunCenterOverview;
    const projection = {
      updatedAt: '2026-08-27T08:00:00.000Z',
      tasks: [
        { taskId: 'running', executionId: 'running-execution', sessionId: 'session-a', column: 'running', status: 'running', sourceKind: 'agent', agentId: 'agent-a', createdAt: '2026-08-27T01:00:00.000Z', updatedAt: '2026-08-27T02:00:00.000Z' },
        { taskId: 'failed', executionId: 'failed-execution', sessionId: 'session-b', column: 'attention', status: 'failed', sourceKind: 'local-cli', agentId: 'agent-a', createdAt: '2026-08-26T01:00:00.000Z', updatedAt: '2026-08-27T03:00:00.000Z' },
        { taskId: 'completed', executionId: 'completed-execution', sessionId: 'session-c', column: 'completed', status: 'completed', sourceKind: 'cogseed', createdAt: '2026-08-21T01:00:00.000Z', updatedAt: '2026-08-26T03:00:00.000Z' },
        { taskId: 'cancelled', executionId: 'cancelled-execution', sessionId: 'session-c', column: 'archived', status: 'cancelled', sourceKind: 'cogseed', createdAt: '2026-08-20T01:00:00.000Z', updatedAt: '2026-08-20T03:00:00.000Z' },
      ],
    };
    const model = overview.buildOverview(projection, [
      { agent_id: 'agent-a', name: 'Reviewer', enabled: true },
      { agent_id: 'manager', name: 'Manager', enabled: true, interaction_mode: 'management_only' },
    ], new Date(2026, 7, 27, 12));

    expect(model.counts).toMatchObject({ total: 4, sessions: 3, active: 1, attention: 1, completed: 1, successRate: 33 });
    expect(model.trend.map((item: any) => item.started)).toEqual([1, 0, 0, 0, 0, 1, 1]);
    expect(model.trend.map((item: any) => item.completed)).toEqual([0, 0, 0, 0, 0, 1, 0]);
    expect(model.trend.map((item: any) => item.attention)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(model.sources).toEqual([
      { source: 'cogseed', count: 2 }, { source: 'agent', count: 1 }, { source: 'local-cli', count: 1 },
    ]);
    expect(model.installedAgentCount).toBe(1);
    expect(model.agentLoad[0]).toMatchObject({ agentId: 'agent-a', name: 'Reviewer', total: 2, active: 1, attention: 1 });
    expect(model.attentionTasks.map((task: any) => task.taskId)).toEqual(['failed']);
    expect(model.recentTasks[0].taskId).toBe('failed');
    expect(model.statusCounts).toEqual([
      { column: 'running', count: 1 },
      { column: 'attention', count: 1 },
      { column: 'completed', count: 1 },
      { column: 'archived', count: 1 },
    ]);

    const logicalModel = overview.buildOverview({
      groups: [{ groupId: 'group-review', parentTaskId: 'parent-failed' }],
      tasks: [
        { taskId: 'child-failed', groupId: 'group-review', sessionId: 'session-review', column: 'attention', status: 'failed', updatedAt: '2026-08-27T06:00:00.000Z' },
        { taskId: 'parent-failed', groupId: 'group-review', sessionId: 'session-review', column: 'running', status: 'running', updatedAt: '2026-08-27T05:00:00.000Z' },
        { taskId: 'other-failed', sessionId: 'session-other', column: 'attention', status: 'failed', updatedAt: '2026-08-27T04:00:00.000Z' },
        { taskId: 'execution-one', executionId: 'execution-one', sessionId: 'shared-session', conversationId: 'shared-conversation', column: 'running', status: 'running', updatedAt: '2026-08-27T08:00:00.000Z' },
        { taskId: 'execution-two', executionId: 'execution-two', sessionId: 'shared-session', conversationId: 'shared-conversation', column: 'running', status: 'running', updatedAt: '2026-08-27T07:00:00.000Z' },
      ],
    }, [], new Date(2026, 7, 27, 12));
    expect(logicalModel.attentionTasks.map((task: any) => task.taskId)).toEqual(['parent-failed', 'other-failed']);
    expect(logicalModel.recentTasks.map((task: any) => task.taskId)).toEqual(['execution-one', 'execution-two', 'parent-failed', 'other-failed']);
    expect(logicalModel.attentionTasks[0]).toMatchObject({ taskId: 'parent-failed', column: 'attention', status: 'failed', updatedAt: '2026-08-27T06:00:00.000Z' });
    expect(logicalModel.recentTasks[2]).toMatchObject({ taskId: 'parent-failed', column: 'attention', status: 'failed', updatedAt: '2026-08-27T06:00:00.000Z' });
    expect(logicalModel.statusCounts).toEqual([{ column: 'running', count: 2 }, { column: 'attention', count: 2 }]);

    const archivedLogicalModel = overview.buildOverview({
      groups: [{ coordinationId: 'coord-archive', parentTaskId: 'archive-parent' }],
      tasks: [
        { taskId: 'archive-child', coordinationId: 'coord-archive', column: 'completed', status: 'completed', updatedAt: '2026-08-27T10:00:00.000Z' },
        { taskId: 'archive-parent', coordinationId: 'coord-archive', column: 'archived', status: 'cancelled', updatedAt: '2026-08-27T09:00:00.000Z' },
      ],
    }, [], new Date(2026, 7, 27, 12));
    expect(archivedLogicalModel.recentTasks[0]).toMatchObject({
      taskId: 'archive-parent', column: 'archived', status: 'cancelled', updatedAt: '2026-08-27T10:00:00.000Z',
    });

    const html = overview.render(projection, [], {
      text: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key,
      esc: (value: unknown) => String(value ?? ''), icon: (name: string) => `<i>${name}</i>`,
      statusKey: (status: string) => `run_center.status_${status}`, statusClass: () => 'run-center-status',
      formatDate: (value: string) => value, formatDay: (value: Date) => String(value.getDate()),
      stateView: (key: string) => key, localizedTitle: (task: any) => task.taskId,
      agentName: (agentId: string) => agentId, loading: false, error: '', analysisOpen: true,
      now: new Date(2026, 7, 27, 12),
    });
    expect(html).toContain('run_center.overview_health_attention');
    expect(html).toContain('data-run-center-overview-filter="attention"');
    expect(html).toContain('class="is-attention" data-run-center-overview-filter="attention"');
    expect(html).toContain('class="is-completed" data-run-center-overview-filter="completed"');
    expect(html).toContain('class="is-archived" data-run-center-overview-filter="archived"');
    expect(html).toContain('data-run-center-overview-task="failed"');
    expect(html).toContain('data-run-center-overview-agent="agent-a"');
    expect(html).toContain('data-run-center-overview-source="local-cli"');
    expect(html.indexOf('class="run-center-overview-analysis"')).toBeLessThan(
      html.indexOf('class="run-center-overview-now"'),
    );
    expect(html).toContain('class="run-center-overview-analysis" open');
  });

  it('derives every overview statistic from logical Runs without double-counting attempts', () => {
    const context: any = { window: {}, Object, String, Array, Map, Set, Date, Math };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
    vm.runInContext(read('src/renderer/modules/run-center-overview.js'), context);

    const model = context.window.CogSeedRunCenterOverview.buildOverview({
      groups: [
        { groupId: 'group-review', parentTaskId: 'group-parent' },
        { coordinationId: 'coord-archive', parentTaskId: 'archive-parent' },
      ],
      tasks: [
        { taskId: 'group-child', groupId: 'group-review', sessionId: 'session-review', column: 'attention', status: 'failed', sourceKind: 'agent', agentId: 'agent-a', createdAt: '2026-08-26T08:00:00.000Z', updatedAt: '2026-08-27T12:00:00.000Z' },
        { taskId: 'group-parent', groupId: 'group-review', sessionId: 'session-review', column: 'running', status: 'running', sourceKind: 'agent', agentId: 'agent-a', createdAt: '2026-08-25T08:00:00.000Z', updatedAt: '2026-08-27T10:00:00.000Z' },
        { taskId: 'execution-one-old', executionId: 'execution-one', sessionId: 'shared-session', column: 'running', status: 'running', sourceKind: 'local-cli', agentId: 'agent-a', createdAt: '2026-08-24T08:00:00.000Z', updatedAt: '2026-08-27T08:00:00.000Z' },
        { taskId: 'execution-one-new', executionId: 'execution-one', sessionId: 'shared-session', column: 'completed', status: 'completed', sourceKind: 'local-cli', agentId: 'agent-a', createdAt: '2026-08-24T09:00:00.000Z', updatedAt: '2026-08-27T09:00:00.000Z' },
        { taskId: 'execution-two', executionId: 'execution-two', sessionId: 'shared-session', column: 'completed', status: 'completed', sourceKind: 'cogseed', agentId: 'agent-b', createdAt: '2026-08-23T08:00:00.000Z', updatedAt: '2026-08-27T07:00:00.000Z' },
        { taskId: 'archive-child', coordinationId: 'coord-archive', sessionId: 'session-archive', column: 'completed', status: 'completed', sourceKind: 'group-chat', createdAt: '2026-08-22T08:00:00.000Z', updatedAt: '2026-08-27T06:00:00.000Z' },
        { taskId: 'archive-parent', coordinationId: 'coord-archive', sessionId: 'session-archive', column: 'archived', status: 'cancelled', sourceKind: 'group-chat', createdAt: '2026-08-22T07:00:00.000Z', updatedAt: '2026-08-27T05:00:00.000Z' },
      ],
    }, [
      { agent_id: 'agent-a', name: 'Reviewer', enabled: true },
      { agent_id: 'agent-b', name: 'Builder', enabled: true },
    ], new Date(2026, 7, 27, 12));

    expect(model.counts).toMatchObject({
      total: 4, sessions: 3, active: 1, attention: 1, completed: 1, successRate: 33,
    });
    expect(model.statusCounts).toEqual([
      { column: 'running', count: 1 },
      { column: 'attention', count: 1 },
      { column: 'completed', count: 1 },
      { column: 'archived', count: 1 },
    ]);
    expect(model.sources).toEqual([
      { source: 'cogseed', count: 1 },
      { source: 'agent', count: 1 },
      { source: 'local-cli', count: 1 },
      { source: 'group-chat', count: 1 },
    ]);
    expect(model.agentLoad).toEqual([
      expect.objectContaining({ agentId: 'agent-a', total: 2, active: 1, attention: 1, completed: 0 }),
      expect.objectContaining({ agentId: 'agent-b', total: 1, active: 0, attention: 0, completed: 1 }),
    ]);
    expect(model.trend.map((item: any) => item.started)).toEqual([0, 1, 1, 1, 1, 0, 0]);
    expect(model.trend.map((item: any) => item.completed)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(model.trend.map((item: any) => item.attention)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(model.attentionTasks.map((task: any) => task.taskId)).toEqual(['group-parent']);
    expect(model.recentTasks).toHaveLength(4);
  });

  it('keeps recent overview runs stable when input order and timestamps tie', () => {
    const context: any = { window: {}, Object, String, Array, Map, Set, Date, Math };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
    vm.runInContext(read('src/renderer/modules/run-center-overview.js'), context);

    const tasks = [
      { taskId: 'run-b', executionId: 'execution-b', sessionId: 'session-b', column: 'completed', status: 'completed', updatedAt: '2026-08-27T10:00:00.000Z' },
      { taskId: 'run-a', executionId: 'execution-a', sessionId: 'session-a', column: 'attention', status: 'failed', updatedAt: '2026-08-27T10:00:00.000Z' },
    ];
    const build = (orderedTasks: any[]) => context.window.CogSeedRunCenterOverview.buildOverview(
      { tasks: orderedTasks }, [], new Date(2026, 7, 27, 12),
    );

    expect(build(tasks).recentTasks.map((task: any) => task.taskId)).toEqual(['run-a', 'run-b']);
    expect(build([...tasks].reverse()).recentTasks.map((task: any) => task.taskId)).toEqual(['run-a', 'run-b']);
  });

  it('groups built-in roles while keeping external executors and channels separate', () => {
    const context: any = { window: {}, Object, String, Array, Map, Set };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-agents.js'), context);

    const registry = context.window.CogSeedRunCenterAgents;
    const projection = {
      agents: [
        {
          agentId: 'researcher', displayName: 'Researcher', sourceKind: 'cogseed', runtimeKind: 'in_process',
          installed: true, online: true, enabled: true, dispatchable: true, health: 'ready',
          capabilities: ['in-process'], stats: { active: 0, completed: 0, failed: 0 },
        },
        {
          agentId: 'codex-agent', displayName: 'Codex', sourceKind: 'local-cli', runtimeKind: 'cli:codex',
          installed: true, online: true, enabled: true, dispatchable: true, health: 'busy',
          currentTaskId: 'cogseed-task-agent', currentConversationId: 'run-center-agent',
          lastActiveAt: '2026-08-27T01:00:00.000Z', capabilities: ['task-execution'],
          stats: { active: 1, completed: 4, failed: 1 }, endpoint: 'https://internal.invalid', token: 'do-not-leak',
        },
        {
          agentId: 'codex', displayName: 'Codex', sourceKind: 'p3394', runtimeKind: 'p3394:agent',
          installed: true, online: false, enabled: true, dispatchable: false, health: 'offline',
          capabilities: ['task-execution'], stats: { active: 0, completed: 0, failed: 0 },
        },
      ],
      runtimes: [
        { runtimeId: 'local-cli:codex', displayName: 'codex', sourceKind: 'local-cli', runtimeKind: 'codex', installed: true, online: true, enabled: true, dispatchable: true, health: 'error', gatewayRunning: true, gatewayControllable: true, path: '/Users/private/codex' },
        { runtimeId: 'local-cli:gemini', displayName: 'gemini', sourceKind: 'local-cli', runtimeKind: 'gemini', installed: true, online: true, enabled: true, dispatchable: false, health: 'unsupported', gatewayRunning: false, gatewayControllable: false },
      ],
      channels: [{ channelId: 'feishu-safe', displayName: 'Feishu', platform: 'feishu', enabled: true, online: true, health: 'ready', secrets_enc: 'do-not-leak' }],
    };
    const options = {
      text: (key: string, vars?: Record<string, unknown>) => vars ? `${key}:${JSON.stringify(vars)}` : key,
      esc: (value: unknown) => String(value ?? ''), icon: (name: string) => `<i>${name}</i>`,
      formatDate: (value: string) => value, stateView: (key: string) => key,
      dynamicLabel: (prefix: string, value: string) => `${prefix}${value}`, loading: false, error: '',
    };
    const model = registry.buildModel(projection);
    const html = registry.render(projection, options);

    expect(model.counts).toEqual({ native: 1, external: 2, busy: 1, attention: 1 });
    expect(model.nativeAgents.map((agent: any) => agent.agentId)).toEqual(['researcher']);
    expect(model.externalExecutors).toHaveLength(2);
    const codex = model.externalExecutors.find((executor: any) => executor.cli === 'codex');
    expect(codex).toMatchObject({ displayName: 'Codex', health: 'busy', dispatchable: true, gatewayRunning: true });
    expect(codex.entries.map((entry: any) => entry.agentId).sort()).toEqual(['codex', 'codex-agent']);
    expect(codex.runtimes.map((runtime: any) => runtime.runtimeId)).toEqual(['local-cli:codex']);
    expect(registry.buildModel(projection, 'research', 'available').nativeAgents).toHaveLength(1);
    expect(registry.buildModel(projection, 'codex', 'attention').externalExecutors).toHaveLength(1);
    expect(registry.buildModel(projection, 'gemini', 'all').externalExecutors).toHaveLength(1);
    expect(registry.buildModel(projection, '', 'offline').externalExecutors).toHaveLength(1);
    expect(html).toContain('run_center.native_agents_section');
    expect(html).toContain('run-center-native-agent-group');
    expect(html).not.toContain('run-center-native-agent-group" open');
    expect(html).toContain('run_center.native_agent_members');
    expect(html).toContain('run_center.external_agents_section');
    expect(html).toContain('run-center-executor-row');
    expect(html).toContain('data-run-center-agent-gateway="codex"');
    expect(html).toContain('run_center.agent_gateway_control');
    expect(html).not.toContain('run_center.agent_runtime_entries');
    expect(html).not.toContain('cli:codex');
    expect(html).toContain('data-run-center-agent-search');
    expect(html).toContain('run_center.channels_section');
    expect(html).toContain('data-run-center-agent-task="cogseed-task-agent"');
    expect(html).toContain('run_center.agent_health_unsupported');
    expect(html).toContain('run_center.agent_channel_role');
    expect(html).not.toContain('/Users/private');
    expect(html).not.toContain('internal.invalid');
    expect(html).not.toContain('do-not-leak');

    const withoutChannels = registry.render({ ...projection, channels: [] }, options);
    expect(withoutChannels).not.toContain('run_center.channels_section');
  });

  it('starts a task in the selected managed Worktree through the bound renderer controls', async () => {
    const panelListeners = new Map<string, (event: any) => void>();
    const documentListeners = new Map<string, (event: any) => void>();
    const calls: Array<{ channel: string; payload: any }> = [];
    const focusedTabs: string[] = [];
    const focusedControls: string[] = [];
    let watchChange: ((event: any) => void) | null = null;
    let holdNextTaskList = false;
    let releaseTaskList: (() => void) | null = null;
    let failNextTaskList = false;
    let holdNextSessionRead = false;
    let settleSessionRead: ((error?: Error) => void) | null = null;
    let delayedSessionReadCompleted = 0;
    let holdCollaborationAction = false;
    let releaseCollaborationAction: (() => void) | null = null;
    let collaborationActionsCompleted = 0;
    let hiddenTaskId = '';
    let groupedRunMode = false;
    let html = '';
    let created = false;
    let richCollaboration = false;
    let repeatedSessionMode = false;
    const worktreeName = 'cogseed-worktree-dev-renderer-test';
    const task = {
      taskId: 'cogseed-task-renderer', sessionId: 'cogseed-session-renderer', requestId: 'req-renderer',
      conversationId: 'run-center-renderer-conversation',
      status: 'running', title: 'CogSeed task', titleKey: 'run_center.task_kind_cogseed',
      sessionTitle: 'CogSeed task', sessionTitleKey: 'run_center.task_kind_cogseed',
      sourceKind: 'agent', agentId: 'review-agent', worktreeName, column: 'running',
      createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:01.000Z',
      executionId: 'sensitive-execution-id', executionKind: 'sensitive-execution-kind',
      runtimeKind: 'sensitive-runtime-kind', errorCode: 'provider_error',
      conversationMode: 'agent', resultDeliveryState: 'delivered', participantCount: 1, resumable: false,
      actions: { retry: false, skip: false, resume: false, recoverResult: false, abort: true, archive: false },
    };
    const session = {
      sessionId: task.sessionId, title: 'CogSeed task', titleKey: 'run_center.task_kind_cogseed',
      latestTaskId: task.taskId, createdAt: task.createdAt, updatedAt: task.updatedAt,
      taskCount: 1, activeTaskCount: 1, latestStatus: 'running', hasRecovery: false,
    };
    const pendingTask = {
      ...task, taskId: 'pending-task', executionId: 'pending-execution', sessionId: 'pending-session',
      conversationId: 'pending-conversation', title: 'Pending task', titleKey: '', status: 'pending', column: 'pending',
    };
    const archivedTask = {
      ...task, taskId: 'archived-task', executionId: 'archived-execution', sessionId: 'archived-session',
      conversationId: 'archived-conversation', title: 'Archived task', titleKey: '', status: 'cancelled', column: 'archived',
    };
    const repeatedSessionTasks = [2, 3, 4].map((index) => ({
      ...task,
      taskId: `cogseed-task-renderer-${index}`,
      executionId: `shared-session-execution-${index}`,
      status: 'failed',
      column: 'attention',
      updatedAt: `2026-08-27T00:00:0${index}.000Z`,
    }));
    const groupParentTask = {
      ...task,
      taskId: 'group-parent-task', sessionId: 'group-session', executionId: 'group-parent-execution',
      conversationId: 'group-conversation', groupId: 'group-run', title: 'Group parent', titleKey: '', participantCount: 2,
      createdAt: '2026-08-27T00:02:00.000Z', updatedAt: '2026-08-27T00:02:01.000Z',
    };
    const groupChildTask = {
      ...groupParentTask,
      taskId: 'group-child-task', parentTaskId: groupParentTask.taskId,
      executionId: 'group-child-execution', title: 'Group child',
      createdAt: '2026-08-27T00:02:02.000Z', updatedAt: '2026-08-27T00:02:03.000Z',
    };
    const detailTasks = [
      task,
      { ...task, taskId: 'child-a', parentTaskId: task.taskId, title: 'Child A' },
      { ...task, taskId: 'child-b', parentTaskId: task.taskId, title: 'Child B' },
    ];
    const timeline = [
      { eventId: 'event-a', taskId: 'child-a', type: 'task.started', toolName: 'runner', createdAt: '2026-08-27T00:00:02.000Z' },
      { eventId: 'event-b', taskId: 'child-b', type: 'task.started', toolName: 'runner', createdAt: '2026-08-27T00:00:03.000Z' },
      { eventId: 'event-c', taskId: task.taskId, type: 'task.completed', errorCode: 'provider_error', createdAt: '2026-08-27T00:01:02.000Z' },
      { eventId: 'event-d', taskId: task.taskId, type: 'task.completed', errorCode: 'provider_error', createdAt: '2026-08-27T00:01:03.000Z' },
    ];
    const documentState: any = { hidden: false, activeElement: null };
    const dataProperty = (name: string) => name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    const dataSelectorMatches = (element: any, selector: string) => {
      const match = selector.match(/^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/);
      if (!match) return false;
      const property = dataProperty(match[1]);
      return Object.prototype.hasOwnProperty.call(element?.dataset || {}, property)
        && (match[2] === undefined || String(element.dataset[property]) === match[2]);
    };
    const parseDataset = (tag: string) => Object.fromEntries(Array.from(
      tag.matchAll(/\sdata-([a-z0-9-]+)(?:="([^"]*)")?/g),
      (match) => [dataProperty(match[1]), match[2] || ''],
    ));
    const control = (name: string) => {
      const element: any = { disabled: false, getClientRects: () => [{}] };
      element.focus = () => { documentState.activeElement = element; focusedControls.push(name); };
      return element;
    };
    const renderedControl = (name: string, tag: string, options: { button?: boolean; column?: any; role?: string } = {}) => {
      const element = control(name);
      element.dataset = parseDataset(tag);
      element.attributes = Array.from(tag.matchAll(/\s(data-[a-z0-9-]+)(?:="([^"]*)")?/g), (match) => ({
        name: match[1], value: match[2] || '',
      }));
      element.tabIndex = Number(tag.match(/\stabindex="(-?\d+)"/)?.[1] || 0);
      element.role = options.role || tag.match(/\srole="([^"]+)"/)?.[1] || '';
      element.className = tag.match(/\sclass="([^"]*)"/)?.[1] || '';
      element.classList = { contains: (className: string) => element.className.split(/\s+/).includes(className) };
      element.matches = (selector: string) => dataSelectorMatches(element, selector)
        || (selector === '[role="menuitem"]' && element.role === 'menuitem')
        || (selector === '[data-dashboard-board-run-key]' && element.dataset.dashboardBoardRunKey !== undefined);
      element.closest = (selector: string) => {
        if (selector === 'button') return options.button ? element : null;
        if (selector === '[role="menuitem"]' && element.role === 'menuitem') return element;
        if (selector === '[data-run-center-tools-menu] [role="menuitem"]' && element.role === 'menuitem' && element.menu) return element;
        if (selector === '.dashboard-board-card' && element.classList.contains('dashboard-board-card')) return element;
        if (selector === '.run-center-collaboration-run-list') return element.collaborationList || null;
        if (dataSelectorMatches(element, selector)) return element;
        if (['[data-dashboard-board-column]', '.dashboard-board-column'].includes(selector)) return options.column || null;
        if (selector === '[data-run-center-tools-menu]') return element.menu || null;
        return null;
      };
      element.getAttribute = (name: string) => name === 'tabindex' ? String(element.tabIndex) : null;
      return element;
    };
    let createFirst: any = null;
    let createLast: any = null;
    const detailClose = control('detail-close');
    detailClose.attributes = [{ name: 'data-run-center-detail-close', value: '' }];
    const detailLast = control('detail-last');
    const diagnosticsClose = control('diagnostics-close');
    const diagnosticsLast = control('diagnostics-last');
    const worktreesClose = control('worktrees-close');
    const worktreesLast = control('worktrees-last');
    const createDialog = {
      querySelectorAll: () => [createFirst, createLast].filter(Boolean),
      contains: (element: unknown) => element === createFirst || element === createLast,
    };
    const detailDrawer = {
      querySelectorAll: () => [detailClose, detailLast],
      contains: (element: unknown) => element === detailClose || element === detailLast,
    };
    const diagnosticsDialog = {
      querySelectorAll: () => [diagnosticsClose, diagnosticsLast],
      contains: (element: unknown) => element === diagnosticsClose || element === diagnosticsLast,
    };
    const worktreesDialog = {
      querySelectorAll: () => [worktreesClose, worktreesLast],
      contains: (element: unknown) => element === worktreesClose || element === worktreesLast,
    };
    let searchControl: any = null;
    let queryClear: any = null;
    let detailBackdrop: any = null;
    let toolsMenu: any = null;
    let toolMenuItems: any[] = [];
    let boardControls: any[] = [];
    let boardColumns: any[] = [];
    let collaborationControls: any[] = [];
    const makeSearchControl = () => {
      const element = control('search');
      element.attributes = [{ name: 'data-run-center-search', value: '' }];
      element.selectionStart = 0;
      element.selectionEnd = 0;
      element.selectionDirection = 'none';
      element.setSelectionRange = (start: number, end: number, direction: string) => {
        element.selectionStart = start;
        element.selectionEnd = end;
        element.selectionDirection = direction;
      };
      return element;
    };
    const focusTargets: Record<string, any> = {
      '[data-run-center-create-open]': control('create-open'),
      '[data-run-center-reassign]': control('reassign'),
      '[data-run-center-detail-close]': detailClose,
      '[data-run-center-detail-open]': control('detail-open'),
      '[data-run-center-diagnostics-close]': diagnosticsClose,
      '[data-run-center-worktrees-close]': worktreesClose,
      '[data-run-center-tools-toggle]': control('tools-toggle'),
      '.dashboard-board-card.is-selected': control('board-selected'),
      '.dashboard-board-card.is-selected, [data-run-center-detail-open]': control('drawer-return'),
      '[data-dashboard-archive-toggle]': control('archive-toggle'),
    };
    const panel = {
      addEventListener: (type: string, listener: (event: any) => void) => panelListeners.set(type, listener),
      querySelector: (selector: string) => {
        const view = selector.match(/^\[data-run-center-view="([^"]+)"\]$/)?.[1];
        if (view) return { focus: () => focusedTabs.push(view) };
        const boardRunKey = selector.match(/^\[data-dashboard-board-run-key="([^"]+)"\]$/)?.[1];
        if (boardRunKey) return boardControls.find((item) => item.dataset.dashboardBoardRunKey === boardRunKey) || null;
        const boardColumn = selector.match(/^\[data-dashboard-board-column="([^"]+)"\]$/)?.[1];
        if (boardColumn) return boardColumns.find((item) => item.dataset.dashboardBoardColumn === boardColumn) || null;
        if (selector === '[data-run-center-create-task], [data-run-center-create-agent]' && html.includes('data-run-center-create-dialog')) return createFirst;
        if (['[data-run-center-create-task]', '[data-run-center-create-agent]'].includes(selector)
          && createFirst?.attributes?.[0]?.name === selector.slice(1, -1)) return createFirst;
        if (selector === '[data-run-center-create-dialog]' && html.includes('data-run-center-create-dialog')) return createDialog;
        if (selector === '[data-run-center-details]' && html.includes('data-run-center-details')) return detailDrawer;
        if (selector === '[data-run-center-diagnostics-dialog]' && html.includes('data-run-center-diagnostics-dialog')) return diagnosticsDialog;
        if (selector === '[data-run-center-worktrees-dialog]' && html.includes('data-run-center-worktrees-dialog')) return worktreesDialog;
        if (selector === '[data-run-center-search]') return searchControl;
        if (selector === '[data-run-center-query-clear]') return queryClear;
        if (selector === '[data-run-center-detail-backdrop]') return detailBackdrop;
        if (selector === '[data-run-center-tools-menu]') return toolsMenu;
        if (selector === '[data-run-center-tools-menu] [role="menuitem"]') return toolMenuItems[0] || null;
        if (selector === '.dashboard-board-card.is-selected') return boardControls.find((item) => item.classList.contains('is-selected')) || focusTargets[selector];
        if (selector === '.dashboard-board-card.is-selected, [data-run-center-detail-open]') {
          return boardControls.find((item) => item.classList.contains('is-selected')) || focusTargets[selector];
        }
        const rendered = [...boardControls, ...collaborationControls, ...toolMenuItems, queryClear, detailBackdrop]
          .filter(Boolean).find((item) => dataSelectorMatches(item, selector));
        if (rendered) return rendered;
        return focusTargets[selector] || null;
      },
      querySelectorAll: (selector: string) => {
        if (selector === '[data-run-center-search]' && searchControl) return [searchControl];
        if (selector === '[data-dashboard-board-run-key]') return boardControls;
        if (selector === '[data-run-center-collaboration-run-key]') return collaborationControls;
        if (selector === '[data-run-center-tools-menu] [role="menuitem"]' || selector === '[role="menuitem"]') return toolMenuItems;
        if (['[data-run-center-create-task]', '[data-run-center-create-agent]'].includes(selector)
          && createFirst?.attributes?.[0]?.name === selector.slice(1, -1)) return [createFirst];
        const rendered = [...boardControls, ...collaborationControls, ...toolMenuItems, queryClear, detailBackdrop]
          .filter(Boolean).filter((item) => dataSelectorMatches(item, selector));
        if (rendered.length) return rendered;
        return [];
      },
      contains: (element: unknown) => [searchControl, createFirst, createLast, detailClose, detailLast,
        diagnosticsClose, diagnosticsLast, worktreesClose, worktreesLast, queryClear, detailBackdrop,
        ...toolMenuItems, ...boardControls, ...collaborationControls, ...Object.values(focusTargets)].includes(element),
      closest: () => ({ classList: { contains: () => true } }),
      get innerHTML() { return html; },
      set innerHTML(value: string) {
        html = value;
        if (value.includes('data-run-center-create-dialog')) {
          createFirst = control('create-first');
          createLast = control('create-last');
          createFirst.attributes = [{
            name: value.includes('data-run-center-create-task') ? 'data-run-center-create-task' : 'data-run-center-create-agent',
            value: '',
          }];
        } else {
          createFirst = null;
          createLast = null;
        }
        searchControl = value.includes('data-run-center-search') ? makeSearchControl() : null;
        const queryClearTag = value.match(/<(?:button|span)\b[^>]*data-run-center-query-clear[^>]*>/)?.[0] || '';
        queryClear = queryClearTag ? renderedControl('query-clear', queryClearTag, { button: queryClearTag.startsWith('<button') }) : null;
        const backdropTag = value.match(/<[^>]+data-run-center-detail-backdrop[^>]*>/)?.[0] || '';
        detailBackdrop = backdropTag ? renderedControl('detail-backdrop', backdropTag, { button: backdropTag.startsWith('<button') }) : null;

        toolMenuItems = [];
        const toolsMenuTag = value.match(/<[^>]+data-run-center-tools-menu[^>]*>/)?.[0] || '';
        toolsMenu = toolsMenuTag ? {
          dataset: parseDataset(toolsMenuTag),
          querySelectorAll: (selector: string) => selector === '[role="menuitem"]' ? toolMenuItems : [],
          contains: (element: unknown) => toolMenuItems.includes(element),
        } : null;
        if (toolsMenu) {
          toolMenuItems = Array.from(value.matchAll(/<button\b[^>]*role="menuitem"[^>]*>/g), (match, index) => {
            const item = renderedControl(`tool-menu-${index}`, match[0], { button: true, role: 'menuitem' });
            item.menu = toolsMenu;
            item.parentElement = toolsMenu;
            return item;
          });
        }

        boardControls = [];
        boardColumns = [];
        const boardContainer: any = {
          querySelectorAll: (selector: string) => selector === '[data-dashboard-board-column]'
            ? boardColumns
            : selector === '[data-dashboard-board-run-key]' ? boardControls : [],
        };
        const columnRanges = Array.from(value.matchAll(/<section\b[^>]*data-dashboard-board-column="([^"]+)"[^>]*>/g), (match) => ({
          start: match.index || 0,
          end: value.indexOf('</section>', (match.index || 0) + match[0].length),
          key: match[1],
          tag: match[0],
        }));
        for (const range of columnRanges) {
          const column: any = {
            dataset: { dashboardBoardColumn: range.key },
            classList: { contains: (className: string) => className === 'dashboard-board-column' },
            controls: [],
            querySelectorAll: (selector: string) => selector === '[data-dashboard-board-run-key]' ? column.controls : [],
            closest: (selector: string) => selector === '.dashboard-board-columns' ? boardContainer : null,
          };
          boardColumns.push(column);
        }
        for (const [index, match] of Array.from(value.matchAll(/<button\b[^>]*data-dashboard-board-run-key="[^"]+"[^>]*>/g)).entries()) {
          const offset = match.index || 0;
          const column = boardColumns[columnRanges.findIndex((range) => offset >= range.start && offset <= range.end)] || null;
          const selected = /\bis-selected\b/.test(match[0]);
          const item = renderedControl(selected ? 'board-selected' : `board-${index}`, match[0], { button: true, column });
          item.parentElement = { closest: (selector: string) => ['[data-dashboard-board-column]', '.dashboard-board-column'].includes(selector) ? column : null };
          boardControls.push(item);
          if (column) column.controls.push(item);
        }
        collaborationControls = [];
        const collaborationList: any = {
          querySelectorAll: (selector: string) => selector === '[data-run-center-collaboration-run-key]'
            ? collaborationControls
            : [],
        };
        for (const [index, match] of Array.from(value.matchAll(/<button\b[^>]*data-run-center-collaboration-run-key="[^"]+"[^>]*>/g)).entries()) {
          const selected = /\bis-selected\b/.test(match[0]);
          const item = renderedControl(selected ? 'collaboration-selected' : `collaboration-${index}`, match[0], { button: true });
          item.collaborationList = collaborationList;
          collaborationControls.push(item);
        }
      },
    };
    const invoke = vi.fn(async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      if (channel === 'agents.list') return { agents: [{ agent_id: 'review-agent', name: 'Reviewer', enabled: true }] };
      if (channel === 'cogseed.agent.list') return {
        schemaVersion: 1, updatedAt: task.updatedAt,
        agents: [
          { agentId: 'review-agent', displayName: 'Reviewer', sourceKind: 'cogseed', definitionSource: 'custom', runtimeKind: 'in_process', dispatchable: true, health: 'ready', stats: { active: 0, completed: 0, failed: 0 } },
          { agentId: 'codex-agent', displayName: 'Codex', sourceKind: 'p3394', definitionSource: 'custom', runtimeKind: 'p3394-gateway:codex', installed: true, dispatchable: true, health: 'ready', stats: { active: 0, completed: 0, failed: 0 } },
        ],
        runtimes: [{ runtimeId: 'local-cli:codex', displayName: 'codex', sourceKind: 'local-cli', runtimeKind: 'codex', installed: true, dispatchable: true, health: 'ready', gatewayRunning: true, gatewayControllable: true }],
        channels: [],
      };
      if (channel === 'cogseed.worktree.list') return {
        schemaVersion: 1, repository: { path: '/private/repository', branch: 'develop' },
        worktrees: [{ path: `/private/${worktreeName}`, name: worktreeName, branch: 'dev/renderer-test', head: 'abc', dirty: false, verifiable: true }],
      };
      if (channel === 'cogseed.dashboard.diagnostics') return {
        taskCount: 3, sessionCount: 3, activeTaskCount: 2, attentionTaskCount: 0,
        sourceCounts: { agent: 3 }, statusCounts: { running: 1, pending: 1, cancelled: 1 },
        runtime: { activeTaskCount: 2, stateMatchesProjection: true }, errorCodes: [],
      };
      if (channel === 'cogseed.task.list') {
        if (failNextTaskList) {
          failNextTaskList = false;
          throw new Error('transient dashboard failure');
        }
        if (holdNextTaskList) {
          holdNextTaskList = false;
          await new Promise<void>((resolve) => { releaseTaskList = resolve; });
        }
        const listedTasks = groupedRunMode
          ? [groupParentTask, groupChildTask, archivedTask]
          : repeatedSessionMode ? [task, ...repeatedSessionTasks, archivedTask] : [task, pendingTask, archivedTask];
        const tasks = hiddenTaskId ? listedTasks.filter((item) => item.taskId !== hiddenTaskId) : listedTasks;
        const groups = groupedRunMode ? [{ groupId: groupParentTask.groupId, parentTaskId: groupParentTask.taskId }] : [];
        return { schemaVersion: 1, tasks: created ? tasks : [], groups, counts: { pending: created ? 1 : 0, running: created ? 1 : 0, attention: repeatedSessionMode ? 4 : 0, completed: 0, archived: created ? 1 : 0 } };
      }
      if (channel === 'cogseed.session.list') return { sessions: created ? [session] : [] };
      if (channel === 'cogseed.session.read') {
        if (holdNextSessionRead) {
          holdNextSessionRead = false;
          try {
            await new Promise<void>((resolve, reject) => {
              settleSessionRead = (error?: Error) => error ? reject(error) : resolve();
            });
          } finally {
            delayedSessionReadCompleted += 1;
          }
        }
        const availableTasks = [task, ...repeatedSessionTasks, pendingTask, archivedTask, groupParentTask, groupChildTask];
        const requestedTask = availableTasks.find((item) => item.taskId === payload?.taskId)
          || availableTasks.find((item) => item.sessionId === payload?.sessionId) || task;
        const requestedSession = requestedTask === task ? session : {
          ...session,
          sessionId: requestedTask.sessionId,
          title: requestedTask.title,
          titleKey: requestedTask.titleKey,
          latestTaskId: requestedTask.taskId,
          latestStatus: requestedTask.status,
        };
        if (requestedTask !== task) return {
          session: requestedSession,
          collaboration: {
            schemaVersion: 1, sessionId: requestedTask.sessionId, session: requestedSession, task: requestedTask,
            actors: [], tasks: [requestedTask], workflow: { childTaskIds: [], steps: [] }, reviews: [], conflicts: [],
            activity: [], timeline: [], recovery: { recoverable: false, taskIds: [] }, actions: requestedTask.actions,
          },
        };
        const collaboration = richCollaboration ? {
          schemaVersion: 1, sessionId: task.sessionId, session: { ...session, participantCount: 2 }, task: { ...task, participantCount: 2 },
          actors: [
            { actorId: 'actor-private', displayName: 'Reviewer', role: 'member_agent', status: 'running' },
            { actorId: 'actor-private-2', displayName: 'Builder', role: 'child_agent', status: 'completed' },
          ], tasks: detailTasks,
          workflow: { childTaskIds: ['child-a', 'child-b'], steps: [{ stepId: 'step-private', status: 'failed', failureCode: 'failure-private', dependsOn: ['dependency-private'], attemptCount: 2 }] },
          reviews: [{ gateId: 'gate-private', status: 'needs_review', reviewDecision: 'approve' }],
          conflicts: [{ conflictId: 'conflict-private', type: 'quality', status: 'detected', affectedStepIds: ['step-private'] }],
          activity: [], timeline, recovery: { recoverable: false, taskIds: [] }, actions: task.actions,
        } : {
          schemaVersion: 1, sessionId: task.sessionId, session, task, actors: [], tasks: detailTasks,
          workflow: { childTaskIds: ['child-a', 'child-b'], steps: [] }, reviews: [], conflicts: [], activity: [], timeline,
          recovery: { recoverable: false, taskIds: [] }, actions: task.actions,
        };
        return { session, collaboration };
      }
      if (channel === 'cogseed.collaboration.action') {
        if (holdCollaborationAction) {
          holdCollaborationAction = false;
          await new Promise<void>((resolve) => { releaseCollaborationAction = resolve; });
        }
        collaborationActionsCompleted += 1;
        return { ok: true };
      }
      if (channel === 'cogseed.task.action') {
        if (payload?.action === 'archive') {
          task.column = 'archived';
          task.actions.archive = false;
        }
        return { ok: true };
      }
      if (channel === 'cogseed.task.start') { created = true; return task; }
      if (channel === 'p3394.external.stop') return { ok: true };
      throw new Error(`unexpected channel: ${channel}`);
    });
    const context: any = {
      conversations: [
        { conversation_id: task.conversationId, title: 'CogSeed task' },
        { conversation_id: pendingTask.conversationId, title: 'Pending task' },
        { conversation_id: archivedTask.conversationId, title: 'Archived task' },
        { conversation_id: groupParentTask.conversationId, title: 'Group parent' },
      ],
      window: {
        cogseed: {
          invoke,
          stream: (_channel: string, _payload: unknown, onEvent: (event: any) => void) => {
            watchChange = onEvent;
            return { cancel: vi.fn(), promise: new Promise(() => {}) };
          },
        },
        addEventListener: vi.fn(), setTimeout, clearTimeout, confirm: vi.fn(() => true),
        setView: vi.fn(), activateSettingsTab: vi.fn(),
        uiIconHtml: (name: string) => `<i>${name}</i>`,
      },
      document: Object.assign(documentState, { getElementById: () => panel, addEventListener: (type: string, listener: (event: any) => void) => documentListeners.set(type, listener) }),
      t: (key: string, vars?: Record<string, unknown>) => key === 'run_center.error_help_provider_error'
        ? 'Check the provider configuration.'
        : vars ? `${key}:${JSON.stringify(vars)}` : key,
      getLang: () => 'en', Intl, Date, Math, Map, Set, Object, String, Array, Error, Promise, Number,
    };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);
    vm.runInContext(read('src/renderer/modules/run-center-overview.js'), context);
    vm.runInContext(read('src/renderer/modules/run-center-agents.js'), context);
    vm.runInContext(read('src/renderer/modules/run-center.js'), context);
    context.window.renderRunCenter();

    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 100; i += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error('renderer action did not settle');
    };
    await waitFor(() => calls.some((call) => call.channel === 'cogseed.agent.list'));
    expect(html.match(/role="tab"/g)).toHaveLength(5);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(5);
    expect(html).toContain('id="run-center-tab-overview" role="tab" aria-controls="run-center-panel-overview" aria-selected="true" tabindex="0"');
    expect(html.match(/tabindex="-1"/g)).toHaveLength(4);
    expect(html).toContain('id="run-center-panel-overview" role="tabpanel" aria-labelledby="run-center-tab-overview"');

    const pressTabKey = (key: string, view: string) => {
      const preventDefault = vi.fn();
      documentListeners.get('keydown')?.({
        key, preventDefault,
        target: { closest: (selector: string) => selector === '[data-run-center-view]' ? { dataset: { runCenterView: view } } : null },
      });
      expect(preventDefault).toHaveBeenCalledOnce();
    };
    pressTabKey('ArrowRight', 'overview');
    expect(html).toContain('id="run-center-panel-runs" role="tabpanel" aria-labelledby="run-center-tab-runs"');
    pressTabKey('ArrowRight', 'runs');
    expect(html).toContain('id="run-center-panel-history" role="tabpanel" aria-labelledby="run-center-tab-history"');
    pressTabKey('ArrowRight', 'history');
    expect(html).toContain('id="run-center-panel-agents" role="tabpanel" aria-labelledby="run-center-tab-agents"');
    pressTabKey('ArrowRight', 'agents');
    expect(html).toContain('id="run-center-panel-collaboration" role="tabpanel" aria-labelledby="run-center-tab-collaboration"');
    pressTabKey('Home', 'collaboration');
    expect(html).toContain('id="run-center-panel-overview" role="tabpanel" aria-labelledby="run-center-tab-overview"');
    expect(focusedTabs).toEqual(['runs', 'history', 'agents', 'collaboration', 'overview']);

    const eventTarget = (dataset: Record<string, string>, button = true) => {
      const target: any = { dataset };
      target.closest = (selector: string) => selector === 'button'
        ? button ? target : null
        : dataSelectorMatches(target, selector) ? target : null;
      return target;
    };
    const click = (datasetOrTarget: Record<string, string> | any) => {
      const target = datasetOrTarget?.closest ? datasetOrTarget : eventTarget(datasetOrTarget);
      panelListeners.get('click')?.({ target });
    };
    const input = (selector: string, value: string) => panelListeners.get('input')?.({ target: { matches: (candidate: string) => candidate === selector, value } });
    const change = (selector: string, value: string) => panelListeners.get('change')?.({ target: { matches: (candidate: string) => candidate === selector, value } });
    const changeGateway = (cli: string, checked: boolean) => panelListeners.get('change')?.({
      target: { matches: (candidate: string) => candidate === '[data-run-center-agent-gateway]', dataset: { runCenterAgentGateway: cli }, checked },
    });

    click({ runCenterView: 'history' });
    await waitFor(() => html.includes('id="run-center-panel-history" role="tabpanel"'));
    expect(html).toContain('class="run-center-layout is-runs is-history is-queue-mode"');
    expect(html).toContain('data-run-center-search');
    expect(html).toContain('id="run-center-tab-history" role="tab"');
    click({ runCenterView: 'collaboration' });
    await waitFor(() => html.includes('id="run-center-panel-collaboration" role="tabpanel"'));
    expect(html).toContain('class="run-center-layout is-collaboration"');
    expect(html).toContain('run-center-collaboration-run-list');
    click({ runCenterView: 'overview' });
    await waitFor(() => html.includes('id="run-center-panel-overview" role="tabpanel"'));

    click({ runCenterView: 'agents' });
    await waitFor(() => html.includes('data-run-center-agent-gateway="codex"'));
    expect(focusedTabs.at(-1)).toBe('agents');
    expect(html).toContain('data-run-center-agent-gateway="codex"');
    changeGateway('codex', false);
    await waitFor(() => calls.some((call) => call.channel === 'p3394.external.stop'));
    expect(calls.find((call) => call.channel === 'p3394.external.stop')?.payload).toEqual({ cli: 'codex' });

    expect(html).toContain('data-run-center-tools-toggle');
    expect(html).toContain('aria-haspopup="menu" aria-controls="run-center-tools-menu" aria-expanded="false"');
    click({ runCenterToolsToggle: '' });
    await waitFor(() => toolMenuItems.length === 2 && documentState.activeElement === toolMenuItems[0]);
    expect(html).toContain('role="menu" data-run-center-tools-menu');
    expect(toolMenuItems.map((item) => item.tabIndex)).toEqual([0, -1]);

    const pressControlKey = (target: any, key: string, extras: Record<string, unknown> = {}) => {
      const preventDefault = vi.fn();
      documentListeners.get('keydown')?.({ key, target, preventDefault, ...extras });
      return preventDefault;
    };
    let menuItems = [...toolMenuItems];
    expect(pressControlKey(menuItems[0], 'ArrowDown')).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(menuItems[1]);
    expect(menuItems.map((item) => item.tabIndex)).toEqual([-1, 0]);
    expect(pressControlKey(menuItems[1], 'ArrowDown')).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(menuItems[0]);
    expect(pressControlKey(menuItems[0], 'ArrowUp')).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(menuItems[1]);
    expect(pressControlKey(menuItems[1], 'Home')).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(menuItems[0]);
    expect(pressControlKey(menuItems[0], 'End')).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(menuItems[1]);

    const composingMenuKey = pressControlKey(menuItems[1], 'ArrowUp', { isComposing: true });
    expect(composingMenuKey).not.toHaveBeenCalled();
    expect(documentState.activeElement).toBe(menuItems[1]);
    const menuTab = pressControlKey(menuItems[1], 'Tab');
    expect(menuTab).not.toHaveBeenCalled();
    await waitFor(() => toolMenuItems.length === 0 && !html.includes('data-run-center-tools-menu'));

    const openerArrowUp = pressControlKey(eventTarget({ runCenterToolsToggle: '' }), 'ArrowUp');
    expect(openerArrowUp).toHaveBeenCalledOnce();
    await waitFor(() => toolMenuItems.length === 2 && documentState.activeElement === toolMenuItems[1]);
    menuItems = [...toolMenuItems];
    const menuEscape = pressControlKey(menuItems[1], 'Escape');
    expect(menuEscape).toHaveBeenCalledOnce();
    await waitFor(() => !html.includes('data-run-center-tools-menu') && focusedControls.at(-1) === 'tools-toggle');

    click({ runCenterDiagnosticsOpen: '' });
    await waitFor(() => html.includes('data-run-center-diagnostics-dialog') && documentState.activeElement === diagnosticsClose);
    const diagnosticsInternalTab = vi.fn();
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: diagnosticsInternalTab, target: {} });
    expect(diagnosticsInternalTab).not.toHaveBeenCalled();
    documentState.activeElement = diagnosticsLast;
    const diagnosticsBoundaryTab = vi.fn();
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: diagnosticsBoundaryTab, target: {} });
    expect(diagnosticsBoundaryTab).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(diagnosticsClose);
    documentListeners.get('keydown')?.({ key: 'Escape', target: {} });
    await waitFor(() => focusedControls.at(-1) === 'tools-toggle');

    click({ runCenterWorktreesOpen: '' });
    await waitFor(() => html.includes('data-run-center-worktrees-dialog') && documentState.activeElement === worktreesClose);
    documentState.activeElement = worktreesClose;
    const worktreesBoundaryTab = vi.fn();
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: true, preventDefault: worktreesBoundaryTab, target: {} });
    expect(worktreesBoundaryTab).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(worktreesLast);
    click({ runCenterWorktreesClose: '' });
    await waitFor(() => focusedControls.at(-1) === 'tools-toggle');

    click({ runCenterCreateOpen: '' });
    expect(html).not.toContain(worktreeName);
    expect(html).toContain('data-run-center-create-advanced');
    await waitFor(() => focusedControls.includes('create-first'));
    click({ runCenterCreateAdvanced: '' });
    await waitFor(() => html.includes(worktreeName));
    documentState.activeElement = createLast;
    const trapForward = vi.fn();
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: trapForward, target: {} });
    expect(trapForward).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(createFirst);
    const trapBackward = vi.fn();
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: true, preventDefault: trapBackward, target: {} });
    expect(trapBackward).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(createLast);
    input('[data-run-center-create-task]', 'Run the isolated review');
    change('[data-run-center-create-agent]', 'review-agent');
    change('[data-run-center-create-worktree]', worktreeName);
    click({ runCenterCreateSubmit: '' });
    await waitFor(() => calls.some((call) => call.channel === 'cogseed.task.start'));

    const start = calls.find((call) => call.channel === 'cogseed.task.start');
    expect(start?.payload).toMatchObject({
      task: 'Run the isolated review', agentId: 'review-agent', worktreeName,
    });
    expect(start?.payload).not.toHaveProperty('workingDir');
    await waitFor(() => html.includes('data-run-center-detail-tab="summary"'));

    click({ runCenterView: 'runs' });
    click({ runCenterMode: 'board' });
    await waitFor(() => boardControls.length === 2);
    expect(boardControls.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(boardControls.filter((item) => item.tabIndex === -1)).toHaveLength(1);

    change('[data-run-center-source-filter]', 'agent');
    input('[data-run-center-search]', 'Pending');
    expect(html).toContain('data-run-center-query-count role="status" aria-live="polite"');
    expect(html.match(/data-run-center-query-count[^>]*>([\s\S]*?)<\/span>/)?.[1]).toContain('&quot;count&quot;:1');
    expect(queryClear).not.toBeNull();
    expect(html).toContain('<option value="agent" selected>run_center.source_agent</option>');
    expect(html).toContain('aria-pressed="true" class="run-center-filter is-active" data-run-center-filter="all"');
    click({ runCenterQueryClear: '' });
    await waitFor(() => queryClear === null && documentState.activeElement === searchControl);
    expect(html).toContain('value="" data-run-center-search');
    expect(html.match(/data-run-center-query-count[^>]*>([\s\S]*?)<\/span>/)?.[1]).toContain('&quot;count&quot;:2');
    expect(html).toContain('<option value="agent" selected>run_center.source_agent</option>');
    expect(html).toContain('aria-pressed="true" class="run-center-filter is-active" data-run-center-filter="all"');

    change('[data-run-center-source-filter]', 'all');
    await waitFor(() => boardControls.length === 2);
    const runningCard = boardControls.find((item) => item.dataset.dashboardBoardTaskId === task.taskId);
    const pendingCard = boardControls.find((item) => item.dataset.dashboardBoardTaskId === pendingTask.taskId);
    expect(runningCard).toBeTruthy();
    expect(pendingCard).toBeTruthy();
    const detailReadsBeforeBoardKeys = calls.filter((call) => call.channel === 'cogseed.session.read').length;
    runningCard.focus();
    expect(pressControlKey(runningCard, 'ArrowLeft')).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(pendingCard);
    expect(pressControlKey(pendingCard, 'ArrowRight')).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(runningCard);
    expect(pressControlKey(runningCard, 'Home')).toHaveBeenCalledOnce();
    expect(pressControlKey(runningCard, 'End')).toHaveBeenCalledOnce();
    expect(pressControlKey(runningCard, 'ArrowUp')).toHaveBeenCalledOnce();
    expect(pressControlKey(runningCard, 'ArrowDown')).toHaveBeenCalledOnce();
    expect(boardControls.filter((item) => item.tabIndex === 0)).toEqual([runningCard]);
    expect(calls.filter((call) => call.channel === 'cogseed.session.read')).toHaveLength(detailReadsBeforeBoardKeys);
    expect(html).not.toContain('data-run-center-detail-backdrop');

    pressControlKey(runningCard, 'ArrowLeft');
    expect(documentState.activeElement).toBe(pendingCard);
    click({ runCenterFilter: 'running' });
    await waitFor(() => boardControls.length === 1);
    expect(boardControls[0].dataset.dashboardBoardTaskId).toBe(task.taskId);
    expect(boardControls[0].tabIndex).toBe(0);
    click({ runCenterFilter: 'all' });
    await waitFor(() => boardControls.length === 2);

    click({ dashboardArchiveToggle: '' });
    click({ runCenterFilter: 'completed' });
    input('[data-run-center-search]', 'hidden-old-search');
    change('[data-run-center-source-filter]', 'local-cli');
    click({ runCenterView: 'overview' });
    click({ runCenterOverviewFilter: 'pending' });
    expect(html).toContain('data-run-center-filter="pending"');
    expect(html).toContain('aria-pressed="true" class="run-center-filter is-active" data-run-center-filter="pending"');
    expect(html).toContain('data-run-center-search placeholder="run_center.search_placeholder"');
    expect(html).toContain('<option value="all" selected>run_center.source_all</option>');
    expect(html).toContain('data-run-center-archive-scope aria-pressed="false"');
    expect(html).toContain('data-run-center-queue-task="pending-task"');
    expect(html).not.toContain('data-run-center-queue-task="cogseed-task-renderer"');

    await new Promise((resolve) => setTimeout(resolve, 0));
    input('[data-run-center-search]', 'Pend');
    const searchBeforeRefresh = searchControl;
    searchBeforeRefresh.selectionStart = 1;
    searchBeforeRefresh.selectionEnd = 3;
    searchBeforeRefresh.selectionDirection = 'forward';
    searchBeforeRefresh.focus();
    const taskListCallsBeforeWatch = calls.filter((call) => call.channel === 'cogseed.task.list').length;
    expect(watchChange).not.toBeNull();
    watchChange?.({ type: 'change' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitFor(() => calls.filter((call) => call.channel === 'cogseed.task.list').length > taskListCallsBeforeWatch
      && documentState.activeElement === searchControl);
    expect(searchControl).not.toBe(searchBeforeRefresh);
    expect([searchControl.selectionStart, searchControl.selectionEnd, searchControl.selectionDirection]).toEqual([1, 3, 'forward']);

    holdNextTaskList = true;
    searchControl.focus();
    const taskListsBeforeQueuedRefresh = calls.filter((call) => call.channel === 'cogseed.task.list').length;
    watchChange?.({ type: 'change' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitFor(() => releaseTaskList !== null);
    watchChange?.({ type: 'change' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    click({ runCenterCreateOpen: '' });
    await waitFor(() => html.includes(worktreeName) && documentState.activeElement === createFirst);
    const searchBehindModal = searchControl;
    const releaseHeldTaskList = releaseTaskList;
    releaseTaskList = null;
    releaseHeldTaskList?.();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitFor(() => calls.filter((call) => call.channel === 'cogseed.task.list').length >= taskListsBeforeQueuedRefresh + 2
      && searchControl !== searchBehindModal);
    expect(documentState.activeElement).toBe(createFirst);
    click({ runCenterCreateClose: '' });
    await waitFor(() => focusedControls.at(-1) === 'create-open');

    input('[data-run-center-search]', '');
    change('[data-run-center-source-filter]', 'all');
    click({ runCenterFilter: 'all' });
    holdNextSessionRead = true;
    click({ dashboardBoardTaskId: task.taskId, dashboardBoardSessionId: task.sessionId });
    await waitFor(() => settleSessionRead !== null);
    click({ dashboardBoardTaskId: pendingTask.taskId, dashboardBoardSessionId: pendingTask.sessionId });
    await waitFor(() => html.includes('<h2>Pending task</h2>'));
    const releaseOlderSelection = settleSessionRead;
    settleSessionRead = null;
    releaseOlderSelection?.();
    await waitFor(() => delayedSessionReadCompleted === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(html).toContain('<h2>Pending task</h2>');
    expect(html).not.toContain('<h2>CogSeed task</h2>');
    expect(detailBackdrop).toBeNull();
    expect(html).not.toContain('data-run-center-detail-backdrop');
    expect(html).not.toContain('<div class="run-center-shell" inert aria-hidden="true">');
    expect(html).toContain('class="run-center-layout is-runs is-queue-mode is-detail-open"');
    expect(html).toContain('class="run-center-run-detail" aria-live="polite"');
    expect(html).toContain('data-run-center-detail-tab="summary"');
    expect(html).toContain('data-run-center-detail-tab="history"');
    expect(read('src/renderer/modules/run-center.js')).toContain("state.runMode === 'board'");
    click({ runCenterDetailClose: '' });
    await waitFor(() => focusedControls.at(-1) === 'board-selected');
    expect(html).not.toContain('is-queue-mode is-detail-open');

    const delayedReadsBeforeFailure = delayedSessionReadCompleted;
    holdNextSessionRead = true;
    watchChange?.({ type: 'change' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitFor(() => settleSessionRead !== null);
    click({ dashboardBoardTaskId: task.taskId, dashboardBoardSessionId: task.sessionId });
    await waitFor(() => html.includes('<h2>CogSeed task</h2>'));
    const rejectOlderRefresh = settleSessionRead;
    settleSessionRead = null;
    rejectOlderRefresh?.(new Error('stale detail failure'));
    await waitFor(() => delayedSessionReadCompleted > delayedReadsBeforeFailure);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(html).toContain('<h2>CogSeed task</h2>');
    expect(html).not.toContain('stale detail failure');
    click({ runCenterDetailBack: '' });
    await waitFor(() => focusedControls.at(-1) === 'board-selected');

    failNextTaskList = true;
    const taskListsBeforeFailure = calls.filter((call) => call.channel === 'cogseed.task.list').length;
    watchChange?.({ type: 'change' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitFor(() => calls.filter((call) => call.channel === 'cogseed.task.list').length > taskListsBeforeFailure
      && html.includes('transient dashboard failure'));
    const taskListsBeforeRecovery = calls.filter((call) => call.channel === 'cogseed.task.list').length;
    watchChange?.({ type: 'change' });
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitFor(() => calls.filter((call) => call.channel === 'cogseed.task.list').length > taskListsBeforeRecovery
      && !html.includes('transient dashboard failure'));
    expect(html).toContain('data-run-center-queue-task="cogseed-task-renderer"');

    click({ dashboardArchiveToggle: '' });
    click({ runCenterFilter: 'completed' });
    change('[data-run-center-source-filter]', 'local-cli');
    input('[data-run-center-search]', 'hidden-source-search');
    click({ runCenterView: 'overview' });
    click({ runCenterOverviewSource: 'agent' });
    expect(html).toContain('data-run-center-search placeholder="run_center.search_placeholder"');
    expect(html).toContain('<option value="agent" selected>run_center.source_agent</option>');
    expect(html).toContain('aria-pressed="true" class="run-center-filter is-active" data-run-center-filter="all"');
    expect(html).toContain('data-run-center-archive-scope aria-pressed="false"');
    expect(html).toContain('data-run-center-queue-task="cogseed-task-renderer"');

    click({ dashboardArchiveToggle: '' });
    click({ runCenterFilter: 'completed' });
    change('[data-run-center-source-filter]', 'local-cli');
    input('[data-run-center-search]', 'hidden-agent-search');
    click({ runCenterView: 'overview' });
    click({ runCenterOverviewAgent: 'review-agent' });
    expect(html).toContain('<option value="review-agent" selected>Reviewer</option>');
    expect(html).toContain('value="" data-run-center-search');
    expect(html).toContain('<option value="all" selected>run_center.source_all</option>');
    expect(html).toContain('aria-pressed="true" class="run-center-filter is-active" data-run-center-filter="all"');
    expect(html).toContain('data-run-center-archive-scope aria-pressed="false"');

    click({ runCenterView: 'overview' });
    click({ runCenterOverviewFilter: 'archived' });
    expect(html).toContain('data-run-center-archive-scope aria-pressed="true"');
    expect(html).toContain('data-run-center-queue-task="archived-task"');
    await waitFor(() => html.includes('data-run-center-archive-scope'));

    input('[data-run-center-search]', 'hidden-task-search');
    change('[data-run-center-source-filter]', 'local-cli');
    click({ runCenterFilter: 'pending' });
    click({ runCenterView: 'overview' });
    click({ runCenterOverviewTask: task.taskId, runCenterOverviewSession: task.sessionId });
    await waitFor(() => html.includes('run_center.label_worktree') && html.includes(worktreeName));
    expect(html).toContain('class="run-center-run-detail"');
    expect(html).toContain('is-queue-mode is-detail-open');
    expect(html).toContain('value="" data-run-center-search');
    expect(html).toContain('<option value="all" selected>run_center.source_all</option>');
    expect(html).toContain('aria-pressed="true" class="run-center-filter is-active" data-run-center-filter="all"');
    expect(html).toContain('data-run-center-archive-scope aria-pressed="false"');
    expect(html).toContain(`data-run-center-open="${task.conversationId}"`);
    const detailPanel = html.match(/<main class="run-center-run-detail-pane">([\s\S]*?)<\/main>/)?.[1] || '';
    expect(detailPanel).toContain('Reviewer');
    expect(detailPanel).toContain('Check the provider configuration.');
    for (const rawValue of [task.taskId, task.agentId, task.executionId, task.executionKind, task.runtimeKind, task.errorCode]) {
      expect(detailPanel).not.toContain(rawValue);
    }
    expect(detailPanel).not.toContain('run_center.detail_collaboration');

    task.status = 'failed';
    task.column = 'attention';
    task.actions.abort = false;
    task.actions.archive = true;
    click({ runCenterRefresh: '' });
    await waitFor(() => html.includes('data-run-center-configure-model'));
    let failedSummary = html.match(/<div class="run-center-summary-flow">([\s\S]*?)<\/div>\s*<\/div><\/main>/)?.[1] || '';
    expect(failedSummary).toContain('data-run-center-configure-model');
    expect(failedSummary).not.toContain('data-run-center-action="retry"');
    click({ runCenterConfigureModel: '' });
    expect(context.window.setView).toHaveBeenLastCalledWith('settings');
    expect(context.window.activateSettingsTab).toHaveBeenLastCalledWith('credentials');

    task.errorCode = 'model_preflight';
    click({ runCenterRefresh: '' });
    await waitFor(() => html.includes('data-run-center-configure-model'));
    failedSummary = html.match(/<div class="run-center-summary-flow">([\s\S]*?)<\/div>\s*<\/div><\/main>/)?.[1] || '';
    expect(failedSummary).toContain('data-run-center-configure-model');
    expect(failedSummary).not.toContain('data-run-center-action="retry"');
    expect(failedSummary).toContain('data-run-center-action="archive"');
    click({ runCenterAction: 'archive' });
    await waitFor(() => calls.some((call) => call.channel === 'cogseed.task.action' && call.payload?.action === 'archive'));
    await waitFor(() => !html.includes('data-run-center-queue-task="cogseed-task-renderer"'));
    expect(context.window.confirm).toHaveBeenLastCalledWith('run_center.archive_confirm');
    expect(html).not.toContain('is-queue-mode is-detail-open');
    task.status = 'running';
    task.column = 'running';
    task.actions.abort = true;
    task.errorCode = 'provider_error';
    click({ runCenterRefresh: '' });
    await waitFor(() => html.includes('data-run-center-queue-task="cogseed-task-renderer"'));
    click({ dashboardBoardTaskId: task.taskId, dashboardBoardSessionId: task.sessionId });
    await waitFor(() => html.includes('run_center.user_state_running'));
    click({ dashboardBoardTaskId: task.taskId, dashboardBoardSessionId: task.sessionId });
    expect(html).not.toContain('is-queue-mode is-detail-open');
    click({ dashboardBoardTaskId: task.taskId, dashboardBoardSessionId: task.sessionId });
    await waitFor(() => html.includes('is-queue-mode is-detail-open'));

    documentListeners.get('keydown')?.({ key: 'Escape', target: {} });
    expect(html).not.toContain('is-queue-mode is-detail-open');
    click({ dashboardBoardTaskId: task.taskId, dashboardBoardSessionId: task.sessionId });
    await waitFor(() => html.includes('is-queue-mode is-detail-open'));
    click({ runCenterReassign: '' });
    await waitFor(() => html.includes('run_center.reassign_title'));
    documentState.activeElement = createLast;
    const reassignTrap = vi.fn();
    documentListeners.get('keydown')?.({ key: 'Tab', shiftKey: false, preventDefault: reassignTrap, target: {} });
    expect(reassignTrap).toHaveBeenCalledOnce();
    expect(documentState.activeElement).toBe(createFirst);
    click({ runCenterCreateClose: '' });
    await waitFor(() => focusedControls.at(-1) === 'reassign');

    click({ runCenterView: 'runs' });
    click({ runCenterDetailTab: 'history' });
    const timelineHtml = html.match(/<ol class="run-center-timeline(?: is-compact)?">([\s\S]*?)<\/ol>/)?.[1] || '';
    expect(timelineHtml.match(/<li\b/g)).toHaveLength(3);
    expect(timelineHtml).toContain('run_center.timeline_related_tasks:{&quot;count&quot;:2}');
    expect(timelineHtml.match(/run_center\.timeline_related_tasks/g)).toHaveLength(1);
    expect(timelineHtml).toContain('<small>CogSeed task</small>');
    expect(timelineHtml).not.toContain('provider_error');
    task.status = 'failed';
    task.column = 'attention';
    repeatedSessionMode = true;
    const taskListsBeforeRepeatedRuns = calls.filter((call) => call.channel === 'cogseed.task.list').length;
    click({ runCenterRefresh: '' });
    await waitFor(() => calls.filter((call) => call.channel === 'cogseed.task.list').length > taskListsBeforeRepeatedRuns
      && html.includes('run_center.query_result_count:{&quot;count&quot;:4}'));
    expect(html.match(/data-run-center-queue-run-key="[^"]+"/g)).toHaveLength(4);
    expect(html).toContain('run_center.query_result_count:{&quot;count&quot;:4}');
    expect(html).toContain('run_center.run_sequence:{&quot;index&quot;:1,&quot;count&quot;:4}');
    expect(html).toContain('run_center.run_sequence:{&quot;index&quot;:4,&quot;count&quot;:4}');
    expect(html).not.toContain('data-run-center-detail-tab="collaboration"');

    const delayedReadsBeforeCollaboration = delayedSessionReadCompleted;
    holdNextSessionRead = true;
    const olderRun = repeatedSessionTasks[1];
    click({
      runCenterQueueRunKey: `execution:${olderRun.executionId}`,
      runCenterQueueSession: olderRun.sessionId,
      runCenterQueueTask: olderRun.taskId,
    });
    await waitFor(() => settleSessionRead !== null);
    expect(html).toContain('aria-live="polite" aria-busy="true"');
    const newestRun = repeatedSessionTasks[2];
    click({
      runCenterQueueRunKey: `execution:${newestRun.executionId}`,
      runCenterQueueSession: newestRun.sessionId,
      runCenterQueueTask: newestRun.taskId,
    });
    await waitFor(() => calls.some((call) => call.channel === 'cogseed.session.read'
      && call.payload?.sessionId === task.sessionId
      && call.payload?.taskId === newestRun.taskId));
    const releaseOlderCollaborationSelection = settleSessionRead;
    settleSessionRead = null;
    releaseOlderCollaborationSelection?.();
    await waitFor(() => delayedSessionReadCompleted > delayedReadsBeforeCollaboration);
    expect(html).toMatch(new RegExp(`data-run-center-queue-task="${newestRun.taskId}"[^>]*tabindex="0"`));

    richCollaboration = true;
    click({
      runCenterQueueRunKey: `execution:${task.executionId}`,
      runCenterQueueSession: task.sessionId,
      runCenterQueueTask: task.taskId,
    });
    await waitFor(() => html.includes('data-run-center-detail-tab="collaboration"'));
    click({ runCenterDetailTab: 'collaboration' });
    await waitFor(() => html.includes('run_center.dependencies_count'));
    const collaborationPanel = html.match(/<div class="run-center-detail-content" role="tabpanel">([\s\S]*?)<\/div>\s*<\/div><\/main>/)?.[1] || '';
    const collaborationText = collaborationPanel.replace(/<[^>]+>/g, ' ');
    for (const rawValue of ['actor-private', 'step-private', 'failure-private', 'dependency-private', 'gate-private', 'conflict-private']) {
      expect(collaborationText).not.toContain(rawValue);
    }
    expect(collaborationText).toContain('run_center.dependencies_count:{&quot;count&quot;:1}');
    expect(collaborationText).toContain('run_center.affected_steps_count:{&quot;count&quot;:1}');

    holdCollaborationAction = true;
    click({ runCenterCollaborationAction: 'retry-step', runCenterCollaborationTarget: 'step-private' });
    await waitFor(() => releaseCollaborationAction !== null);
    expect(calls.filter((call) => call.channel === 'cogseed.collaboration.action').at(-1)?.payload).toEqual({
      taskId: task.taskId, action: 'retry-step', targetId: 'step-private',
    });
    const finishCollaborationAction = releaseCollaborationAction;
    releaseCollaborationAction = null;
    finishCollaborationAction?.();
    await waitFor(() => collaborationActionsCompleted === 1 && !html.includes('run_center.action_working'));

    hiddenTaskId = '';
    groupedRunMode = true;
    richCollaboration = false;
    const detailReadsBeforeGroupedRun = calls.filter((call) => call.channel === 'cogseed.session.read').length;
    click({ runCenterRefresh: '' });
    await waitFor(() => (html.match(/data-run-center-queue-run-key="[^"]+"/g) || []).length === 1
      && html.includes(`data-run-center-queue-task="${groupParentTask.taskId}"`)
      && calls.filter((call) => call.channel === 'cogseed.session.read').length > detailReadsBeforeGroupedRun);
    const readsBeforeGroupedClick = calls.filter((call) => call.channel === 'cogseed.session.read').length;
    click({
      runCenterQueueRunKey: `group:${groupParentTask.groupId}`,
      runCenterQueueSession: groupParentTask.sessionId,
      runCenterQueueTask: groupParentTask.taskId,
    });
    await waitFor(() => calls.filter((call) => call.channel === 'cogseed.session.read').length > readsBeforeGroupedClick);
    expect(calls.filter((call) => call.channel === 'cogseed.session.read').at(-1)?.payload).toEqual({
      sessionId: groupParentTask.sessionId, taskId: groupParentTask.taskId,
    });
    expect(html).toContain('<h2>Group parent</h2>');
    expect(html).not.toContain('<h2>Group child</h2>');
    expect(html).toContain('data-run-center-detail-tab="collaboration"');

    click({ runCenterOpen: task.conversationId });
    expect(context.window.setView).toHaveBeenCalledWith('conversation', task.conversationId);
  });

  it('defines all static Run Center labels in Simplified Chinese and English', () => {
    const en = JSON.parse(read('src/renderer/locales/en.json'));
    const zh = JSON.parse(read('src/renderer/locales/zh.json'));
    const source = `${read('src/renderer/modules/run-center.js')}\n${read('src/renderer/modules/run-center-board.js')}\n${read('src/renderer/modules/run-center-overview.js')}\n${read('src/renderer/modules/run-center-agents.js')}`;
    const keys = Array.from(source.matchAll(/['"](run_center\.[a-z_]+)['"]/g), (match) => match[1])
      .filter((key) => !key.endsWith('_'));

    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
    }
    for (const key of [
      'run_center.task_kind_cogseed',
      'run_center.task_kind_local_cli',
      'run_center.task_kind_agent_conversation',
      'run_center.task_kind_group_chat',
      'run_center.task_kind_commander_turn',
      'run_center.task_kind_agent_turn',
      'run_center.task_kind_worker_turn',
      'run_center.workflow_step',
      'run_center.event_task_waiting_user',
      'run_center.event_task_archived',
      'run_center.event_model_delta',
      'run_center.event_artifact',
      'run_center.source_agent-conversation',
      ...[
        'repository_unavailable', 'branch_invalid', 'base_invalid', 'branch_in_use', 'path_invalid',
        'main_repository', 'symlink', 'outside_managed_root', 'not_registered', 'repository_mismatch',
        'branch_mismatch', 'dirty', 'process_active', 'process_unverified', 'create_failed',
        'remove_failed', 'unverified', 'unknown',
      ].map((suffix) => `run_center.worktree_error_${suffix}`),
    ]) {
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
    }
    expect(en['sidebar.run_center']).toBe('Run Center');
    expect(zh['sidebar.run_center']).toBe('运行中心');
  });
});

// SPDX-FileCopyrightText: 2026 CogSeed contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Run Center renderer contract', () => {
  it('keeps the Run Center separate from the Agent Dashboard and lazy-loads it', () => {
    const html = read('src/renderer/index.html');
    const boot = read('src/renderer/modules/boot.js');
    const state = read('src/renderer/modules/state.js');
    const manifest = read('src/renderer/modules/lazy-features.js');

    expect(html).toContain('id="run-center-btn"');
    expect(html).toContain('id="panel-run-center"');
    expect(html).toContain('id="dashboard-btn"');
    expect(boot).toContain("view === 'run-center' ? 'panel-run-center'");
    expect(boot).toContain("_loadViewFeature('run-center', 'run-center'");
    expect(state).toContain("_setViewFromSidebar('run-center')");
    expect(manifest).toContain("'run-center': [");
    expect(manifest).toContain("'./modules/run-center-board.js'");
    expect(manifest).toContain("'./modules/run-center.js'");
    expect(html).not.toContain('<script src="./modules/run-center.js"></script>');
  });

  it('uses the constrained CogSeed projection and action IPC surface', () => {
    const source = read('src/renderer/modules/run-center.js');
    const conversationInfo = read('src/renderer/modules/conversation-info.js');

    expect(source).toContain("invoke('cogseed.task.list')");
    expect(source).toContain("invoke('cogseed.session.list')");
    expect(source).toContain("invoke('cogseed.session.read'");
    expect(source).toContain("invoke('cogseed.task.action'");
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
    const context: any = { window: {}, Object, String, Array, Map, Set };
    context.window.window = context.window;
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/run-center-board.js'), context);

    const board = context.window.CogSeedRunCenterBoard;
    const projection = {
      tasks: [
        { taskId: 'pending', column: 'pending', title: 'Pending' },
        { taskId: 'running', column: 'running', title: 'Running' },
        { taskId: 'archived', column: 'archived', title: 'Archived' },
      ],
    };
    expect(board.filteredTasks(projection, '', 'all').map((task: any) => task.taskId)).toEqual(['pending', 'running']);
    expect(board.filteredTasks(projection, '', 'running').map((task: any) => task.taskId)).toEqual(['running']);
    expect(board.filteredTasks(projection, 'archived', 'all', true).map((task: any) => task.taskId)).toEqual(['archived']);
  });

  it('defines all static Run Center labels in Simplified Chinese and English', () => {
    const en = JSON.parse(read('src/renderer/locales/en.json'));
    const zh = JSON.parse(read('src/renderer/locales/zh.json'));
    const source = `${read('src/renderer/modules/run-center.js')}\n${read('src/renderer/modules/run-center-board.js')}`;
    const keys = Array.from(source.matchAll(/['"](run_center\.[a-z_]+)['"]/g), (match) => match[1])
      .filter((key) => !key.endsWith('_'));

    for (const key of keys) {
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
    }
    for (const key of [
      'run_center.task_kind_cogseed',
      'run_center.task_kind_local_cli',
      'run_center.task_kind_group_chat',
      'run_center.task_kind_commander_turn',
      'run_center.task_kind_agent_turn',
      'run_center.task_kind_worker_turn',
      'run_center.workflow_step',
      'run_center.event_task_waiting_user',
      'run_center.event_model_delta',
      'run_center.event_artifact',
    ]) {
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
    }
    expect(en['sidebar.run_center']).toBe('Run Center');
    expect(zh['sidebar.run_center']).toBe('运行中心');
  });
});

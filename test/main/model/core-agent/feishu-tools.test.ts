import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTool, ToolContext } from '#core-agent';

const mocks = {
  autoTasks: {
    listTasks: vi.fn(),
  },
  touchpointLedger: {
    listTouchpointIntents: vi.fn(),
    listTouchpointActions: vi.fn(),
  },
  application: {
    getDashboard: vi.fn(),
    scheduleBriefing: vi.fn(),
  },
  proactive: {
    sendFileToSelf: vi.fn(),
  },
  workspace: {
    getWorkspacePath: vi.fn(),
  },
};

async function tools() {
  const { createFeishuTools } = await import('../../../../src/main/model/core-agent/feishu-tools');
  return createFeishuTools({ userId: 'user-1' });
}

function ctx(): ToolContext {
  return { state: {} };
}

const DASHBOARD = {
  mode: 'live',
  messaging: { state: 'connected', instance_name: '飞书' },
  authorization: { state: 'authorized' },
  resources: { total: 3 },
  sync: { state: 'idle', last_sync_at: '2026-08-10T01:00:00.000Z' },
  briefing: { state: 'scheduled', destination: { time: '08:00' }, lastDelivery: null, pendingCandidateCount: 0 },
  review: { pending: 0 },
  actions: [],
};

const BRIEFING_TASKS = [
  {
    id: 'at_briefing_1',
    title: '每日飞书简报',
    briefing: true,
    enabled: true,
    recipient: { kind: 'messaging', instanceId: 'inst_1', recipient: 'owner' },
    schedule: { type: 'daily', hour: 8, minute: 0 },
  },
];

const INTENTS = [
  {
    intentId: 'tpi_1', template: 'daily_briefing', content: { title: '今日简报' },
    status: 'sent', updatedAt: '2026-08-10T01:00:00.000Z', requiresAction: true,
  },
];

const ACTIONS = [
  {
    actionId: 'action-1', intentId: 'tpi_1', action: 'adjust', content: '20:30',
    consumedAt: '2026-08-10T01:05:00.000Z',
  },
];

describe('core-agent feishu tools', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../../../src/main/features/auto_tasks', () => mocks.autoTasks);
    vi.doMock('../../../../src/main/features/touchpoints/ledger', () => mocks.touchpointLedger);
    vi.doMock('../../../../src/main/features/personal_context/application', () => mocks.application);
    vi.doMock('../../../../src/main/features/messaging/proactive', () => mocks.proactive);
    vi.doMock('../../../../src/main/features/user_workspace', () => mocks.workspace);
    mocks.autoTasks.listTasks.mockReset();
    mocks.touchpointLedger.listTouchpointIntents.mockReset();
    mocks.touchpointLedger.listTouchpointActions.mockReset();
    mocks.application.getDashboard.mockReset();
    mocks.application.scheduleBriefing.mockReset();
    mocks.proactive.sendFileToSelf.mockReset();
    mocks.workspace.getWorkspacePath.mockReset();
  });

  afterEach(() => {
    vi.doUnmock('../../../../src/main/features/auto_tasks');
    vi.doUnmock('../../../../src/main/features/touchpoints/ledger');
    vi.doUnmock('../../../../src/main/features/personal_context/application');
    vi.doUnmock('../../../../src/main/features/messaging/proactive');
    vi.doUnmock('../../../../src/main/features/user_workspace');
  });

  it('builds exactly the five feishu tools with closed schemas', async () => {
    const [dashboard, briefingGet, briefingSchedule, touchpointList, sendFile] = await tools();
    expect(dashboard.name).toBe('feishu_dashboard');
    expect(briefingGet.name).toBe('briefing_get');
    expect(briefingSchedule.name).toBe('briefing_schedule');
    expect(touchpointList.name).toBe('touchpoint_list');
    expect(sendFile.name).toBe('messaging_send_file');
    for (const tool of [dashboard, briefingGet, touchpointList, sendFile]) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    expect(briefingSchedule.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['hour', 'minute'],
    });
    expect(sendFile.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
    });
    // No credentials, ids, or secret-shaped fields leak into schemas.
    expect(JSON.stringify(briefingSchedule.inputSchema)).not.toMatch(/chat_id|open_id|secret|token|app_id/i);
  });

  it('feishu_dashboard returns the sanitized companion summary', async () => {
    mocks.application.getDashboard.mockResolvedValue(DASHBOARD);
    const [dashboard] = await tools();

    const result = await dashboard.execute({}, ctx());
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(String(result.content)) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      mode: 'live',
      messaging: { state: 'connected' },
      briefing: { state: 'scheduled' },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/secret|token|app_id/i);
  });

  it('briefing_get lists scheduled briefing tasks with readable times', async () => {
    mocks.autoTasks.listTasks.mockResolvedValue(BRIEFING_TASKS);
    const [, briefingGet] = await tools();

    const result = await briefingGet.execute({}, ctx());
    const parsed = JSON.parse(String(result.content)) as { briefing_tasks: Array<Record<string, unknown>> };
    expect(parsed.briefing_tasks[0]).toMatchObject({ schedule: 'daily', time: '08:00', enabled: true });
  });

  it('briefing_schedule forwards validated hour/minute and returns the new config', async () => {
    mocks.application.scheduleBriefing.mockResolvedValue({ dashboard: DASHBOARD, taskId: 'at_briefing_1' });
    const [, , briefingSchedule] = await tools();

    const result = await briefingSchedule.execute({ hour: 20, minute: 30 }, ctx());
    expect(mocks.application.scheduleBriefing).toHaveBeenCalledWith('user-1', { hour: 20, minute: 30 });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(result.content))).toMatchObject({ ok: true, task_id: 'at_briefing_1' });
  });

  it('briefing_schedule rejects out-of-range or non-integer times', async () => {
    const [, , briefingSchedule] = await tools();

    await expect(briefingSchedule.execute({ hour: 24, minute: 0 }, ctx())).resolves.toMatchObject({ isError: true });
    await expect(briefingSchedule.execute({ hour: 8, minute: 60 }, ctx())).resolves.toMatchObject({ isError: true });
    await expect(briefingSchedule.execute({ hour: 8.5, minute: 0 }, ctx())).resolves.toMatchObject({ isError: true });
    expect(mocks.application.scheduleBriefing).not.toHaveBeenCalled();
  });

  it('touchpoint_list returns recent intents and recorded actions', async () => {
    mocks.touchpointLedger.listTouchpointIntents.mockResolvedValue(INTENTS);
    mocks.touchpointLedger.listTouchpointActions.mockResolvedValue(ACTIONS);
    const [, , , touchpointList] = await tools();

    const result = await touchpointList.execute({ limit: 5 }, ctx());
    const parsed = JSON.parse(String(result.content)) as { intents: unknown[]; actions: unknown[] };
    expect(parsed.intents).toHaveLength(1);
    expect(parsed.intents[0]).toMatchObject({ intent_id: 'tpi_1', template: 'daily_briefing', status: 'sent' });
    expect(parsed.actions[0]).toMatchObject({ action: 'adjust', content: '20:30' });
  });

  it('maps feature errors to tool errors without crashing', async () => {
    mocks.application.getDashboard.mockRejectedValue(new Error('provider down'));
    const [dashboard] = await tools();

    const result = await dashboard.execute({}, ctx());
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('E_FEISHU_DASHBOARD_UNAVAILABLE');
  });

  it('messaging_send_file forwards scoped paths to the proactive file send', async () => {
    mocks.workspace.getWorkspacePath.mockReturnValue('/workspace');
    mocks.proactive.sendFileToSelf.mockResolvedValue({
      status: 'sent',
      instance_id: 'bot-1',
      text_length: 10,
      attempts: 1,
      delivery_id: 'om_file_1',
    });
    const [, , , , sendFile] = await tools();

    const result = await sendFile.execute({ file_path: '/workspace/report.pdf', file_name: '报告.pdf' }, ctx());

    expect(mocks.proactive.sendFileToSelf).toHaveBeenCalledWith(
      'user-1',
      { file_path: '/workspace/report.pdf', file_name: '报告.pdf' },
      expect.objectContaining({ cid: 'turn', sourceKey: expect.stringMatching(/^file:/) }),
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(String(result.content))).toMatchObject({ status: 'sent' });
  });

  it('messaging_send_file rejects paths outside the workspace/attachment scope', async () => {
    mocks.workspace.getWorkspacePath.mockReturnValue('/workspace');
    const [, , , , sendFile] = await tools();

    const result = await sendFile.execute({ file_path: '/etc/passwd' }, ctx());

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(mocks.proactive.sendFileToSelf).not.toHaveBeenCalled();
  });

  it('messaging_send_file requires an absolute file_path up front', async () => {
    mocks.workspace.getWorkspacePath.mockReturnValue('/workspace');
    const [, , , , sendFile] = await tools();

    const result = await sendFile.execute({ file_path: 'relative.md' }, ctx());

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(mocks.proactive.sendFileToSelf).not.toHaveBeenCalled();
  });
});

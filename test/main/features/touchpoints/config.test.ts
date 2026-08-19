import { describe, expect, it } from 'vitest';
import {
  applyTouchpointTemplate,
  resolveTouchpointInstanceId,
  saveTouchpointConfig,
} from '../../../../src/main/features/touchpoints/config';
import type { TouchpointIntent } from '../../../../src/main/features/touchpoints/types';

function intent(): TouchpointIntent {
  return {
    version: 1,
    intentId: 'tpi_config_test',
    userId: 'config_test_user',
    eventId: 'evt_config_test',
    subject: { type: 'research_agent', id: 'task-1' },
    content: { title: '比较三种传感器', body: '读取项目资料并输出结论' },
    contextRef: 'project-files',
    channel: 'feishu',
    template: 'task_approval',
    priority: 'high',
    availableFrom: '2026-08-13T00:00:00.000Z',
    expiresAt: '2026-08-14T00:00:00.000Z',
    dedupeKey: 'config-test',
    requiresAction: true,
    actionContract: { version: 1, allowedActions: ['approve', 'reject'] },
    status: 'planned',
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    attempts: 0,
  };
}

describe('touchpoint template and routing', () => {
  it('uses the configured safe template labels without changing action kinds', async () => {
    const result = await applyTouchpointTemplate('config_test_user', intent());
    expect(result.content.title).toContain('请求你确认任务');
    expect(result.actionContract?.allowedActions).toEqual(['approve', 'reject']);
  });

  it('does not resolve an invalid route id', async () => {
    expect(await resolveTouchpointInstanceId('config_test_user', 'task_approval', '../other-user')).toBeUndefined();
  });

  it('persists and resolves the general proactive-send route separately from templates', async () => {
    await saveTouchpointConfig('config_test_user', {
      version: 1,
      defaultInstanceId: 'bot-default',
      templates: {},
      routes: { external_send: 'wechat-primary' },
    }, [
      { id: 'bot-default', platform: 'feishu_lark' },
      { id: 'wechat-primary', platform: 'wechat_personal' },
    ]);

    expect(await resolveTouchpointInstanceId('config_test_user', 'external_send')).toBe('wechat-primary');
    expect(await resolveTouchpointInstanceId('config_test_user', 'task_approval')).toBe('bot-default');
  });

  it('rejects a personal WeChat default when Feishu-only scenes have no override', async () => {
    await expect(saveTouchpointConfig('config_test_user', {
      version: 1,
      defaultInstanceId: 'wechat-primary',
      templates: {},
      routes: { external_send: null },
    }, [
      { id: 'bot-approval', platform: 'feishu_lark' },
      { id: 'wechat-primary', platform: 'wechat_personal' },
    ])).rejects.toMatchObject({
      name: 'TouchpointConfigError',
      field: 'routes.task_approval',
    });
  });

  it('accepts a personal WeChat default when Feishu-only scenes are routed explicitly', async () => {
    await expect(saveTouchpointConfig('config_test_user', {
      version: 1,
      defaultInstanceId: 'wechat-primary',
      templates: {},
      routes: {
        task_approval: 'bot-approval',
        daily_briefing: 'bot-briefing',
      },
    }, [
      { id: 'bot-approval', platform: 'feishu_lark' },
      { id: 'bot-briefing', platform: 'feishu_lark' },
      { id: 'wechat-primary', platform: 'wechat_personal' },
    ])).resolves.toMatchObject({
      defaultInstanceId: 'wechat-primary',
      routes: {
        task_approval: 'bot-approval',
        daily_briefing: 'bot-briefing',
      },
    });
  });
});

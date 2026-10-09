/**
 * 简报触达点动作处理器：把卡片回执落地为业务效果。
 *
 * - snooze（稍后提醒）：30 分钟后创建一个一次性简报任务，重新投递今日简报；
 * - adjust（调整）：回执 content 携带新时间（HH:mm），更新每日简报的调度时间。
 *
 * 注册挂在 feishu-dispatch 模块的加载链上（auto_tasks 与 application 都依赖
 * 它），应用启动即生效；处理函数内部才触碰 auto_tasks，避免加载期循环。
 */
import { createLogger } from '../../logger';
import { registerTouchpointActionHandler } from '../touchpoints/actions';
import type { TouchpointActionRecord } from '../touchpoints/types';
import { listTasks, createTask, updateTask } from '../auto_tasks';

const log = createLogger('personal-context:briefing-actions');

/** 稍后提醒的延迟窗口（毫秒）。 */
export const BRIEFING_SNOOZE_DELAY_MS = 30 * 60 * 1000;

/** 调整动作接受 HH:mm（0-23 时 0-59 分）。 */
const BRIEFING_TIME_RE = /^(\d{1,2}):(\d{2})$/;

function findDailyBriefingTask(tasks: Array<{ id: string; briefing?: boolean; schedule: { type: string; hour?: number; minute?: number } }>)
  : { id: string; schedule: { type: string; hour?: number; minute?: number } } | null {
  return tasks.find((task) => task.briefing === true && task.schedule.type === 'daily') || null;
}

/** snooze：沿用现有每日简报的接收实例，30 分钟后一次性重投（fire 走简报
 * 触达点投递，幂等键是新任务 id + 触发日，不与原任务冲突）。 */
async function handleBriefingSnooze(uid: string, record: TouchpointActionRecord): Promise<void> {
  const tasks = await listTasks(uid);
  const existing = findDailyBriefingTask(tasks);
  if (!existing) {
    log.warn('briefing snooze skipped: no daily briefing task', { userId: uid, intentId: record.intentId });
    return;
  }
  const target = tasks.find((task) => task.id === existing.id) as
    | { recipient?: { kind: string; instanceId?: string } }
    | undefined;
  const instanceId = target?.recipient?.kind === 'messaging' ? target.recipient.instanceId : undefined;
  if (!instanceId) {
    log.warn('briefing snooze skipped: messaging recipient missing', { userId: uid, intentId: record.intentId });
    return;
  }
  const created = await createTask(uid, {
    title: '简报稍后提醒',
    content: '30 分钟后重新投递今日简报',
    briefing: true,
    enabled: true,
    recipient: { kind: 'messaging', instanceId, recipient: 'owner' },
    schedule: { type: 'one_time', at: new Date(Date.now() + BRIEFING_SNOOZE_DELAY_MS).toISOString() },
  });
  if ('error' in created) {
    log.warn('briefing snooze task create failed', { userId: uid, error: created.error });
    return;
  }
  log.info('briefing snooze scheduled', { userId: uid, taskId: created.task.id, instanceId });
}

/** adjust：content 为 HH:mm → 更新每日简报任务的调度时间；解析失败只记录，
 * 不改调度（终态卡片已回显用户输入，用户可见原话）。 */
async function handleBriefingAdjust(uid: string, record: TouchpointActionRecord): Promise<void> {
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  const match = BRIEFING_TIME_RE.exec(content);
  if (!match) {
    log.warn('briefing adjust skipped: time not recognized', {
      userId: uid,
      intentId: record.intentId,
      content: content.slice(0, 40),
    });
    return;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    log.warn('briefing adjust skipped: time out of range', { userId: uid, content });
    return;
  }
  const tasks = await listTasks(uid);
  const existing = findDailyBriefingTask(tasks);
  if (!existing) {
    log.warn('briefing adjust skipped: no daily briefing task', { userId: uid, intentId: record.intentId });
    return;
  }
  const updated = await updateTask(uid, existing.id, {
    schedule: { type: 'daily', hour, minute },
  });
  if ('error' in updated) {
    log.warn('briefing adjust update failed', { userId: uid, error: updated.error });
    return;
  }
  log.info('briefing schedule adjusted', { userId: uid, taskId: existing.id, hour, minute });
}

let installed = false;

/** 注册简报动作处理器。幂等；挂在 feishu-dispatch 加载链上。 */
export function installBriefingActionHandlers(): void {
  if (installed) return;
  installed = true;
  registerTouchpointActionHandler('snooze', handleBriefingSnooze);
  registerTouchpointActionHandler('adjust', handleBriefingAdjust);
  log.info('briefing touchpoint action handlers installed (snooze/adjust)');
}

installBriefingActionHandlers();

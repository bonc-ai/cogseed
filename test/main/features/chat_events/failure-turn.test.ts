// 复现真机故障：模型调用失败（重试耗尽 → stream error 事件）后，
// chat-stream 面板仍显示"工作中"、计时器和 loading 圈不停。
//
// 失败序列（来自 2026-09-08 11:27 真机日志）：
//   process(turn_id=T1, {type:'progress'})   → turn.started + reasoning
//   process(turn_id=T1, {type:'error',...})  → bus 捕获 errText，**继续转发 process 事件**（data.type='error'）
//   message(turn_end=true, turn_id=T1)       → 投影器补终态 'completed'（失败被伪装成完成）
//
// 断言：
//   1. error 后渲染层能拿到终态（turn.completed 事件存在）；
//   2. 终态 status 必须反映失败（failed），否则徽章显示"已工作"误导用户；
//   3. error 事件的 process 转发是否被投影器消费（当前 projectUpstreamEvent
//      有 error 分支——若 bus 真的转发了，为何真机面板不停？）。
import { describe, expect, it } from 'vitest';
import { GroupEventChatProjector } from '../../../../src/main/features/chat_events/project-group-event';

function processEvent(actor: string, turnId: string | undefined, data: Record<string, unknown>): any {
  return { type: 'process', cid: 'c-1', actor, turn_id: turnId, data };
}

describe('GroupEventChatProjector › 失败回合终态（真机 2026-09-08 复现）', () => {
  it('error + turn_end 序列产出 failed 终态', () => {
    const projector = new GroupEventChatProjector();
    // 模型开始思考
    const start = projector.project(processEvent('commander', 'T1', { type: 'progress', text: '思考中' }));
    expect(start.some((e) => e.type === 'chat.turn.started')).toBe(true);

    // bus 在 ev.type==='error' 分支捕获 errText（不转发），但 runWorkerLoop
    // 结束后 message(turn_end) 一定到达。先验证 error 被转发的形态（如果 bus
    // 会转发的话）：
    const errForwarded = projector.project(processEvent('commander', 'T1', { type: 'error', text: 'Connection error.' }));
    // error StreamEvent 应投影出 turn.completed(failed)
    const failed = errForwarded.filter((e) => e.type === 'chat.turn.completed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: 'failed', error: 'Connection error.' });

    // turn_end 到达时 completedSent 已置位 → 不再重复发终态
    const endMsg: any = {
      type: 'message', cid: 'c-1', turn_end: true, turn_id: 'T1',
      msg: { from: 'commander', text: 'done' },
    };
    expect(projector.project(endMsg)).toEqual([]);
  });

  it('error 未转发（bus 吞掉）、仅 turn_end 到达 → 终态应为 failed 而非 completed', () => {
    const projector = new GroupEventChatProjector();
    projector.project(processEvent('commander', 'T1', { type: 'progress', text: '思考中' }));
    // 真实 bus：error 事件被捕获不转发，只有 message(turn_end) 到达，
    // 且消息带 failure_kind（GroupMessage.failure_kind = 'model'）。
    const endMsg: any = {
      type: 'message', cid: 'c-1', turn_end: true, turn_id: 'T1',
      msg: { from: 'commander', text: 'Connection error.', failure_kind: 'model' },
    };
    const out = projector.project(endMsg);
    const completed = out.filter((e) => e.type === 'chat.turn.completed');
    expect(completed).toHaveLength(1);
    // 核心断言：failure_kind 存在时终态必须 failed，不能伪装 completed
    expect(completed[0].status).toBe('failed');
  });
});

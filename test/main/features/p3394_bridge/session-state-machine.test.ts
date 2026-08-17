import { describe, expect, it } from 'vitest';
import { P3394BridgeSessionManager } from '../../../../src/main/features/p3394_bridge/session-manager';
import { P3394BridgeTaskManager } from '../../../../src/main/features/p3394_bridge/task-manager';

describe('P3394 session state machine (SDK design §7.1)', () => {
  it('follows negotiating -> active -> waiting -> active -> closing -> closed', () => {
    const sessions = new P3394BridgeSessionManager(() => 'now');
    const s = sessions.open({ session_id: 's1', goal: 'g', agent_id: 'a' });
    expect(s.state).toBe('negotiating');
    expect(s.epoch).toBe(1);
    expect(s.participants).toEqual(['a']);

    sessions.accept('s1');
    expect(sessions.require('s1').state).toBe('active');
    expect(sessions.require('s1').activated_at).toBe('now');

    sessions.toWaiting('s1');
    expect(sessions.require('s1').state).toBe('waiting');
    sessions.activate('s1');
    expect(sessions.require('s1').state).toBe('active');

    sessions.beginClose('s1');
    expect(sessions.require('s1').state).toBe('closing');
    sessions.close('s1');
    expect(sessions.require('s1').state).toBe('closed');
    expect(sessions.require('s1').closed_at).toBe('now');
  });

  it('rejects illegal transitions and refuses to close an un-negotiated session', () => {
    const sessions = new P3394BridgeSessionManager(() => 'now');
    sessions.open({ session_id: 's1', goal: 'g', agent_id: 'a' });
    expect(() => sessions.close('s1')).toThrow('p3394_session_not_negotiated');
    expect(() => sessions.toWaiting('s1')).toThrow('p3394_session_transition_negotiating_to_waiting');
    sessions.accept('s1');
    sessions.suspend('s1');
    expect(sessions.require('s1').state).toBe('suspended');
    sessions.activate('s1');
    expect(sessions.require('s1').state).toBe('active');
    sessions.close('s1');
    expect(() => sessions.activate('s1')).toThrow('p3394_session_terminal');
  });

  it('tracks participants, epochs and optimistic versions (§7.2)', () => {
    const sessions = new P3394BridgeSessionManager(() => 'now');
    sessions.open({ session_id: 's1', goal: 'g', agent_id: 'a' });
    const v0 = sessions.require('s1').version;
    sessions.addParticipant('s1', 'b');
    sessions.addParticipant('s1', 'b'); // idempotent
    expect(sessions.require('s1').participants).toEqual(['a', 'b']);
    sessions.bumpEpoch('s1');
    expect(sessions.require('s1').epoch).toBe(2);
    expect(sessions.require('s1').version).toBeGreaterThan(v0);
  });
});

describe('P3394 task state machine (SDK design §7.1)', () => {
  it('follows submitted -> working -> input-required -> working -> completed', () => {
    const tasks = new P3394BridgeTaskManager(() => 'now');
    tasks.submit({ task_id: 't1', session_id: 's1', message_id: 'm1' });
    expect(tasks.require('t1').state).toBe('submitted');
    tasks.start('t1');
    expect(tasks.require('t1').state).toBe('working');
    tasks.awaitInput('t1');
    expect(tasks.require('t1').state).toBe('input-required');
    tasks.start('t1');
    expect(tasks.require('t1').state).toBe('working');
    tasks.settle('t1', 'completed');
    expect(tasks.require('t1').state).toBe('completed');
  });

  it('rejects illegal transitions and keeps terminal settlement idempotent', () => {
    const tasks = new P3394BridgeTaskManager(() => 'now');
    tasks.submit({ task_id: 't1', session_id: 's1', message_id: 'm1' });
    expect(() => tasks.awaitInput('t1')).toThrow('p3394_task_transition_submitted_to_input-required');
    tasks.start('t1');
    tasks.settle('t1', 'failed');
    expect(() => tasks.settle('t1', 'working')).toThrow('p3394_task_transition_failed_to_working');
    expect(() => tasks.settle('t1', 'completed')).toThrow('p3394_task_transition_failed_to_completed');
    expect(tasks.settle('t1', 'failed').state).toBe('failed'); // idempotent terminal
  });

  it('supports parallel tasks in one session', () => {
    const tasks = new P3394BridgeTaskManager(() => 'now');
    tasks.submit({ task_id: 't1', session_id: 's1', message_id: 'm1' });
    tasks.submit({ task_id: 't2', session_id: 's1', message_id: 'm2' });
    tasks.start('t1'); tasks.start('t2');
    expect(tasks.get('t1')?.state).toBe('working');
    expect(tasks.get('t2')?.state).toBe('working');
    tasks.settle('t1', 'completed');
    expect(tasks.get('t1')?.state).toBe('completed');
    expect(tasks.get('t2')?.state).toBe('working');
  });
});

describe('P3394 session durability (SDK design §6/§7)', () => {
  it('persists the six-state machine and restores it in a new instance', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-sess-'));
    const fileFor = (id: string) => path.join(dir, id + '.json');
    try {
      const first = new P3394BridgeSessionManager(() => 'now', { filePathFor: fileFor });
      first.open({ session_id: 's-durable', goal: 'goal-x', agent_id: 'cogseed' });
      first.accept('s-durable');
      first.addParticipant('s-durable', 'hermes');
      first.attachTask('s-durable', 'tsk-1');
      first.toWaiting('s-durable');
      // 文件已落盘
      expect(fs.existsSync(fileFor('s-durable'))).toBe(true);

      // 新实例（模拟重启）→ open 恢复同一状态
      const second = new P3394BridgeSessionManager(() => 'later', { filePathFor: fileFor });
      const restored = second.open({ session_id: 's-durable', goal: 'ignored', agent_id: 'cogseed' });
      expect(restored.state).toBe('waiting');
      expect(restored.goal).toBe('goal-x');
      expect(restored.participants).toEqual(['cogseed', 'hermes']);
      expect(restored.task_ids).toEqual(['tsk-1']);
      expect(restored.epoch).toBe(1);
      expect(restored.version).toBeGreaterThan(1);
      // 恢复后继续走状态机
      second.activate('s-durable');
      second.beginClose('s-durable');
      second.close('s-durable');
      expect(second.require('s-durable').state).toBe('closed');
      expect(second.require('s-durable').closed_at).toBe('later');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores corrupt session files (in-memory fallback, no crash)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-sess-'));
    const fileFor = (id: string) => path.join(dir, id + '.json');
    try {
      fs.writeFileSync(fileFor('s-corrupt'), '{ not json');
      const manager = new P3394BridgeSessionManager(() => 'now', { filePathFor: fileFor });
      const session = manager.open({ session_id: 's-corrupt', goal: 'g', agent_id: 'a' });
      expect(session.state).toBe('negotiating');
      // 恢复后的正常写入覆盖损坏文件
      expect(() => JSON.parse(fs.readFileSync(fileFor('s-corrupt'), 'utf8'))).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays in-memory when no filePathFor is wired (backward compatible)', () => {
    const manager = new P3394BridgeSessionManager(() => 'now');
    const session = manager.open({ session_id: 's-mem', goal: 'g', agent_id: 'a' });
    manager.accept('s-mem');
    expect(session.state).toBe('active');
  });
});

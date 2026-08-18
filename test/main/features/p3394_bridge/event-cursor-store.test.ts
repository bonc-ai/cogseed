/**
 * 事件游标存储测试：单调前进、损坏/错误 schema 容错、持久化往返。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// 游标文件落在 per-variant 数据根（runtime-paths），测试用独立 scratch
// variant，绝不触碰真实 cogseed 变体的状态。
const SCRATCH_VARIANT = 'p3394-cursor-test-' + Math.random().toString(36).slice(2, 8);
process.env.ORKAS_RUNTIME_VARIANT = SCRATCH_VARIANT;

afterEach(() => {
  const root = path.join(os.homedir(), '.cogseed', 'runtime-variants', SCRATCH_VARIANT);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('P3394 event cursor store (R-06/S-05)', () => {
  it('records monotonically and persists/restores a roundtrip', async () => {
    const { loadP3394EventCursors, persistP3394EventCursors, recordP3394EventCursor } = await import('../../../../src/main/features/p3394_bridge/event-cursor-store');
    const cursors = new Map<string, number>();
    recordP3394EventCursor(cursors, 'tsk-a', 1);
    recordP3394EventCursor(cursors, 'tsk-a', 3);
    recordP3394EventCursor(cursors, 'tsk-a', 2); // 不后退
    recordP3394EventCursor(cursors, 'tsk-b', 5);
    expect(cursors.get('tsk-a')).toBe(3);
    expect(cursors.get('tsk-b')).toBe(5);
    persistP3394EventCursors(cursors);

    const restored = loadP3394EventCursors();
    expect(restored.get('tsk-a')).toBe(3);
    expect(restored.get('tsk-b')).toBe(5);
  });

  it('tolerates a missing, corrupt, or wrong-schema cursor file', async () => {
    const { loadP3394EventCursors, p3394EventCursorFile } = await import('../../../../src/main/features/p3394_bridge/event-cursor-store');
    expect(loadP3394EventCursors().size).toBe(0);

    fs.mkdirSync(path.dirname(p3394EventCursorFile()), { recursive: true });
    fs.writeFileSync(p3394EventCursorFile(), '{not-json');
    expect(loadP3394EventCursors().size).toBe(0);

    fs.writeFileSync(p3394EventCursorFile(), JSON.stringify({ schema_version: 2, cursors: { 'tsk-x': 9 } }));
    expect(loadP3394EventCursors().size).toBe(0);

    fs.writeFileSync(p3394EventCursorFile(), JSON.stringify({ schema_version: 1, cursors: { 'tsk-ok': 7, 'tsk-bad': 'x', 'tsk-neg': -1 } }));
    const loaded = loadP3394EventCursors();
    expect(loaded.get('tsk-ok')).toBe(7);
    expect(loaded.has('tsk-bad')).toBe(false);
    expect(loaded.has('tsk-neg')).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prev: string | undefined;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-signal-'));
  prev = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prev;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Commander closure signal (model-judged continuation)', () => {
  it('parses a new_task closure signal from the reply', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const parsed = (bus as any).parseCommanderClosureSignal('Done.\n<kstar-closure>{"new_task":true,"reason":"user moved to a different request"}</kstar-closure>');
    expect(parsed).toEqual({ newTask: true, reason: 'user moved to a different request' });
    expect((bus as any).parseCommanderClosureSignal('No marker here')).toBeNull();
    expect((bus as any).parseCommanderClosureSignal('x<kstar-closure>{"new_task":false}</kstar-closure>')).toEqual({ newTask: false });
    expect((bus as any).parseCommanderClosureSignal('x<kstar-closure>bad json</kstar-closure>')).toBeNull();
  });
});

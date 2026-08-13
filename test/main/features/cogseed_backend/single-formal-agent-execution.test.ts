import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const originalNodeEnv = process.env.NODE_ENV;
const originalWakeGate = process.env.ORKAS_P3394_WAKE_GATE;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  if (originalWakeGate === undefined) delete process.env.ORKAS_P3394_WAKE_GATE;
  else process.env.ORKAS_P3394_WAKE_GATE = originalWakeGate;
});

describe('single formal Agent execution boundary', () => {
  it('fixes the production formal Agent provider to CogSeed Backend', async () => {
    const boundary = await import('../../../../src/main/features/p3394/execution-boundary');
    expect(boundary.FORMAL_AGENT_EXECUTION_BOUNDARY).toEqual({ mode: 'real', provider: 'cogseed-backend' });

    process.env.NODE_ENV = 'production';
    process.env.ORKAS_P3394_WAKE_GATE = '0';
    expect(boundary.allowLegacyGroupChatFormalAgentExecutorForTest()).toBe(false);

    process.env.NODE_ENV = 'test';
    expect(boundary.allowLegacyGroupChatFormalAgentExecutorForTest()).toBe(true);
  });

  it('keeps the environment bypass out of Group Chat production routing and preserves only anonymous worker execution', () => {
    const bus = fs.readFileSync(path.resolve(process.cwd(), 'src/main/features/group_chat/bus.ts'), 'utf8');
    expect(bus).not.toContain('process.env.ORKAS_P3394_WAKE_GATE');
    expect(bus).toContain('allowLegacyGroupChatFormalAgentExecutorForTest()');
    expect(bus).toContain('const workerActor: Actor = {');
    expect(bus).toContain('kind: "worker"');
    expect(bus).toContain('runNestedDispatch(');
  });

  it('keeps formal wake approval and Local CLI dispatch owned by Backend adapters', () => {
    const wake = fs.readFileSync(path.resolve(process.cwd(), 'src/main/features/p3394/wake-controller.ts'), 'utf8');
    const backendDispatcher = fs.readFileSync(path.resolve(process.cwd(), 'src/main/features/cogseed_backend/p3394-wake-dispatcher.ts'), 'utf8');
    const cliAdapter = fs.readFileSync(path.resolve(process.cwd(), 'src/main/features/cogseed_backend/local-cli-execution-adapter.ts'), 'utf8');
    expect(wake).toContain("import('../cogseed_backend/p3394-wake-dispatcher')");
    expect(backendDispatcher).toContain('runtime.startMateTask');
    expect(cliAdapter).toContain("run as runLocalAgent");
    expect(cliAdapter).not.toMatch(/\bspawn\s*\(/);
  });
});

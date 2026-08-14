import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../../src/main');
const mateFiles = [
  path.join(ROOT, 'features/cogseed_backend/office-adapter.ts'),
  path.join(ROOT, 'features/cogseed_backend/browser-manager.ts'),
  path.join(ROOT, 'features/cogseed_backend/coordinator.ts'),
  path.join(ROOT, 'features/cogseed_backend/host-tool-router.ts'),
];
const runtimeEntryFiles = [
  path.join(ROOT, 'features/cogseed_backend/host-tool-router.ts'),
  path.join(ROOT, 'features/cogseed_backend/ipc-service.ts'),
  path.join(ROOT, 'features/cogseed_backend/mate-control-service.ts'),
  path.join(ROOT, 'features/cogseed_backend/p3394-wake-dispatcher.ts'),
];

const { runtimeControllerLoadCount, runtimeControllerMock } = vi.hoisted(() => ({
  runtimeControllerLoadCount: { value: 0 },
  runtimeControllerMock: {
    startMateTask: vi.fn(async () => ({ taskId: 'mate-task-lazy', status: 'running' })),
    cancelMateTask: vi.fn(async () => ({ taskId: 'mate-task-lazy', status: 'cancelled' })),
    retryMateTask: vi.fn(async () => ({ taskId: 'mate-task-lazy', status: 'running' })),
    resumeMateTask: vi.fn(async () => ({ taskId: 'mate-task-lazy', status: 'running' })),
    runtimeStatus: vi.fn(async () => ({ backend: 'mate', activeTaskCount: 0, activeTaskIds: [] })),
    restartRuntime: vi.fn(async () => ({ restarted: true })),
  },
}));

vi.mock('../../../../src/main/features/cogseed_backend/runtime-controller', () => {
  runtimeControllerLoadCount.value += 1;
  return {
    mateRuntimeController: runtimeControllerMock,
    createMateRuntimeController: vi.fn(() => runtimeControllerMock),
  };
});

describe('CogSeed host capability boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    runtimeControllerLoadCount.value = 0;
  });

  it('does not import Orkas Core Office, local tools, or Group Chat business modules', () => {
    const source = mateFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/model\/core-agent\/(?:office-tools|local-tools|tool-catalog)/);
    expect(source).not.toMatch(/features\/group_chat/);
    expect(source).not.toMatch(/playwright|puppeteer/i);
  });

  it('keeps Runtime worker spawn in the approved choke point', () => {
    const runtimeDir = path.join(ROOT, 'features/cogseed_runtime');
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(runtimeDir)) {
      if (!entry.endsWith('.ts') || entry === 'worker-process.ts') continue;
      if (/\bspawn\s*\(/.test(fs.readFileSync(path.join(runtimeDir, entry), 'utf8'))) offenders.push(entry);
    }
    expect(offenders).toEqual([]);
  });

  it('does not statically import the CogSeed runtime controller from host capability entrypoints', () => {
    for (const file of runtimeEntryFiles) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, path.relative(ROOT, file)).not.toMatch(/import\s+\{[^}]*\bmateRuntimeController\b/);
    }
  });

  it('imports host capability entrypoints without initializing the CogSeed runtime controller singleton', async () => {
    await import('../../../../src/main/features/cogseed_backend/host-tool-router');
    await import('../../../../src/main/features/cogseed_backend/ipc-service');
    await import('../../../../src/main/features/cogseed_backend/mate-control-service');
    await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');

    expect(runtimeControllerLoadCount.value).toBe(0);
  });


  it('imports coordinator without initializing the CogSeed runtime controller singleton', async () => {
    await import('../../../../src/main/features/cogseed_backend/coordinator');
    expect(runtimeControllerLoadCount.value).toBe(0);
  });


  it('imports mate-control-service without initializing the CogSeed runtime controller singleton', async () => {
    await import('../../../../src/main/features/cogseed_backend/mate-control-service');
    expect(runtimeControllerLoadCount.value).toBe(0);
  });

  it('imports p3394-wake-dispatcher without initializing the CogSeed runtime controller singleton', async () => {
    await import('../../../../src/main/features/cogseed_backend/p3394-wake-dispatcher');
    expect(runtimeControllerLoadCount.value).toBe(0);
  });

  it('resolves the default IPC runtime controller lazily at first controller-backed method call', async () => {
    const { createMateIpcService } = await import('../../../../src/main/features/cogseed_backend/ipc-service');
    const service = createMateIpcService();

    expect(runtimeControllerLoadCount.value).toBe(0);
    await expect(service.runtimeStatus('ipc-user')).resolves.toEqual({ backend: 'mate', activeTaskCount: 0, activeTaskIds: [] });

    expect(runtimeControllerLoadCount.value).toBe(1);
    expect(runtimeControllerMock.runtimeStatus).toHaveBeenCalledTimes(1);
  });
});

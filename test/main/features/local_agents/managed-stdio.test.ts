import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

const processMocks = vi.hoisted(() => ({
  children: [] as FakeChild[],
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('../../../../src/main/features/local_agents/backends/base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/local_agents/backends/base')>();
  return {
    ...actual,
    spawnCli: processMocks.spawnCli,
    killProcessTree: processMocks.killProcessTree,
  };
});

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

async function loadStartManagedStdioProcess() {
  const module = await import('../../../../src/main/features/local_agents/runner');
  return module.startManagedStdioProcess;
}

function absoluteExecutable(): string {
  return process.platform === 'win32' ? 'C:\\tools\\bridge.exe' : '/tools/bridge';
}

function absoluteWorkingDirectory(): string {
  return process.platform === 'win32' ? 'C:\\workspace' : '/workspace';
}

beforeEach(() => {
  processMocks.children.length = 0;
  processMocks.spawnCli.mockReset();
  processMocks.killProcessTree.mockReset();
  processMocks.spawnCli.mockImplementation(() => {
    const child = createFakeChild();
    processMocks.children.push(child);
    return child;
  });
});

describe('managed stdio line limits', () => {
  it('uses the 1 MiB default and rejects one byte over before stdin.write', async () => {
    const startManagedStdioProcess = await loadStartManagedStdioProcess();
    const managed = startManagedStdioProcess({
      command: absoluteExecutable(),
      args: [],
      cwd: absoluteWorkingDirectory(),
    });
    const child = processMocks.children[0];
    child.stdin.resume();
    const write = vi.spyOn(child.stdin, 'write');

    await managed.writeLine('a'.repeat(1024 * 1024));
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(`${'a'.repeat(1024 * 1024)}\n`, 'utf8', expect.any(Function));

    write.mockClear();
    await expect(managed.writeLine('a'.repeat(1024 * 1024 + 1)))
      .rejects.toThrow('exceeds 1048576 bytes');
    expect(write).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes at the exact configured input boundary', async () => {
    const startManagedStdioProcess = await loadStartManagedStdioProcess();
    const managed = startManagedStdioProcess({
      command: absoluteExecutable(),
      args: [],
      cwd: absoluteWorkingDirectory(),
      maxInputLineBytes: 6,
    });
    const write = vi.spyOn(processMocks.children[0].stdin, 'write');

    await managed.writeLine('报销');
    expect(write).toHaveBeenCalledOnce();
    write.mockClear();

    await expect(managed.writeLine('报销a')).rejects.toThrow('exceeds 6 bytes');
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', { maxInputLineBytes: 0 }],
    ['negative', { maxOutputLineBytes: -1 }],
    ['fractional', { maxInputLineBytes: 1.5 }],
    ['NaN', { maxOutputLineBytes: Number.NaN }],
    ['infinite', { maxInputLineBytes: Number.POSITIVE_INFINITY }],
    ['above the 64 MiB ceiling', { maxOutputLineBytes: 64 * 1024 * 1024 + 1 }],
  ])('rejects %s line-limit configuration before spawn', async (_label, limits) => {
    const startManagedStdioProcess = await loadStartManagedStdioProcess();

    expect(() => startManagedStdioProcess({
      command: absoluteExecutable(),
      args: [],
      cwd: absoluteWorkingDirectory(),
      ...limits,
    })).toThrow(/positive safe integer/);
    expect(processMocks.spawnCli).not.toHaveBeenCalled();
  });

  it('accepts the strict 64 MiB configuration ceiling', async () => {
    const startManagedStdioProcess = await loadStartManagedStdioProcess();

    expect(() => startManagedStdioProcess({
      command: absoluteExecutable(),
      args: [],
      cwd: absoluteWorkingDirectory(),
      maxInputLineBytes: 64 * 1024 * 1024,
      maxOutputLineBytes: 64 * 1024 * 1024,
    })).not.toThrow();
    expect(processMocks.spawnCli).toHaveBeenCalledOnce();
  });

  it('emits ASCII and multibyte output at the exact boundary', async () => {
    const startManagedStdioProcess = await loadStartManagedStdioProcess();
    const managed = startManagedStdioProcess({
      command: absoluteExecutable(),
      args: [],
      cwd: absoluteWorkingDirectory(),
      maxOutputLineBytes: 6,
    });
    const lines: string[] = [];
    managed.onLine((line) => lines.push(line));

    processMocks.children[0].stdout.write('abcdef\n报销\n');

    expect(lines).toEqual(['abcdef', '报销']);
    expect(processMocks.killProcessTree).not.toHaveBeenCalled();
  });

  it('terminates on one multibyte output byte over and ignores later output', async () => {
    const startManagedStdioProcess = await loadStartManagedStdioProcess();
    const managed = startManagedStdioProcess({
      command: absoluteExecutable(),
      args: [],
      cwd: absoluteWorkingDirectory(),
      maxOutputLineBytes: 6,
    });
    const lines: string[] = [];
    const exits: Array<Error | null> = [];
    managed.onLine((line) => lines.push(line));
    managed.onExit((error) => exits.push(error));
    const child = processMocks.children[0];

    child.stdout.write('报销a');
    child.stdout.write('\naccepted-after-failure\n');

    expect(lines).toEqual([]);
    expect(exits).toHaveLength(1);
    expect(exits[0]?.message).toContain('exceeds 6 bytes');
    expect(processMocks.killProcessTree).toHaveBeenCalledOnce();
    expect(processMocks.killProcessTree).toHaveBeenCalledWith(child, 'SIGTERM');
  });
});

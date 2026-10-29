// Hub 核对节奏的回归测试。调度照搬 main/index.ts：定时器在启动 6s 后建立，启动核对在
// 6s+60s 后执行；每次走到闸门前有一段准备耗时（内置内容撒种、默认安装检查），用 prepMs 模拟。
// 曾经的缺陷：定时器与闸门同为 6 小时、零余量，本轮准备比上轮快 1ms 就被跳过，最坏 12 小时；
// 拉取失败也算"核对过"，之后 6 小时不再问 Hub，且失败被吞掉、不安排重试。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const postJsonMock = vi.hoisted(() => vi.fn());
const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock('../../../src/main/features/marketplace', () => ({
  postJson: postJsonMock,
  installMarketplaceAgent: vi.fn(),
  extractBundleSafely: vi.fn(),
  recordAppIncompatibleSkip: vi.fn(),
  clearAppIncompatibleSkip: vi.fn(),
  quarantineStagingName: (hex: string) => `.staging-${hex}`,
  quarantineTrashName: (contentId: string, hex: string) => `.trash-${contentId}-${hex}`,
}));
vi.mock('../../../src/main/features/marketplace/source-fetch', () => ({
  fetchImmutableSource: vi.fn(),
}));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => loggerMocks }));
vi.mock('../../../src/main/features/devtools', () => ({ isDevEnv: () => false }));
vi.mock('electron', () => ({ app: { getVersion: () => '1.5.1' } }));

const HOUR = 60 * 60 * 1000;
const INTERVAL_MS = 6 * HOUR; // MARKETPLACE_SERVER_CHECK_INTERVAL_MS
const BASE_DEFER_MS = 6_000; // BOOT_BACKGROUND_DEFER_MS
const STARTUP_DELAY_MS = 60_000; // MARKETPLACE_STARTUP_CHECK_DELAY_MS
const RETRY_DELAY_MS = 30 * 60_000; // MARKETPLACE_CHECK_RETRY_DELAY_MS

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-reconcile-cadence-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  postJsonMock.mockReset();
  postJsonMock.mockResolvedValue({ list: [{ id: 'agent-a', version: '1.0.0', published_at: 100, status: 'approved' }], total: 1 });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T09:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// 不跑真实定时器（真实文件 IO 会和假时钟交错，引入不可控的毫秒误差），
// 而是按 index.ts 的时间表算出每次走到闸门的时刻，把系统时间设到那一刻再调用。
async function setup() {
  const installs = await import('../../../src/main/features/marketplace_installs');
  await installs.addAgentInstall('u1', {
    id: 'agent-a', version: '1.0.0', published_at: 100,
    agent_json_url: 'https://example.test/agent.json', create_uid: '0',
  });
  const reconcile = await import('../../../src/main/features/marketplace_reconcile');
  const check = (reason: string) => reconcile.checkServerUpdatesForInstalls('u1',
    reconcile.serverCheckGateForReason(reason, INTERVAL_MS, RETRY_DELAY_MS));
  return { check };
}

async function simulate(prepMs: number | ((round: number) => number), hours: number): Promise<string[]> {
  const { check } = await setup();
  const t0 = Date.now();
  const prep = (round: number): number => (typeof prepMs === 'function' ? prepMs(round) : prepMs);
  const rounds: Array<{ reason: string; firedAt: number }> = [
    { reason: 'startup', firedAt: BASE_DEFER_MS + STARTUP_DELAY_MS },
  ];
  for (let k = 1; BASE_DEFER_MS + k * INTERVAL_MS <= hours * HOUR; k++) {
    rounds.push({ reason: 'interval', firedAt: BASE_DEFER_MS + k * INTERVAL_MS });
  }
  rounds.sort((x, y) => x.firedAt - y.firedAt);
  const events: string[] = [];
  for (const [round, r] of rounds.entries()) {
    vi.setSystemTime(t0 + r.firedAt + prep(round));
    const res = await check(r.reason);
    events.push(`${(r.firedAt / HOUR).toFixed(3)}h ${r.reason} ${res.skipped ? 'SKIPPED' : 'CHECKED'}`);
  }
  return events;
}

const intervalTicks = (events: string[]): string[] =>
  events.filter((e) => e.includes('interval')).map((e) => e.split(' ')[2]);

describe('marketplace server-check cadence', () => {
  it('the first interval tick after a startup check still checks', async () => {
    const events = await simulate(500, 13);
    expect(events).toEqual(['0.018h startup CHECKED', '6.002h interval CHECKED', '12.002h interval CHECKED']);
  });

  it('a tick whose prep is 1ms shorter than last round still checks', async () => {
    const preps = [500, 500, 800, 799, 800];
    const events = await simulate((round) => preps[Math.min(round, preps.length - 1)], 25);
    expect(intervalTicks(events)).toEqual(['CHECKED', 'CHECKED', 'CHECKED', 'CHECKED']);
  });

  it('random prep jitter never skips an interval tick', async () => {
    let seed = 42;
    const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const events = await simulate(() => 300 + Math.floor(rand() * 400), 6 * 200 + 1);
    const ticks = intervalTicks(events);
    expect(ticks).toHaveLength(200);
    expect(ticks.every((t) => t === 'CHECKED')).toBe(true);
  });

  it('extra triggers within 6h of a successful check stay deduplicated', async () => {
    const { check } = await setup();
    expect((await check('startup')).skipped).toBeUndefined();
    vi.setSystemTime(Date.now() + 5 * HOUR);
    expect((await check('catalog-opened')).skipped).toBe(true);
    expect((await check('retry')).skipped).toBe(true);
    vi.setSystemTime(Date.now() + HOUR);
    expect((await check('catalog-opened')).skipped).toBeUndefined();
  });

  it('a failed check reports failed and only holds extra triggers for 30 minutes', async () => {
    const { check } = await setup();
    postJsonMock.mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED'));
    expect(await check('startup')).toEqual({ updated_agents: 0, updated_skills: 0, failed: true });
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect((await check('catalog-opened')).skipped).toBe(true);
    expect(postJsonMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 21 * 60_000);
    postJsonMock.mockResolvedValue({ list: [{ id: 'agent-a', version: '1.0.0', published_at: 100, status: 'approved' }], total: 1 });
    expect((await check('catalog-opened')).skipped).toBeUndefined();
  });

  it('the retry after a failure is not held by the failure backoff', async () => {
    const { check } = await setup();
    postJsonMock.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'));
    expect((await check('startup')).failed).toBe(true);
    vi.setSystemTime(Date.now() + RETRY_DELAY_MS - 1);
    const res = await check('retry');
    expect(res.skipped).toBeUndefined();
    expect(res.failed).toBeUndefined();
  });
});

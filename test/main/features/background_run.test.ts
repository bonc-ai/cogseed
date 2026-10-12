import * as fs from 'node:fs';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/i18n', () => ({
  t: (key: string, vars?: Record<string, string>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));

const loggerSpy = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ warn: loggerSpy.warn, info: vi.fn() }),
}));

beforeEach(() => {
  loggerSpy.warn.mockClear();
});

import {
  shouldHideOnClose,
  startBackgroundRun,
  statusLabelFor,
  buildMenuItems,
  STATUS_REFRESH_MS,
} from '../../../src/main/features/background_run';
import type {
  BackgroundRunDeps,
  TrayHost,
  TrayMenuItemSpec,
} from '../../../src/main/features/background_run';

const base = { isQuitting: false, closeToTray: true, trayAvailable: true };

describe('shouldHideOnClose', () => {
  it('hides when the preference is on, the tray is live and the app is not quitting', () => {
    expect(shouldHideOnClose(base)).toBe(true);
  });

  it('lets the close through while quitting, even with the preference on', () => {
    expect(shouldHideOnClose({ ...base, isQuitting: true })).toBe(false);
  });

  it('lets the close through when the preference is off', () => {
    expect(shouldHideOnClose({ ...base, closeToTray: false })).toBe(false);
  });

  it('never hides without a live tray — a hidden window with no tray icon is unreachable', () => {
    expect(shouldHideOnClose({ ...base, trayAvailable: false })).toBe(false);
  });
});

interface FakeTray { id: number }

interface HostCalls {
  menus: TrayMenuItemSpec[][];
  poppedMenus: TrayMenuItemSpec[][];
  tooltips: string[];
  balloons: Array<{ title: string; content: string }>;
  destroyed: number;
  refreshIntervalMs: number | null;
  refreshStarts: number;
  refreshStops: number;
  refreshFlush: (() => void) | null;
  leftClick: (() => void) | null;
  rightClick: (() => void) | null;
}

function makeHost(overrides: Partial<TrayHost> = {}): { host: TrayHost; calls: HostCalls } {
  const calls: HostCalls = {
    menus: [], poppedMenus: [], tooltips: [], balloons: [],
    destroyed: 0, refreshIntervalMs: null, refreshStarts: 0, refreshStops: 0, refreshFlush: null,
    leftClick: null, rightClick: null,
  };
  const host: TrayHost = {
    createIcon: () => ({ icon: true }),
    createTray: () => ({ id: 1 }) as FakeTray,
    setToolTip: (_tray, text) => { calls.tooltips.push(text); },
    setMenu: (_tray, items) => { calls.menus.push(items); },
    popUpMenu: (_tray, items) => { calls.poppedMenus.push(items); },
    onLeftClick: (_tray, listener) => { calls.leftClick = listener; },
    onRightClick: (_tray, listener) => { calls.rightClick = listener; },
    displayBalloon: (_tray, title, content) => { calls.balloons.push({ title, content }); },
    destroy: () => { calls.destroyed += 1; },
    startStatusRefresh: (flush, intervalMs) => {
      calls.refreshStarts += 1;
      calls.refreshIntervalMs = intervalMs;
      calls.refreshFlush = flush;
      return () => { calls.refreshStops += 1; };
    },
    ...overrides,
  };
  return { host, calls };
}

function makeDeps(host: TrayHost, overrides: Partial<BackgroundRunDeps> = {}): BackgroundRunDeps {
  return {
    host,
    platform: 'win32',
    showMainWindow: vi.fn(),
    requestQuit: vi.fn(),
    getActiveTaskCount: async () => 0,
    ...overrides,
  };
}

/** 让挂起的 refresh（一次 microtask + 一次 setTimeout(0)）跑完。 */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('statusLabelFor', () => {
  it('returns null for an unknown count so no status row is shown', () => {
    expect(statusLabelFor(null)).toBeNull();
  });

  it('treats zero and negatives as idle', () => {
    expect(statusLabelFor(0)).toBe('tray.status.idle');
    expect(statusLabelFor(-3)).toBe('tray.status.idle');
  });

  it('interpolates the running count', () => {
    expect(statusLabelFor(2)).toBe('tray.status.running:{"count":"2"}');
  });

  it('treats non-finite counts as unknown instead of idle', () => {
    expect(statusLabelFor(Number.NaN)).toBeNull();
    expect(statusLabelFor(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('buildMenuItems', () => {
  it('always has show first and quit last', () => {
    const items = buildMenuItems({ statusLabel: null, onShow: vi.fn(), onQuit: vi.fn() });
    expect(items.map((item) => item.id)).toEqual(['show', 'quit']);
  });

  it('inserts the status row in the middle and keeps it non-clickable', () => {
    const items = buildMenuItems({ statusLabel: 'busy', onShow: vi.fn(), onQuit: vi.fn() });
    expect(items.map((item) => item.id)).toEqual(['show', 'status', 'quit']);
    expect(items[1].enabled).toBe(false);
    expect(items[1].click).toBeUndefined();
  });
});

describe('startBackgroundRun on win32', () => {
  it.each(['win32', 'darwin'] as const)(
    'on %s reads nothing and starts no timer while the window stays visible',
    async (platform) => {
      const { host, calls } = makeHost();
      const countSpy = vi.fn(async () => 0);
      startBackgroundRun(makeDeps(host, { platform, getActiveTaskCount: countSpy }));
      await settle();

      // 可见时状态行没有意义：不读运行时状态（因而不会初始化运行时控制器），也不开表。
      expect(countSpy).not.toHaveBeenCalled();
      expect(calls.refreshIntervalMs).toBeNull();
      expect(calls.refreshStarts).toBe(0);
      expect(calls.tooltips).toHaveLength(0);
    },
  );

  it('reads once on hide, stops polling on show, and starts a new timer on the next hide', async () => {
    const { host, calls } = makeHost();
    const countSpy = vi.fn(async () => 2);
    const run = startBackgroundRun(makeDeps(host, { getActiveTaskCount: countSpy }));

    run.setForeground(false); // 第一次隐藏：立即读一次并开表
    await settle();
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(calls.refreshStarts).toBe(1);
    expect(calls.refreshIntervalMs).toBe(STATUS_REFRESH_MS);
    expect(calls.tooltips.at(-1)).toContain('tray.status.running');

    run.setForeground(false); // 已经在后台：重复调用不重复读、不重复开表
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(calls.refreshStarts).toBe(1);

    run.setForeground(true); // 重新显示：停表
    expect(calls.refreshStops).toBe(1);
    // 可见端状态必须是"未知"：停表后隐藏期读到的 2 不会再被刷新，留着就是冻结值。
    expect(calls.tooltips.at(-1)).toBe('tray.tooltip');
    const tooltipsAfterShow = calls.tooltips.length;

    run.setForeground(true); // 已经在前台：无操作
    expect(calls.refreshStops).toBe(1);
    expect(calls.tooltips).toHaveLength(tooltipsAfterShow);

    run.setForeground(false); // 再次隐藏：重新读一次并开新表
    await settle();
    expect(countSpy).toHaveBeenCalledTimes(2);
    expect(calls.refreshStarts).toBe(2);
    expect(calls.tooltips.at(-1)).toContain('tray.status.running');
  });

  it('clears the stale count when the window comes back', async () => {
    const { host, calls } = makeHost();
    const countSpy = vi.fn(async () => 3);
    const run = startBackgroundRun(makeDeps(host, { getActiveTaskCount: countSpy }));
    run.setForeground(false); // 隐藏：读到 3 并画到托盘上
    await settle();
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(calls.tooltips.at(-1)).toContain('tray.status.running');

    run.setForeground(true); // 窗口回来了：轮询停下，这个 3 再也不会被刷新
    expect(calls.refreshStops).toBe(1);
    expect(countSpy).toHaveBeenCalledTimes(1); // 可见时不补读，只作废
    expect(calls.tooltips.at(-1)).toBe('tray.tooltip'); // 回到"未知"，不是冻结的 3

    calls.rightClick?.(); // 状态行同样必须消失
    expect(calls.poppedMenus.at(-1)!.map((item) => item.id)).toEqual(['show', 'quit']);
  });

  it('discards a read that lands after the window came back', async () => {
    const { host, calls } = makeHost();
    const resolvers: Array<(value: number | null) => void> = [];
    const run = startBackgroundRun(makeDeps(host, {
      getActiveTaskCount: () => new Promise<number | null>((resolve) => { resolvers.push(resolve); }),
    }));
    run.setForeground(false); // 隐藏触发首次读取：结果还在飞
    run.setForeground(true);  // 窗口已经回来了，这次读取必须作废
    const tooltipsAfterShow = calls.tooltips.length;
    expect(calls.tooltips.at(-1)).toBe('tray.tooltip');

    resolvers[0](3); // 迟到的结果不能把计数画到已经可见的托盘上
    await settle();
    expect(calls.tooltips).toHaveLength(tooltipsAfterShow);
    expect(calls.tooltips.at(-1)).toBe('tray.tooltip');
  });

  it('touches nothing when setForeground runs after stop', async () => {
    const { host, calls } = makeHost();
    const countSpy = vi.fn(async () => 1);
    const run = startBackgroundRun(makeDeps(host, { getActiveTaskCount: countSpy }));
    run.setForeground(false);
    await settle();
    run.stop();
    const readsAtStop = countSpy.mock.calls.length;
    const startsAtStop = calls.refreshStarts;
    const stopsAtStop = calls.refreshStops;

    run.setForeground(true);
    run.setForeground(false);
    await settle();

    expect(countSpy).toHaveBeenCalledTimes(readsAtStop);
    expect(calls.refreshStarts).toBe(startsAtStop);
    expect(calls.refreshStops).toBe(stopsAtStop);
    expect(calls.destroyed).toBe(1);
  });

  it('stays available when the refresh timer cannot be started', async () => {
    const { host, calls } = makeHost({ startStatusRefresh: () => { throw new Error('no timer'); } });
    const run = startBackgroundRun(makeDeps(host));
    await settle();

    expect(() => run.setForeground(false)).not.toThrow(); // 起表失败不得抛给 index.ts
    await settle();
    expect(run.isAvailable()).toBe(true);
    expect(calls.refreshIntervalMs).toBeNull();
    expect(loggerSpy.warn).toHaveBeenCalled();

    run.setForeground(true); // 停表在"未开表"状态下也必须安全
    run.stop();
    expect(calls.destroyed).toBe(1);
  });

  it('shows the window on left click and rebuilds the menu on right click', async () => {
    const { host, calls } = makeHost();
    const countSpy = vi.fn(async () => 0);
    const deps = makeDeps(host, { getActiveTaskCount: countSpy });
    const run = startBackgroundRun(deps);
    run.setForeground(false); // 隐藏后才开始轮询
    await settle();

    expect(calls.leftClick).toBeTypeOf('function');
    expect(calls.rightClick).toBeTypeOf('function');
    expect(calls.menus).toHaveLength(0);      // win32 不预先设置菜单，避免和右键菜单重复
    expect(calls.refreshIntervalMs).toBe(STATUS_REFRESH_MS);
    expect(countSpy).toHaveBeenCalledTimes(1);

    calls.leftClick?.();
    expect(deps.showMainWindow).toHaveBeenCalledTimes(1);

    calls.rightClick?.();
    expect(calls.poppedMenus).toHaveLength(1);
    expect(calls.poppedMenus[0].map((item) => item.id)).toEqual(['show', 'status', 'quit']);
  });

  it('shows the background hint balloon once per session', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host));
    await settle();

    run.notifyHidden();
    run.notifyHidden();
    expect(calls.balloons).toHaveLength(1);
    expect(calls.balloons[0].title).toBe('tray.background_hint.title');
  });

  it('hides the status row when the count is unknown', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host, { getActiveTaskCount: async () => null }));
    run.setForeground(false);
    await settle();

    expect(calls.tooltips.at(-1)).toBe('tray.tooltip');
    calls.rightClick?.();
    expect(calls.poppedMenus[0].map((item) => item.id)).toEqual(['show', 'quit']);
  });

  it('hides the status row (and warns) when the count lookup throws', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host, {
      getActiveTaskCount: async () => { throw new Error('boom'); },
    }));
    run.setForeground(false);
    await settle();

    calls.rightClick?.();
    expect(calls.poppedMenus[0].map((item) => item.id)).toEqual(['show', 'quit']);
    expect(loggerSpy.warn).toHaveBeenCalled();
  });

  it('destroys the tray on stop', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host));
    await settle();
    expect(run.isAvailable()).toBe(true);
    run.stop();
    expect(calls.destroyed).toBe(1);
  });

  it('re-reads the count on each refresh tick', async () => {
    const { host, calls } = makeHost();
    const countSpy = vi.fn(async () => 0);
    const run = startBackgroundRun(makeDeps(host, { getActiveTaskCount: countSpy }));
    run.setForeground(false);
    await settle();
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(calls.tooltips.at(-1)).toContain('tray.status.idle');

    countSpy.mockResolvedValue(3);
    calls.refreshFlush?.();
    await settle();
    expect(countSpy).toHaveBeenCalledTimes(2);
    expect(calls.tooltips.at(-1)).toContain('tray.status.running');
  });

  it('does not pop a menu after stop', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host));
    await settle();
    run.stop();
    calls.rightClick?.();
    expect(calls.poppedMenus).toHaveLength(0);
  });

  it('ignores a status read that resolves after stop', async () => {
    const { host, calls } = makeHost();
    let release: (value: number) => void = () => { /* 稍后赋值 */ };
    const pending = new Promise<number>((resolve) => { release = resolve; });
    const run = startBackgroundRun(makeDeps(host, { getActiveTaskCount: () => pending }));
    run.setForeground(false); // 读取还在飞
    run.stop(); // 读取还没回来
    const tooltipsAfterStop = calls.tooltips.length;
    release(5);
    await settle();
    expect(calls.tooltips).toHaveLength(tooltipsAfterStop);
  });

  it('destroys the tray only once when stopped twice', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host));
    await settle();
    run.stop();
    run.stop();
    expect(calls.destroyed).toBe(1);
  });

  it('does not touch a destroyed tray when the window is hidden after stop', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host));
    await settle();
    run.stop();
    const tooltipsAfterStop = calls.tooltips.length;
    run.notifyHidden();
    expect(calls.balloons).toHaveLength(0);
    expect(calls.tooltips).toHaveLength(tooltipsAfterStop);
  });

  it('keeps the newest count when two reads resolve out of order', async () => {
    const { host, calls } = makeHost();
    const resolvers: Array<(value: number | null) => void> = [];
    const run = startBackgroundRun(makeDeps(host, {
      getActiveTaskCount: () => new Promise<number | null>((resolve) => { resolvers.push(resolve); }),
    }));
    run.setForeground(false); // 隐藏触发首次读取

    resolvers[0](0); // 首次读取返回：idle
    await settle();
    expect(calls.tooltips.at(-1)).toContain('tray.status.idle');

    calls.refreshFlush?.(); // 第二次读取（更新的票据）
    calls.refreshFlush?.(); // 第三次读取（票据再 +1）
    resolvers[1](9);        // 旧读取晚到 → 必须被丢弃，不能覆盖
    await settle();
    expect(calls.tooltips.at(-1)).toContain('tray.status.idle');

    resolvers[2](7);        // 最新读取返回
    await settle();
    expect(calls.tooltips.at(-1)).toContain('tray.status.running');
  });

  it('does not reveal the window from a stale left click after stop', async () => {
    const { host, calls } = makeHost();
    const deps = makeDeps(host);
    const run = startBackgroundRun(deps);
    await settle();
    run.stop();
    calls.leftClick?.();
    expect(deps.showMainWindow).not.toHaveBeenCalled();
  });

  it('warns once, not on every tick, when the count keeps failing', async () => {
    const { host, calls } = makeHost();
    const countSpy = vi.fn(async () => { throw new Error('down'); });
    const run = startBackgroundRun(makeDeps(host, { getActiveTaskCount: countSpy }));
    run.setForeground(false);
    await settle();
    expect(countSpy).toHaveBeenCalledTimes(1);
    expect(loggerSpy.warn).toHaveBeenCalledTimes(1);

    calls.refreshFlush?.();
    await settle();
    calls.refreshFlush?.();
    await settle();
    expect(countSpy).toHaveBeenCalledTimes(3);
    expect(loggerSpy.warn).toHaveBeenCalledTimes(1); // 只在状态翻转时告警
  });

  it('survives a throwing balloon call', async () => {
    const { host } = makeHost({ displayBalloon: () => { throw new Error('no balloon'); } });
    const run = startBackgroundRun(makeDeps(host));
    await settle();
    expect(() => run.notifyHidden()).not.toThrow();
    expect(loggerSpy.warn).toHaveBeenCalled();
  });
});

describe('startBackgroundRun on darwin', () => {
  it('sets the context menu eagerly and polls the status on a timer once hidden', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host, { platform: 'darwin', getActiveTaskCount: async () => 0 }));
    run.setForeground(false);
    await settle();

    // 构造时先立刻设一次菜单（计数未知 → 只有显示/退出两项），隐藏后首次计数
    // 读回时再由 paint() 重建一次（这次带上状态行）。这里断言"最后一次是对的"，
    // 不锁死 setMenu 的调用次数。
    expect(calls.menus.length).toBeGreaterThanOrEqual(2);
    expect(calls.menus.at(-1)!.map((item) => item.id)).toEqual(['show', 'status', 'quit']);
    expect(calls.refreshIntervalMs).toBe(STATUS_REFRESH_MS);
    expect(calls.leftClick).toBeNull();
    expect(calls.balloons).toHaveLength(0);
  });

  it('has a usable menu before the first count read resolves', () => {
    const { host, calls } = makeHost();
    // 计数读取永不 resolve。macOS 的托盘菜单不能在点击时才构建，若只靠
    // refresh() 去设置菜单，这里就会留下一个点了没反应的托盘图标。
    startBackgroundRun(makeDeps(host, {
      platform: 'darwin',
      getActiveTaskCount: () => new Promise<number | null>(() => { /* never */ }),
    }));

    expect(calls.menus).toHaveLength(1);
    expect(calls.menus[0].map((item) => item.id)).toEqual(['show', 'quit']);
  });

  it('never shows the windows balloon', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host, { platform: 'darwin' }));
    await settle();
    run.notifyHidden();
    expect(calls.balloons).toHaveLength(0);
  });

  it('stops the refresh timer on stop', async () => {
    const { host, calls } = makeHost();
    const run = startBackgroundRun(makeDeps(host, { platform: 'darwin' }));
    run.setForeground(false);
    await settle();
    run.stop();
    expect(calls.refreshStarts).toBe(1);
    expect(calls.refreshStops).toBe(1);
    expect(calls.destroyed).toBe(1);
  });
});

describe('startBackgroundRun degradation', () => {
  it('stays disabled when the icon is unavailable', () => {
    const { host, calls } = makeHost({ createIcon: () => null });
    const run = startBackgroundRun(makeDeps(host));
    expect(run.isAvailable()).toBe(false);
    run.stop();
    expect(calls.destroyed).toBe(0);
    expect(calls.menus).toHaveLength(0);
  });

  it('stays disabled when tray creation throws', () => {
    const { host, calls } = makeHost({ createTray: () => { throw new Error('no tray'); } });
    const run = startBackgroundRun(makeDeps(host));
    expect(run.isAvailable()).toBe(false);
    run.stop();
    expect(calls.destroyed).toBe(0);
  });

  it('tears down the previous tray when started twice (idempotent)', async () => {
    const { host, calls } = makeHost();
    startBackgroundRun(makeDeps(host));
    await settle();
    startBackgroundRun(makeDeps(host));
    await settle();
    expect(calls.destroyed).toBe(1);
  });

  it('degrades and destroys the half-built tray when darwin wiring throws', () => {
    const { host, calls } = makeHost({ setMenu: () => { throw new Error('no menu'); } });
    const run = startBackgroundRun(makeDeps(host, { platform: 'darwin' }));
    expect(run.isAvailable()).toBe(false);
    expect(calls.destroyed).toBe(1);
    expect(loggerSpy.warn).toHaveBeenCalled();
  });

  it('degrades and destroys the half-built tray when win32 wiring throws', () => {
    const { host, calls } = makeHost({ onRightClick: () => { throw new Error('no handler'); } });
    const run = startBackgroundRun(makeDeps(host, { platform: 'win32' }));
    expect(run.isAvailable()).toBe(false);
    expect(calls.destroyed).toBe(1);
  });

  it('stays disabled when icon creation throws', () => {
    const { host, calls } = makeHost({ createIcon: () => { throw new Error('boom'); } });
    const run = startBackgroundRun(makeDeps(host));
    expect(run.isAvailable()).toBe(false);
    expect(calls.destroyed).toBe(0);
    expect(loggerSpy.warn).toHaveBeenCalled();
  });

  it('still destroys the tray when stopping the refresh timer throws', async () => {
    const { host, calls } = makeHost({
      startStatusRefresh: () => () => { throw new Error('no clear'); },
    });
    const run = startBackgroundRun(makeDeps(host));
    run.setForeground(false);
    await settle();
    run.stop();
    expect(calls.destroyed).toBe(1);
    expect(loggerSpy.warn).toHaveBeenCalled();
  });
});

describe('main locale coverage', () => {
  const moduleSource = fs.readFileSync(
    path.join(__dirname, '../../../src/main/features/background_run.ts'),
    'utf8',
  );
  const keys = Array.from(
    new Set((moduleSource.match(/t\('(tray\.[a-z_.]+)'/g) || []).map((hit) => hit.slice(3, -1))),
  ).sort();

  it('finds the tray keys by scanning the module source', () => {
    // 守卫：正则若因模块改写而失配，下面两条会退化成"零个键都通过"，这里先钉住扫描结果。
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(keys).toContain('tray.status.running');
    expect(keys).toContain('tray.background_hint.content');
  });

  it.each(['zh', 'en'])('%s locale defines every tray key used by the module', (lang) => {
    const table = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../../src/main/locales', `${lang}.json`), 'utf8'),
    ) as Record<string, string>;
    for (const key of keys) {
      expect(table[key], `${lang} is missing ${key}`).toBeTruthy();
    }
  });
});

/**
 * 托盘常驻与后台运行（Windows 任务栏 / macOS 菜单栏）。
 *
 * 这个模块**不 import electron**：托盘、菜单、图标全部通过 `TrayHost`
 * 注入，因此可在 vitest 的 node 环境完整单测（与 task_notifications.ts
 * 的 `createNotification` 注入同构）。真实 Electron 实现由 index.ts 提供。
 */
import { createLogger } from '../logger';
import { t } from '../i18n';

const log = createLogger('background_run');

/** 统一的错误文案提取，避免每处都写一遍三元表达式。 */
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 状态轮询周期。两个平台都靠它保持 tooltip / 状态行新鲜：Windows 的 tooltip 悬停可见，
 * macOS 的托盘菜单不能惰性构建（点击即展开），两者都必须由定期刷新驱动。
 */
export const STATUS_REFRESH_MS = 5_000;

export interface ClosePolicyInput {
  isQuitting: boolean;
  closeToTray: boolean;
  /** 托盘真的建起来了吗？没建起来就绝不能隐藏窗口。 */
  trayAvailable: boolean;
}

/**
 * 关闭按钮是否应该只隐藏窗口。
 *
 * 三个条件缺一不可：
 * - `isQuitting`：由 index.ts 在 `before-quit` 里置位——它是托盘退出、Cmd+Q、
 *   `updates.install` 三条路径的共同上游（Windows 关机不走 `app.quit()`，另由
 *   `session-end` 兜底）。若在安装流程里也返回 true，
 *   `app.quit()` 会被窗口的 preventDefault 中止，分离助手 `bin/apply-update.cjs`
 *   等不到父进程退出（60 s 超时）→ 安装会静默失败。
 * - `closeToTray`：用户偏好。
 * - `trayAvailable`：托盘创建失败时必须放行关闭，否则窗口被隐藏、又没有任何
 *   入口能把它叫回来。
 */
export function shouldHideOnClose(input: ClosePolicyInput): boolean {
  return !input.isQuitting && input.closeToTray && input.trayAvailable;
}

export interface TrayMenuItemSpec {
  id: 'show' | 'status' | 'quit';
  label: string;
  enabled: boolean;
  click?: () => void;
}

export interface TrayHost {
  /** 图标不可用（文件缺失/解码失败）时返回 null。 */
  createIcon(): unknown | null;
  /** 创建失败可以抛错；模块会降级为"没有托盘"。 */
  createTray(icon: unknown): unknown;
  setToolTip(tray: unknown, text: string): void;
  setMenu(tray: unknown, items: TrayMenuItemSpec[]): void;
  popUpMenu(tray: unknown, items: TrayMenuItemSpec[]): void;
  onLeftClick(tray: unknown, listener: () => void): void;
  onRightClick(tray: unknown, listener: () => void): void;
  displayBalloon(tray: unknown, title: string, content: string): void;
  destroy(tray: unknown): void;
  /** 返回停止函数。实现必须 `unref()`，不得阻止进程退出。 */
  startStatusRefresh(flush: () => void, intervalMs: number): () => void;
}

export interface BackgroundRunDeps {
  host: TrayHost;
  platform: NodeJS.Platform;
  showMainWindow(): void;
  requestQuit(): void;
  /** null = 未知 → 状态行整行隐藏，绝不显示错误。 */
  getActiveTaskCount(): Promise<number | null>;
}

export interface BackgroundRun {
  /** 托盘是否真的可用；false 时 index.ts 必须放行关闭（见 shouldHideOnClose）。 */
  isAvailable(): boolean;
  /** 销毁托盘并停表；幂等。 */
  stop(): void;
  /** 窗口刚被隐藏时调用：每个 BackgroundRun 实例只提示一次（index.ts 只在启动时创建一次，因此等价于每个应用会话一次）。仅 Windows 生效。 */
  notifyHidden(): void;
  /** 窗口是否可见（前台）。构造时视为可见：可见时状态行无意义，不轮询也不预读计数。
   *  隐藏时立即取一次计数并启动轮询；重新显示时停表，并把隐藏期间读到的计数作废
   *  （停表后它不会再被刷新，留着就是冻结的误导值）。由 index.ts 在
   *  show/hide/minimize/restore 时驱动。 */
  setForeground(foreground: boolean): void;
}

/** 状态行文案；null 表示"未知"，调用方不得显示任何一行（绝不显示会误导的 0）。 */
export function statusLabelFor(count: number | null): string | null {
  if (count === null || !Number.isFinite(count)) return null;
  if (count <= 0) return t('tray.status.idle');
  return t('tray.status.running', { count: String(Math.trunc(count)) });
}

export function buildMenuItems(input: {
  statusLabel: string | null;
  onShow(): void;
  onQuit(): void;
}): TrayMenuItemSpec[] {
  const items: TrayMenuItemSpec[] = [
    { id: 'show', label: t('tray.show_window'), enabled: true, click: input.onShow },
  ];
  // 只读状态行：`enabled:false` 让它不可点，只作为信息展示。
  if (input.statusLabel) {
    items.push({ id: 'status', label: input.statusLabel, enabled: false });
  }
  items.push({ id: 'quit', label: t('tray.quit'), enabled: true, click: input.onQuit });
  return items;
}

function noopRun(): BackgroundRun {
  return {
    isAvailable: () => false,
    stop() { /* 没有托盘可销毁 */ },
    notifyHidden() { /* 没有托盘可提示 */ },
    setForeground() { /* 没有托盘就没有轮询可开关 */ },
  };
}

/** 最近的实例；重复 start 时先拆掉旧的（幂等）。 */
let active: BackgroundRun | null = null;

export function startBackgroundRun(deps: BackgroundRunDeps): BackgroundRun {
  if (active) { active.stop(); active = null; }

  let icon: unknown = null;
  try {
    icon = deps.host.createIcon();
  } catch (err) {
    log.warn('tray icon creation failed; background run stays disabled', { error: errorMessage(err) });
    return noopRun();
  }
  if (!icon) {
    log.warn('tray icon unavailable; background run stays disabled');
    return noopRun();
  }

  let tray: unknown;
  try {
    tray = deps.host.createTray(icon);
  } catch (err) {
    log.warn('tray creation failed; background run stays disabled', {
      error: errorMessage(err),
    });
    return noopRun();
  }
  if (!tray) {
    log.warn('tray creation returned nothing; background run stays disabled');
    return noopRun();
  }

  const isMac = deps.platform === 'darwin';
  let activeTaskCount: number | null = null;
  let hinted = false;
  let stopped = false;
  let seq = 0;
  let statusReadFailed = false;
  // 构造时窗口是可见的；隐藏时才开表，重新显示就停表。
  let foreground = true;
  let stopRefresh: (() => void) | null = null;

  const menu = (): TrayMenuItemSpec[] => buildMenuItems({
    statusLabel: statusLabelFor(activeTaskCount),
    onShow: () => deps.showMainWindow(),
    onQuit: () => deps.requestQuit(),
  });

  const paint = (): void => {
    if (stopped) return;
    const status = statusLabelFor(activeTaskCount);
    deps.host.setToolTip(tray, status ? t('tray.tooltip_with_status', { status }) : t('tray.tooltip'));
    if (isMac) deps.host.setMenu(tray, menu());
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    const ticket = ++seq;
    try {
      const next = await deps.getActiveTaskCount();
      if (ticket !== seq) return; // 有更新的读取在飞，丢弃这次结果
      activeTaskCount = (next === null || !Number.isFinite(next))
        ? null
        : Math.max(0, Math.trunc(next));
      statusReadFailed = false;
    } catch (err) {
      if (ticket !== seq) return;
      activeTaskCount = null; // 未知 → 隐藏状态行，不向用户暴露错误
      // 轮询每 5 s 会重试；只在"正常 → 失败"翻转时告警，避免持续失败刷爆日志。
      if (!statusReadFailed) {
        statusReadFailed = true;
        log.warn('tray status unavailable', { error: errorMessage(err) });
      }
    }
    paint();
  };

  /** 开表；已开表或已停用时不重复开。轮询起不来是非致命的（托盘仍可用）。 */
  const startTimer = (): void => {
    if (stopped || stopRefresh) return;
    try {
      stopRefresh = deps.host.startStatusRefresh(() => { void refresh(); }, STATUS_REFRESH_MS);
    } catch (err) {
      // 状态行停在最近一次读取的结果上，但托盘本身仍然可用——不要因此降级整个托盘。
      stopRefresh = null;
      log.warn('tray refresh start failed', { error: errorMessage(err) });
    }
  };

  /** 停表；幂等。停止函数是外部实现，抛错只告警，绝不影响销毁托盘。 */
  const stopTimer = (): void => {
    if (!stopRefresh) return;
    const stop = stopRefresh;
    stopRefresh = null;
    try { stop(); } catch (err) { log.warn('tray refresh stop failed', { error: errorMessage(err) }); }
  };

  // 构造期同样可能抛（setContextMenu / on(...) 都是外部实现），任何一步失败都必须
  // 拆掉半成品托盘并降级——否则 index.ts 会以为托盘可用，进而把窗口藏到一个没有
  // 入口的进程里。轮询不在构造期启动：窗口可见时它没有意义（见 setForeground）。
  try {
    if (isMac) {
      // macOS：设置 contextMenu 后"点击即展开菜单"由系统接管，不绑单击呼出。
      // 这次 setMenu 必须留在构造期：菜单不能在点击时才构建。
      deps.host.setMenu(tray, menu());
    } else {
      deps.host.onLeftClick(tray, () => { if (!stopped) deps.showMainWindow(); });
      // Windows：每次右键都重建菜单。计数由隐藏期间的轮询保持最新，因此这里能立刻拿到值。
      deps.host.onRightClick(tray, () => { if (stopped) return; deps.host.popUpMenu(tray, menu()); });
    }
  } catch (err) {
    log.warn('tray wiring failed; background run stays disabled', { error: errorMessage(err) });
    try { deps.host.destroy(tray); } catch { /* 拆不掉也不能让启动失败 */ }
    return noopRun();
  }

  const run: BackgroundRun = {
    isAvailable: () => true,
    stop(): void {
      if (stopped) return;
      stopped = true;
      stopTimer();
      try { deps.host.destroy(tray); } catch (err) { log.warn('tray destroy failed', { error: errorMessage(err) }); }
      if (active === run) active = null;
    },
    notifyHidden(): void {
      if (stopped || hinted) return;
      hinted = true;
      if (deps.platform !== 'win32') return; // macOS 没有气泡 API
      try {
        deps.host.displayBalloon(tray, t('tray.background_hint.title'), t('tray.background_hint.content'));
      } catch (err) {
        log.warn('tray balloon failed', { error: errorMessage(err) });
      }
    },
    setForeground(next: boolean): void {
      if (stopped || next === foreground) return; // 已停用或状态未变：什么都不碰
      foreground = next;
      if (!next) {
        // 两个平台都在隐藏期间轮询：Windows 的 tooltip 是悬停可见的，macOS 的
        // 菜单不能惰性构建。隐藏的第一时间先读一次，随后交给定时器。
        void refresh();
        startTimer();
        return;
      }
      stopTimer();
      // 恢复可见后不再轮询，所以必须把上一轮读到的计数作废：否则 tooltip 会一直
      // 停在隐藏期间读到的数字。过期值和错误值一样会误导，未知状态才是诚实的。
      seq += 1;                 // 丢弃可能还在飞的读取
      activeTaskCount = null;   // 未知 → statusLabelFor(null) 隐藏状态行
      paint();
    },
  };
  active = run;
  return run;
}

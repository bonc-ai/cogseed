import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * 设置读取偏好失败时记录 warn 与遥测，保留现有默认开启的兜底行为。
 * 通过实际渲染路径观察 checked 状态，不新增读取失败 UI 状态。
 */

function loadSettingsSandbox(invoke: (channel: string) => Promise<unknown>) {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const warn = vi.fn();
  // _settingsState 是模块内 let，vm 上下文取不到——经渲染路径观察：
  // 元数据开关渲染读 _settingsState.metacognition，checked/disabled 即落点。
  const toggle = { checked: false, disabled: false, dataset: {} as Record<string, string>, addEventListener: () => {} };
  const status = { textContent: '' };
  const sandbox: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn, error: vi.fn() }),
    t: (key: string) => key,
    document: {
      getElementById(id: string) {
        if (id === 'settings-metacognition-toggle') return toggle;
        if (id === 'settings-metacognition-status') return status;
        return null;
      },
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: vi.fn(),
      cogseed: { invoke },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.runInNewContext(source, sandbox, { filename: 'settings.js' });
  return { sandbox, warn, toggle };
}

describe('settings metacognition read failure', () => {
  it('prefs.getMetacognition 抛错：留 warn 日志，兜底行为不变（默认开）', async () => {
    const { sandbox, warn, toggle } = loadSettingsSandbox((channel) => {
      if (channel === 'prefs.getMetacognition') return Promise.reject(new Error('prefs unreadable'));
      return Promise.resolve(null);
    });
    await sandbox._settingsRefreshMetacognition();
    // 修前：catch (_) 静默吞错，日志零记录。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('getMetacognition failed');
    // 兜底行为不变：回默认开，不新增 readFailed UI 状态。
    sandbox._settingsRenderMetacognition();
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });

  it('回执不带 ok（rejected 形状）：与写路径的 rejected 分支对称留痕', async () => {
    const { sandbox, warn, toggle } = loadSettingsSandbox((channel) => {
      if (channel === 'prefs.getMetacognition') return Promise.resolve({ ok: false });
      return Promise.resolve(null);
    });
    await sandbox._settingsRefreshMetacognition();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('getMetacognition rejected');
    sandbox._settingsRenderMetacognition();
    expect(toggle.checked).toBe(true);
  });

  it('读成功：无告警、状态如实落盘（不误伤正常路径）', async () => {
    const { sandbox, warn, toggle } = loadSettingsSandbox((channel) => {
      if (channel === 'prefs.getMetacognition') return Promise.resolve({ ok: true, enabled: false, envForcedOff: false });
      return Promise.resolve(null);
    });
    await sandbox._settingsRefreshMetacognition();
    expect(warn).not.toHaveBeenCalled();
    sandbox._settingsRenderMetacognition();
    expect(toggle.checked).toBe(false);
  });

  it('源码对称性：读失败两分支都有遥测调用（与写路径三件套同款桩）', () => {
    const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
    // _settingsTrackEvent/_settingsTrackError 是本文件既有的中性桩，写路径
    // 照调——读路径对称调用即可（桩恢复真实埋点时读失败自动进遥测）。
    const readFn = source.slice(
      source.indexOf('async function _settingsRefreshMetacognition'),
      source.indexOf('function _settingsRenderMetacognition'),
    );
    expect(readFn).toContain("_settingsTrackEvent('metacognition_read_result', { result: 'failure' })");
    expect((readFn.match(/_settingsTrackError\('metacognition_read'/g) || []).length).toBe(2);
  });
});

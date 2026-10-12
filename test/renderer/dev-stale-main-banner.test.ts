/**
 * dev 半更新横幅（boot.js）契约测试。
 *
 * 场景：main 侧 src/main/**\/*.ts 是进程启动时由 tsx 加载的，渲染层 .js 每次刷新
 * 窗口都重读磁盘 → 可能出现"界面新、主进程旧"。此时新参数被旧主进程静默忽略。
 * boot.js 必须在启动时把这件事显式说出来并提供一键重启。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const bootSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/boot.js'), 'utf-8');
const envHandler = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf-8');
const stampSrc = fs.readFileSync(path.join(__dirname, '../../src/main/util/source-stamp.ts'), 'utf-8');

describe('dev 半更新检测：主进程侧', () => {
  it('cogseed.env 暴露启动时刻与 main 源码指纹', () => {
    // 载荷由 buildStaleMainReport 统一组装（可测的接缝），env 只做展开
    expect(envHandler).toContain('buildStaleMainReport');
    expect(envHandler).toMatch(/\.\.\.staleMain/);
    expect(stampSrc).toContain('processStartedAtMs');
    expect(stampSrc).toContain('mainSourceStale');
    expect(stampSrc).toContain('mainSourceChangedAt');
    expect(stampSrc).toContain('mainSourceFiles');
  });

  it('打包版跳过检测（bundle 不存在这种错配，也不能误报）', () => {
    expect(envHandler).toMatch(/buildStaleMainReport\(\{ pcRoot: paths\.PC_ROOT, isPackaged: app\.isPackaged \}\)/);
    expect(stampSrc).toMatch(/if \(opts\.isPackaged\) \{[\s\S]{0,200}mainSourceStale: false/);
  });

  it('判定逻辑独立可测且"宁可漏报不可误报"', () => {
    // 扫不到源码 → null；stamp 缺失 → 判定为不过期
    expect(stampSrc).toContain('files > 0 ? { files, maxMtimeMs } : null');
    expect(stampSrc).toMatch(/if \(!stamp \|\| !Number\.isFinite\(startedAtMs\)/);
  });
});

describe('dev 半更新检测：渲染层横幅', () => {
  it('启动时读取 env 并按 mainSourceStale 触发横幅', () => {
    expect(bootSrc).toContain('env.mainSourceStale');
    expect(bootSrc).toContain('function _showStaleMainBanner');
    expect(bootSrc).toMatch(/if \(env && env\.mainSourceStale\) _showStaleMainBanner\(env\)/);
  });

  it('横幅复用 #model-guard-slot 与既有横幅样式（不新增样式/不碰 locale 文件）', () => {
    expect(bootSrc).toMatch(/_showStaleMainBanner[\s\S]{0,600}querySelector\('#model-guard-slot'\)/);
    expect(bootSrc).toMatch(/el\.className = 'model-guard-banner'/);
    expect(bootSrc).toContain("el.id = 'stale-main-banner'");
    // 只有 isDev 才可能显示（生产不该出现）
    expect(bootSrc).toMatch(/if \(env && env\.isDev\) document\.body\.classList\.add\('is-dev'\)/);
  });

  it('提供一键重启（走 preload 直通的 relaunch 通道）与"本次运行内忽略"', () => {
    // cogseed.relaunch 由 main/index.ts 直接 ipcMain.handle 注册、preload 直通
    // 暴露，从未进通用 invokeHandlers 表；经 window.cogseed.invoke 调用只会
    // 拿到 {ok:false} 的 resolve（非 reject），.catch 兜底不触发 → 点击静默无效。
    expect(bootSrc).toContain("typeof window.cogseed.relaunch === 'function'");
    expect(bootSrc).toContain('window.cogseed.relaunch().catch(');
    // 回归护栏：按钮不得经通用 invoke 分发调该通道
    expect(bootSrc).not.toContain("invoke('cogseed.relaunch')");
    expect(bootSrc).toContain('stale-main-banner-dismissed');
  });

  it('cogseed.relaunch 通道形态：main 直接 ipcMain.handle + preload 直通', () => {
    expect(envHandler).toContain("ipcMain.handle('cogseed.relaunch'");
    const preloadSrc = fs.readFileSync(path.join(__dirname, '../../src/main/preload.js'), 'utf-8');
    expect(preloadSrc).toContain("relaunch: () => ipcRenderer.invoke('cogseed.relaunch')");
  });

  it('横幅渲染失败绝不影响启动（函数体第一件事就是 try）', () => {
    const idx = bootSrc.indexOf('function _showStaleMainBanner');
    const body = bootSrc.slice(idx, idx + 2000);
    expect(body).toMatch(/^function _showStaleMainBanner\(env\) \{\s*try \{/);
    expect(body).toContain('catch (_) { /* 提示条失败绝不能影响启动 */ }');
  });
});

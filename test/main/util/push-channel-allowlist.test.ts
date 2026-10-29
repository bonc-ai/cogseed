/**
 * 推送通道白名单完备性 —— 防止"主进程广播了，但渲染层订阅不到"
 *
 * 背景：渲染层订阅推送走 `window.cogseed.onPushEvent(channel, handler)`，而
 * `src/main/preload.js` 用 `PUSH_EVENT_CHANNELS` + `PUSH_EVENT_PREFIXES` 做白名单。
 * 未登记的通道会**抛错**，而调用方通常只打一条 warn 就放过去了——于是：
 *
 *   - 主进程侧以为已经把事件发出去了；
 *   - 渲染层侧卡片/面板从未挂载；
 *   - 用户看到的是"模型说请看上面的卡片，但屏幕上什么都没有"。
 *
 * 真实事故（本次）：`transcript_glossary.confirmation_required` 漏登记前缀，纠错确认
 * 卡片 100% 弹不出来，而工具侧还在等一个永远不会来的回执。
 *
 * 所以本测试守住一条硬规则：**凡是 `broadcastToRenderer` 用到的通道，
 * 必须被 preload 的白名单覆盖**。新增推送通道时，这个测试会直接变红，
 * 而不是等到真机上"卡片不出现"才发现。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const mainDir = path.join(root, 'src/main');
const preloadPath = path.join(mainDir, 'preload.js');

/** 递归收集 main 下的所有 ts/js。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** 从 preload.js 里解析出白名单（精确集合 + 前缀列表）。 */
function readAllowList(): { channels: Set<string>; prefixes: string[] } {
  const src = fs.readFileSync(preloadPath, 'utf8');

  const channels = new Set<string>();
  const channelsMatch = /const PUSH_EVENT_CHANNELS = new Set\(\[([^\]]*)\]\)/.exec(src);
  if (channelsMatch) {
    for (const m of channelsMatch[1].matchAll(/'([^']+)'/g)) channels.add(m[1]);
  }

  const prefixesMatch = /const PUSH_EVENT_PREFIXES = \[([^\]]*)\]/.exec(src);
  const prefixes = prefixesMatch
    ? [...prefixesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    : [];
  return { channels, prefixes };
}

/** 扫描 main 下所有 `broadcastToRenderer('…')` 用的字面量通道。 */
function collectBroadcastChannels(): { channel: string; file: string }[] {
  const found: { channel: string; file: string }[] = [];
  for (const file of walk(mainDir)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/broadcastToRenderer\(\s*'([^']+)'/g)) {
      found.push({ channel: m[1], file: path.relative(root, file) });
    }
  }
  return found;
}

function isAllowed(channel: string, allow: { channels: Set<string>; prefixes: string[] }): boolean {
  if (allow.channels.has(channel)) return true;
  return allow.prefixes.some((p) => channel.startsWith(p));
}

describe('推送通道白名单完备性', () => {
  it('白名单本身能被解析出来（防止 preload 被重写后测试静默失效）', () => {
    const allow = readAllowList();
    // 前缀列表是这个机制的骨架；解析不到说明 preload 结构变了，必须回来更新测试。
    expect(allow.prefixes.length).toBeGreaterThan(5);
    expect(allow.prefixes).toContain('delete_file.');
  });

  it('扫描到的广播通道不为空（防止正则与实际调用写法脱节后测试假绿）', () => {
    const channels = collectBroadcastChannels();
    expect(channels.length).toBeGreaterThan(5);
    // 抽样：这两个是长期存在的通道，扫描不到就说明扫错了地方。
    const names = channels.map((c) => c.channel);
    expect(names).toContain('delete_file.confirmation_required');
  });

  it('每个 broadcastToRenderer 通道都被 preload 白名单覆盖', () => {
    const allow = readAllowList();
    const channels = collectBroadcastChannels();
    const blocked = channels
      .filter((c) => !isAllowed(c.channel, allow))
      .map((c) => `  ${c.channel}  ← ${c.file}`);

    expect(
      blocked,
      '以下通道主进程会广播，但渲染层订阅时会被 preload 白名单拦下（订阅静默失败，'
      + '表现为"事件发了但界面没反应"）。请在 preload.js 的 PUSH_EVENT_PREFIXES / '
      + 'PUSH_EVENT_CHANNELS 里登记：\n' + blocked.join('\n'),
    ).toEqual([]);
  });

  it('纠错确认卡片通道已登记（本次事故的回归线）', () => {
    const allow = readAllowList();
    expect(isAllowed('transcript_glossary.confirmation_required', allow)).toBe(true);
    expect(isAllowed('transcript_glossary.visible', allow)).toBe(true);
  });
});

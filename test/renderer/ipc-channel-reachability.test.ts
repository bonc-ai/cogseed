import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * IPC 通道可达性不变量（P2-M8-01）。
 *
 * ## 为什么需要这个
 *
 * `ipc-shim.js` 保留了 HTTP 时代的 `apiFetch(url)` 形态，把 URL 翻译成通道名。
 * 结果是**渲染层代码里只出现 URL 字符串，不出现通道名**——任何"这个通道有没有
 * 调用方"的 grep 审计，对经 shim 到达的通道都会得出「无调用方」的错误结论。
 *
 * 这不是假想问题：气泡沉淀写进孤岛 store 的那条链
 * （`/api/cognition/assets/capture` → `cognition.assets.capture` → `cloud/cognition/`）
 * 连续两轮审计都被判成"休眠通道"，就是因为
 * `grep "'cognition.assets.capture'" src/renderer` 恒为 0 命中。
 *
 * ## 这里守两件事
 *
 *  1. **shim 路由指向的通道必须有 handler**——否则是一条注定 404 的死路由。
 *  2. **经 shim 到达的通道要被显式登记**——新增一条就要在下面的清单里写明它
 *     是 LIVE 还是遗留，逼审计者回答"谁在调它、落到哪里"。
 */

const SRC = path.join(__dirname, '../..', 'src');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf-8');
}

const shimSource = read('renderer/modules/ipc-shim.js');

/**
 * shim 路由表里出现的全部通道名。
 *
 * 逐行取，不用一条大正则：pattern 路由的匹配器是正则字面量，里面的 `[^/]`
 * 会把"扫到第一个 `]` 为止"这类写法截断，正好漏掉 `assets/:id` 那批——
 * 而那批恰恰是本文件要盯的遗留通道。
 */
function shimRoutedChannels(): string[] {
  const out = new Set<string>();
  const isChannel = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/;
  for (const line of shimSource.split('\n')) {
    if (!/^\s*\['(?:GET|POST|PUT|PATCH|DELETE)',/.test(line)) continue;
    // 行内所有单引号字符串里，第一个"像通道名"的就是 channel：
    // URL 以 `/` 开头被排除，paramKeys（如 'assetId'）不含点号也被排除。
    const channel = [...line.matchAll(/'([^']+)'/g)]
      .map((match) => match[1])
      .find((value) => isChannel.test(value));
    if (channel) out.add(channel);
  }
  return [...out].sort();
}

/** 主进程注册的全部 invoke 通道（ipc/index.ts 主表 + ipc/*.ts 的 invokeHandlers）。 */
function registeredChannels(): Set<string> {
  const dir = path.join(SRC, 'main/ipc');
  const out = new Set<string>();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf-8');
    for (const match of source.matchAll(/^\s*'([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)':\s*async/gm)) {
      out.add(match[1]);
    }
  }
  return out;
}

/** 渲染层按**通道名**直调的通道（invoke/stream）。 */
function directlyInvokedChannels(): Set<string> {
  const dir = path.join(SRC, 'renderer');
  const out = new Set<string>();
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js') || entry.name === 'ipc-shim.js') continue;
      const source = fs.readFileSync(full, 'utf-8');
      for (const match of source.matchAll(/\.(?:invoke|stream)\(\s*'([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)'/g)) {
        out.add(match[1]);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * 只能经 REST shim 到达、通道名 grep 看不见的通道。
 *
 * **每一条都必须在这里登记**，新增即测试失败。登记不是为了允许它存在，
 * 是为了逼审计者回答：谁在调它、落到哪个 store、是不是又一条通往孤岛的路。
 */
const KNOWN_DEAD_ROUTES: Record<string, string> = {
  // 既有债（本轮扫描新发现，不在认知资产域内）：shim 有路由、主进程无 handler，
  // 命中即 404。登记在此是为了**不让它增长**——修掉一条就从这里删一条。
  'contexts.officeHtml': '无 handler；对照 spaces.files.officeHtml',
  'marketplace.uploadAgent': '无 handler',
  'marketplace.uploadSkill': '无 handler',
  'workbench.actionPlan.read': '无 handler',
  'workbench.taskRun.start': '无 handler',
  'workbench.taskRuns.list': '无 handler',
};

const KNOWN_SHIM_ONLY: Record<string, string> = {
  // 空 —— 遗留 CognitionAsset store 的 REST 入口已全部删除。
  // 新增任何一条 shim-only 的 cognition/recall 通道都会让这条不变量失败，
  // 逼调用者回答：谁在调它、落到哪个 store。
};

describe('IPC 通道可达性', () => {
  it('shim 路由指向的通道都必须有 handler（不得存在注定 404 的死路由）', () => {
    const registered = registeredChannels();
    const missing = shimRoutedChannels().filter((channel) => !registered.has(channel));
    // 全应用生效，既有的三条死路由显式登记；新增一条即失败。
    expect(missing.sort()).toEqual(Object.keys(KNOWN_DEAD_ROUTES).sort());
  });

  it('经 shim 才可达的通道必须显式登记——防止再出现"看着无人调用、其实天天在跑"', () => {
    // 收窄到认知资产域（本 spec 的范围）。其余命名空间的 shim-only 通道属于
    // 各自模块的账，不在这里一并登记——那会让这条不变量变成一张没人维护的大表。
    const direct = directlyInvokedChannels();
    const shimOnly = shimRoutedChannels()
      .filter((channel) => channel.startsWith('cognition.') || channel.startsWith('recall.'))
      .filter((channel) => !direct.has(channel));
    expect(shimOnly.sort()).toEqual(Object.keys(KNOWN_SHIM_ONLY).sort());
  });

  it('气泡沉淀不得再经 shim 打到遗留 store', () => {
    // 这条链曾让用户看到「已保存」而数据进了无人消费的 `cloud/cognition/`。
    expect(shimRoutedChannels()).not.toContain('cognition.assets.capture');
    expect(shimSource).not.toContain('/api/cognition/assets/capture\'');
  });
});

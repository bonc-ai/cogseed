import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 迁移守卫：`POST /marketplace/skills/bundle`（A-02）当前仍被当作 metadata/detail
 * 接口使用的**全部**位置。
 *
 * A-02 按 F4 收口后只回不可变字节、不再回 JSON，因此每一处都必须迁走：
 * 元信息迁到 `metadata-adapter.ts`，取字节迁到 Phase 2 的 `source-fetch.ts`。
 *
 * ⚠️ 本文件锁的是**迁移进度**，不是终态。Phase 2 的 T017 会把它收紧为
 * 「全仓唯一的取字节调用点在 source-fetch.ts」。在此之前，任何新增调用点
 * 都会让本测试变红——这正是目的。
 *
 * 📌 specs/010 的 T012 只列了 `marketplace.ts` 的四处（:818/:947/:1114/:1423）。
 * 实测全仓共 **6 处**，另三处在 `marketplace_reconcile.ts` 与 `builtin_marketplace.ts`，
 * 形态相同（`postJson<{ bundle_url, version, ... }>`）。差额已回写 specs/010。
 */

const SRC = path.resolve(__dirname, '../../../../src');
const ENDPOINT = "'/marketplace/skills/bundle'";

/** **唯一合法**的 A-02 取字节点（FR-008）。这一处不清零，其余都要归零。 */
const SANCTIONED = 'main/features/marketplace/source-fetch.ts';

/**
 * 仍把 A-02 当 metadata/detail 用的调用点。
 *
 * ✅ **2026-09-20 已全部清零**（T012 六处 + T016 后半 + T017）：
 * `marketplace.ts` :818/:1114/:947/:1423、`marketplace_reconcile.ts` :909/:1326、
 * `builtin_marketplace.ts` :903 全部迁至 `metadata-adapter.ts`，字节路径迁至 `source-fetch.ts`。
 * 本表保持为空即为终态；**新增任何一处都会让下面的断言变红**。
 */
const PENDING: Record<string, { count: number; destination: string }> = {};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

function occurrences(file: string): number {
  return fs.readFileSync(file, 'utf8').split(ENDPOINT).length - 1;
}

describe('A-02 兼任 metadata 接口的调用点：迁移守卫', () => {
  const hits = new Map<string, number>();
  for (const file of walk(SRC)) {
    const n = occurrences(file);
    if (n > 0) hits.set(path.relative(SRC, file).split(path.sep).join('/'), n);
  }

  it('调用点集合与已知清单完全一致——新增一处即红', () => {
    const actual = Object.fromEntries([...hits.entries()].sort());
    const expected = Object.fromEntries(
      [[SANCTIONED, 1] as [string, number], ...Object.entries(PENDING).map(([f, { count }]) => [f, count] as [string, number])].sort(),
    );
    expect(actual).toEqual(expected);
  });

  it('合法取字节点存在且唯一：source-fetch.ts 持有该端点常量', () => {
    expect(hits.get(SANCTIONED)).toBe(1);
  });

  it('⭐ T017：A-02 取字节收敛为唯一调用点，误用点归零', () => {
    expect(Object.keys(PENDING)).toEqual([]);
    expect([...hits.keys()]).toEqual([SANCTIONED]);
  });

  it('全仓不存在对象存储直连：产品路径不再出现 downloadMarketplaceBundle(bundle_url)', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = fs.readFileSync(file, 'utf8');
      if (/downloadMarketplaceBundle\([^)]*bundle_url/.test(src)) {
        offenders.push(path.relative(SRC, file).split(path.sep).join('/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('`:947` 依赖 Skill 补装已迁到适配层：不再自带 bundle 调用', () => {
    const src = fs.readFileSync(path.join(SRC, 'main/features/marketplace.ts'), 'utf8');
    // 迁移后该路径经 getSkillMetadata 取元信息。
    expect(src).toContain('const meta = await getSkillMetadata(sid);');
    // 且不再用 _normalizeMarketplaceMinAppVersion 兜 A-02 的原始字段——适配层已归一。
    const depBlock = src.slice(src.indexOf('let depSkillName'), src.indexOf('dep-installed skill'));
    expect(depBlock).not.toContain(ENDPOINT);
    expect(depBlock).not.toContain('_normalizeMarketplaceMinAppVersion');
  });

  it('适配层是 marketplace.ts 的静态依赖，反向依赖必须是函数内动态取值（防装载期循环）', () => {
    const adapter = fs.readFileSync(path.join(SRC, 'main/features/marketplace/metadata-adapter.ts'), 'utf8');
    expect(adapter).not.toMatch(/^import .*from '\.\.\/marketplace';$/m);
    expect(adapter).toContain("await import('../marketplace')");
  });
});

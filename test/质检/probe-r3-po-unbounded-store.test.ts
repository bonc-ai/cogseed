/**
 * 红队探针 r3：个人本体 JSON 单源零容量限额（对照 cognition store 的双上限）。
 *
 * 靶点（读码推演）：
 * - cognition/assets.json 有双重上限：MAX_ASSETS=500 条（index.ts:25）+
 *   COGNITION_STORE_BYTE_LIMIT=8MB（index.ts:24，读写双侧都查）；
 * - personal-ontology.json 的写路径 editPoDoc → writeJson（po/store.ts:235）
 *   **没有任何条数/字节上限**；poAddValue 单条 2000 字符、poAddEntry 4000、
 *   importApply 逐条灌入——限额面完全缺失；
 * - 该文件参与云同步（与 assets.json 同目录同耐久级别），无界增长会拖垮
 *   同步与全量 snapshot 通道（po.snapshot 一次交付整棵）。
 *
 * 预言：连续写入远超 cognition 上限口径的条数与字节均全部成功、无任何拒绝。
 *
 * 2026-09-30 r3 收尾（记账员）：对应待议 P-r3-7（写侧统一门 / 入口增量门 /
 * 组合，条数口径与数值需产品确认；读侧是否硬拒也需定）→ it.skip。断言
 * 锁定的是「现状零限额全写入」，拍板加门后反转。见 round-3-甄别.md。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-user-r3b';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r3b-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function poDocFile(): string {
  return path.join(tmpDir, UID, 'cloud', 'cognition', 'personal-ontology.json');
}

describe('probe r3: 个人本体单源零容量限额（待议 P-r3-7，拍板前 skip）', () => {
  it.skip('600 条 2000 字符值全部写入成功，文档超 cognition 字节上限口径仍照写', async () => {
    const groups = await import('../../src/main/features/personal_ontology_groups');
    const api = await import('../../src/main/features/po/api');

    const created = await groups.createGroup(UID, '限额探针');
    const groupId = created.group!.group_id;
    const field = await api.poCreateField(UID, groupId, '长文本');
    expect(field.ok).toBe(true);
    const fieldId = field.field!.id;

    const longText = '限'.repeat(1900);
    let accepted = 0;
    // 600 条 × 2000 字符 ≈ 1.2MB+ 元数据——条数超 cognition MAX_ASSETS(500)、
    // （加上 JSON 结构）逼近其 8MB 字节口径的 1/6；足以证明零 gate。
    for (let i = 0; i < 600; i += 1) {
      const r = await api.poAddValue(UID, groupId, fieldId, { text: `${longText}#${i}` });
      if (r.ok) accepted += 1;
    }
    expect(accepted).toBe(600);

    const bytes = fs.statSync(poDocFile()).size;
    expect(bytes).toBeGreaterThan(1_200_000); // 1.2MB，全无拒绝
    const doc = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(doc.groups[0].values).toHaveLength(600);
  });
});

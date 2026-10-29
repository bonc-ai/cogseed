/**
 * 本体写入总量边界：与 cognition 单店同口径（8MB）。
 * 限额内大批量写入照常；把文档推过上限的写被拒绝并给可操作错误；
 * 存量超限文档不追溯——不使总量变大的编辑（清理/删减）照常可写。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, emit: () => {}, off: () => {} },
}));
vi.mock('../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'probe-user-r3b';
const LIMIT = 8 * 1024 * 1024;
const T = '2026-09-01T00:00:00Z';

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

function docOf(values: unknown[], title: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    groups: [{
      id: 'g-big', title, kind: 'user',
      fields: [{ id: 'f-big', name: '长文本', origin: 'user', createdAt: T }],
      values, entries: [], createdAt: T, updatedAt: T,
    }],
    trash: [],
  };
}

function compactBytes(values: unknown[], title: string): number {
  return Buffer.byteLength(JSON.stringify(docOf(values, title)), 'utf8');
}

/**
 * 盘上直接种入临界/超限档（不走逐条写路径）：长值（'限'=3 字节 UTF-8，每条
 * ≈5.9KB）粗调到 LIMIT−12KB 以内，再用一条 ASCII 顶部值把余量收敛到 ≈LIMIT−3KB
 *（ASCII 逐字节可控）；mode='over' 再压一条长值越过上限。
 */
function seedCapacityDoc(mode: 'near' | 'over'): { groupId: string; fieldId: string; valueIds: string[] } {
  const longText = '限'.repeat(1900);
  const mk = (i: number, text: string) => ({ id: `vb${i}`, fieldId: 'f-big', text, source: '手动', createdAt: T, updatedAt: T });
  const title = mode === 'near' ? '临界档' : '超限档';
  const values: Array<ReturnType<typeof mk>> = [];
  // 先测单条增量再跳数（避免逐条全量 stringify 的 O(n²)）；再校准至多几条。
  const base = compactBytes(values, title);
  const per = compactBytes([mk(0, `${longText}#0`)], title) - base;
  const count = Math.max(1, Math.floor((LIMIT - 12_000 - base) / per));
  for (let i = 0; i < count; i += 1) values.push(mk(i, `${longText}#${i}`));
  while (compactBytes(values, title) < LIMIT - 12_000) {
    values.push(mk(values.length, `${longText}#${values.length}`));
  }
  const sizeNow = compactBytes(values, title);
  const pad = Math.max(1, LIMIT - sizeNow - 3_000 - 250);
  values.push(mk(values.length, 'x'.repeat(pad)));
  // 超限档多压 6 条长值（≈+35KB）：删一条后仍稳定在限上，增量必被拒。
  if (mode === 'over') {
    for (let k = 0; k < 6; k += 1) values.push(mk(values.length, `${longText}#over${k}`));
  }
  fs.mkdirSync(path.dirname(poDocFile()), { recursive: true });
  fs.writeFileSync(poDocFile(), JSON.stringify(docOf(values, title)), 'utf8');
  return { groupId: 'g-big', fieldId: 'f-big', valueIds: values.map((v) => v.id) };
}

describe('个人本体写入总量门（8MB，与 cognition 同口径）', () => {
  it('限额内大批量写入照常：150 条 1900 字符值全部成功', async () => {
    const groups = await import('../../src/main/features/personal_ontology_groups');
    const api = await import('../../src/main/features/po/api');

    const created = await groups.createGroup(UID, '限额探针');
    const groupId = created.group!.group_id;
    const field = await api.poCreateField(UID, groupId, '长文本');
    expect(field.ok).toBe(true);
    const fieldId = field.field!.id;

    const longText = '限'.repeat(1900);
    let accepted = 0;
    for (let i = 0; i < 150; i += 1) {
      const r = await api.poAddValue(UID, groupId, fieldId, { text: `${longText}#${i}` });
      if (r.ok) accepted += 1;
    }
    expect(accepted).toBe(150);

    const bytes = fs.statSync(poDocFile()).size;
    expect(bytes).toBeGreaterThan(300_000); // 30 万字节量级照写，无误伤
    const doc = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(doc.groups[0].values).toHaveLength(150);
  });

  it('把文档推过 8MB 的写被拒绝并给可操作错误，盘上字节不变', async () => {
    // 盘上种入紧凑口径 ≈LIMIT−3KB 的临界档（余量小于一条长值的增量）。
    const { groupId, fieldId } = seedCapacityDoc('near');
    const bytesBefore = fs.readFileSync(poDocFile(), 'utf8');
    expect(Buffer.byteLength(bytesBefore, 'utf8')).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(bytesBefore, 'utf8')).toBeGreaterThan(LIMIT - 6_000);

    const api = await import('../../src/main/features/po/api');
    const refused = await api.poAddValue(UID, groupId, fieldId, { text: `${'限'.repeat(1900)}#push` });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toContain('exceeds');
    expect(String(refused.error)).toContain('remove or trim');
    // 盘上字节原样（拒绝发生在落盘前）。
    expect(fs.readFileSync(poDocFile(), 'utf8')).toBe(bytesBefore);
  });

  it('存量超限不追溯：删减照常可写，增量仍被拒', async () => {
    // 盘上种入紧凑口径已越过 LIMIT 的超限档。
    const { groupId, fieldId, valueIds } = seedCapacityDoc('over');
    expect(Buffer.byteLength(fs.readFileSync(poDocFile(), 'utf8'), 'utf8')).toBeGreaterThan(LIMIT);

    const api = await import('../../src/main/features/po/api');
    // 清理：删一条值（总量变小）——照常可写，不因存量超限锁死。
    const shrink = await api.poDeleteValue(UID, groupId, valueIds[0]);
    expect(shrink.ok).toBe(true);
    // 增量：再加一条（总量变大）——仍被拒。
    const grow = await api.poAddValue(UID, groupId, fieldId, { text: '还想再长' });
    expect(grow.ok).toBe(false);
    expect(String(grow.error)).toContain('exceeds');
    const doc = JSON.parse(fs.readFileSync(poDocFile(), 'utf8'));
    expect(doc.groups[0].values).toHaveLength(valueIds.length - 1);
  });
});

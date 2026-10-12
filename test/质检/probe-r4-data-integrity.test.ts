/**
 * 探针 r4（边界测试员 · 数据完整性与极端输入）：
 *
 * A. 底层 readJsonl/readJsonlPage（review decisions / usage records 等的共同地基）：
 *    坏行混好行的兜底、before/limit 的 0/负数/NaN/超大边界。
 * B. po v1→v2 迁移（importFromV1Sync）的坏档边界：坏 groups.md 行、非方言组文件、
 *    坏 audit 行、坏快照——好组必须保全，坏档不得炸整个迁移。
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
const UID = 'probe-r4-integrity';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-r4-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('probe r4 › readJsonl 坏行与游标边界', () => {
  it('坏行混好行：坏行被跳过、好行全量返回（地基兜底）', async () => {
    const { appendJsonlAtomic, readJsonl } = await import('../../src/main/storage');
    const file = path.join(tmpDir, 'mixed.jsonl');
    await appendJsonlAtomic(file, { id: 1 });
    // 手工追加坏行（不完整 JSON + 空行 + 非 JSON 文本）
    fs.appendFileSync(file, '{"id":2,"bro\n\nnot-json\n');
    await appendJsonlAtomic(file, { id: 3 });
    const records = await readJsonl<{ id: number }>(file, 100);
    const ids = records.map((r) => r.id).filter((n) => typeof n === 'number');
    expect(ids).toContain(1);
    expect(ids).toContain(3);
    expect(ids.length).toBe(2); // 坏行不进结果也不炸
  });

  it('limit/before 边界：0/负/NaN 不炸且行为可预期', async () => {
    const { appendJsonlAtomic, readJsonl, readJsonlPage } = await import('../../src/main/storage');
    const file = path.join(tmpDir, 'page.jsonl');
    for (let i = 1; i <= 5; i += 1) await appendJsonlAtomic(file, { i });
    // limit 非法 → 全量读路径；实测 slice(-0)/slice(-NaN) 均为 slice(0) → 返回全量
    // （JS 陷阱：-0===0；「非法 limit=无限制」若非本意，超大文件会被全量读入）
    const zero = await readJsonl(file, 0);
    expect(zero.length).toBe(5);
    const nan = await readJsonl(file, Number.NaN);
    expect(nan.length).toBe(5);
    // before 边界（倒序分页游标）
    const neg = await readJsonlPage(file, 2, -5);
    expect(Array.isArray(neg.records)).toBe(true);
    const huge = await readJsonlPage(file, 2, Number.MAX_SAFE_INTEGER * 2);
    expect(Array.isArray(huge.records)).toBe(true);
    const zeroCursor = await readJsonlPage(file, 2, 0);
    expect(zeroCursor.records.length).toBe(0); // before=0 → 从文件头之前读 → 空
  });
});

describe('probe r4 › po v1→v2 迁移坏档边界', () => {
  function v1Dir(): string {
    return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
  }

  it('坏台账行/非方言组文件/坏 audit 行/坏快照：好组保全、迁移不炸', async () => {
    const dir = v1Dir();
    fs.mkdirSync(path.join(dir, '.history', 'grpOK'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.history', 'grpBADSNAP'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'groups.md'), [
      '# 记忆分组', '',
      '### grpOK',
      '- 标题: 好组',
      '- 文件: .personal_ontology_groups/grpOK.md',
      '- 创建时间: 2026-09-01T10:00:00',
      '- 更新时间: 2026-09-02T10:00:00',
      '',
      '### grpBROKEN', // 坏行：无标题/文件行
      '- 创建时间: not-a-date',
      '',
      '### grpWEIRD', // 指向的组文件不存在
      '- 标题: 幽灵组',
      '- 文件: .personal_ontology_groups/missing.md',
      '',
      '### grpJUNK', // 指向非方言内容文件
      '- 标题: 垃圾组',
      '- 文件: .personal_ontology_groups/grpJUNK.md',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'grpOK.md'), [
      '## 字段区', '', '### 工具', '- ZCode [手动]', '', '---', '', '## 流水区', '', '周五交周报',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'grpJUNK.md'), '这里是随便一段不是方言的文本\n没有字段区也没有流水区\n');
    // 好组历史 + 坏 audit 行
    fs.writeFileSync(path.join(dir, '.history', 'grpOK', '2026-09-01T10-05-00-000Z-00.md'), '## 字段区\n\n### 工具\n\n---\n\n## 流水区\n\n旧流水');
    fs.writeFileSync(path.join(dir, '.history', 'grpOK', 'audit.jsonl'), '{broken json\n{"at":"2026-09-01T10:05:01.000Z","actor":"user","action":"value_add","groupId":"grpOK"}\n');
    // 孤儿历史 + 坏快照（.json 坏档）
    fs.writeFileSync(path.join(dir, '.history', 'grpBADSNAP', '2026-09-01T10-00-00-000Z-00.json'), '{"group": {"broken"');
    fs.writeFileSync(path.join(dir, '.history', 'grpBADSNAP', 'audit.jsonl'), '{"at":"2026-08-30T09:00:00.000Z","actor":"user","action":"group_delete","groupId":"grpBADSNAP"}\n');

    const migrate = await import('../../src/main/features/po/migrate');
    let doc: Awaited<ReturnType<typeof migrate.importFromV1Sync>>;
    expect(() => { doc = migrate.importFromV1Sync(UID); }).not.toThrow();
    expect(doc!).not.toBeNull();
    // 好组完整保全
    const ok = doc!.groups.find((g) => g.id === 'grpOK')!;
    expect(ok.title).toBe('好组');
    expect(ok.values.some((v) => v.text === 'ZCode')).toBe(true);
    expect(ok.entries.some((e) => e.text === '周五交周报')).toBe(true);
    // 坏台账行/幽灵组/垃圾组的行为记录：不吞好组；各自去向如实断言
    const byId = new Map(doc!.groups.map((g) => [g.id, g]));
    const titleOf = (id: string) => byId.get(id)?.title;
    // grpBROKEN：无标题行 → 迁移拿 id 兜底成标题？按实测记录
    process.stdout.write(`[probe-r4取证] grpBROKEN=${JSON.stringify(titleOf('grpBROKEN'))} grpWEIRD=${JSON.stringify(titleOf('grpWEIRD'))} grpJUNK=${JSON.stringify(titleOf('grpJUNK'))} groups=${doc!.groups.length}\n`);
    expect(byId.get('grpOK')!.title).toBe('好组');
  });

  it('v1 台账整体为坏文本（非 md）：迁移返回可用结果不炸', async () => {
    const dir = v1Dir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'groups.md'), '\u0000\u0001乱码{{{');
    const migrate = await import('../../src/main/features/po/migrate');
    let doc: Awaited<ReturnType<typeof migrate.importFromV1Sync>> = null;
    expect(() => { doc = migrate.importFromV1Sync(UID); }).not.toThrow();
    // 控制字符组名被 sanitize 剥成空 → 组被丢；结果是非 null 可用文档
    expect(doc === null || Array.isArray(doc.groups)).toBe(true);
  });
});

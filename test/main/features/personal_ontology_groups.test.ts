import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Mocks kb_indexer + search so the module load doesn't pull in
 * fastembed/sqlite-vec (same pattern as contexts.test.ts) — we're testing
 * the group storage contract here, not indexer behaviour.
 */

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-groups';

const kbEnqueueCalls: Array<{ userId: string; relPath: string; op: string }> = [];
vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: (userId: string, relPath: string, op = 'upsert') => {
    kbEnqueueCalls.push({ userId, relPath, op });
  },
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));

const searchCalls: Array<{ action: string; userId: string; path: string }> = [];
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: (userId: string, path: string) => {
    searchCalls.push({ action: 'upsert', userId, path });
  },
  dropContext: (userId: string, path: string) => {
    searchCalls.push({ action: 'drop', userId, path });
  },
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-onto-groups-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  kbEnqueueCalls.length = 0;
  searchCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return import('../../../src/main/features/personal_ontology_groups');
}

function groupsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

describe('personal_ontology_groups › listGroups', () => {
  it('returns empty array when nothing exists yet', async () => {
    const groups = await loadModule();
    expect(await groups.listGroups(UID)).toEqual([]);
  });

  it('rejects an invalid uid', async () => {
    const groups = await loadModule();
    await expect(groups.listGroups('../evil')).rejects.toThrow(/invalid uid/);
  });
});

describe('personal_ontology_groups › createGroup', () => {
  it('creates a group with metadata + an empty content file, hidden under contexts/', async () => {
    const groups = await loadModule();
    const res = await groups.createGroup(UID, '工作偏好');
    expect(res.ok).toBe(true);
    expect(res.group?.title).toBe('工作偏好');
    expect(res.group?.group_id).toBeTruthy();

    const listed = await groups.listGroups(UID);
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe('工作偏好');

    // Content file exists, physically under the hidden contexts/ sub-dir.
    const contentPath = path.join(groupsDir(), `${res.group!.group_id}.md`);
    expect(fs.existsSync(contentPath)).toBe(true);
    expect(fs.readFileSync(contentPath, 'utf8')).toBe('');

    // The whole directory is dot-prefixed — outside the visible Library tree.
    expect(res.group?.rel_path.startsWith('.personal_ontology_groups/')).toBe(true);
  });

  it('rejects an empty title', async () => {
    const groups = await loadModule();
    const res = await groups.createGroup(UID, '   ');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/title/);
  });
});

describe('personal_ontology_groups › renameGroup', () => {
  it('updates the title and updated_at, leaves content untouched', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'old title');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, 'some content');

    const res = await groups.renameGroup(UID, groupId, 'new title');
    expect(res.ok).toBe(true);

    const listed = await groups.listGroups(UID);
    expect(listed[0].title).toBe('new title');
    const content = await groups.readGroupContent(UID, groupId);
    expect(content.content).toBe('some content');
  });

  it('returns an error for an unknown group id', async () => {
    const groups = await loadModule();
    const res = await groups.renameGroup(UID, 'does-not-exist', 'x');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

describe('personal_ontology_groups › deleteGroup', () => {
  it('removes the metadata record AND the content file', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'to delete');
    const groupId = created.group!.group_id;
    const contentPath = path.join(groupsDir(), `${groupId}.md`);
    expect(fs.existsSync(contentPath)).toBe(true);

    const res = await groups.deleteGroup(UID, groupId);
    expect(res.ok).toBe(true);
    expect(await groups.listGroups(UID)).toEqual([]);
    expect(fs.existsSync(contentPath)).toBe(false);
  });
});

describe('personal_ontology_groups › read/write content', () => {
  it('writeGroupContent overwrites the whole file', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'g1');
    const groupId = created.group!.group_id;

    await groups.writeGroupContent(UID, groupId, 'first version');
    expect((await groups.readGroupContent(UID, groupId)).content).toBe('first version');

    await groups.writeGroupContent(UID, groupId, 'second version');
    expect((await groups.readGroupContent(UID, groupId)).content).toBe('second version');
  });

  it('readGroupContent errors on an unknown group id', async () => {
    const groups = await loadModule();
    const res = await groups.readGroupContent(UID, 'nope');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

describe('personal_ontology_groups › appendToGroup', () => {
  it('appends with the § separator convention, unlimited by char count', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'g1');
    const groupId = created.group!.group_id;

    const r1 = await groups.appendToGroup(UID, groupId, 'first note');
    expect(r1.ok).toBe(true);
    const r2 = await groups.appendToGroup(UID, groupId, 'second note');
    expect(r2.ok).toBe(true);

    const content = (await groups.readGroupContent(UID, groupId)).content;
    expect(content).toBe('first note\n§\nsecond note');
  });

  it('a very large append still succeeds (no char-limit gate, only MAX_FILE_BYTES)', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'g1');
    const groupId = created.group!.group_id;

    // Comfortably larger than USER_CHAR_LIMIT/MEMORY_CHAR_LIMIT — groups don't
    // share that budget.
    const big = 'x'.repeat(20000);
    const res = await groups.appendToGroup(UID, groupId, big);
    expect(res.ok).toBe(true);
    expect((await groups.readGroupContent(UID, groupId)).content).toBe(big);
  });

  it('rejects empty text', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'g1');
    const res = await groups.appendToGroup(UID, created.group!.group_id, '   ');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty/);
  });

  it('errors on an unknown group id', async () => {
    const groups = await loadModule();
    const res = await groups.appendToGroup(UID, 'nope', 'text');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});

describe('personal_ontology_groups › isolation + kb-index side effects', () => {
  it('different users have separate group pools', async () => {
    const groups = await loadModule();
    await groups.createGroup('alice', 'alice group');
    await groups.createGroup('bob', 'bob group');
    expect((await groups.listGroups('alice')).map((g) => g.title)).toEqual(['alice group']);
    expect((await groups.listGroups('bob')).map((g) => g.title)).toEqual(['bob group']);
  });

  it('createGroup does not itself trigger a kb reindex (only content writes do)', async () => {
    const groups = await loadModule();
    await groups.createGroup(UID, 'g1');
    expect(kbEnqueueCalls).toEqual([]);
    expect(searchCalls).toEqual([]);
  });

  it('writeGroupContent triggers kb_indexer enqueue + search upsert on the hidden rel path', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'g1');
    const groupId = created.group!.group_id;
    await groups.writeGroupContent(UID, groupId, 'content');
    expect(kbEnqueueCalls).toContainEqual({ userId: UID, relPath: `.personal_ontology_groups/${groupId}.md`, op: 'upsert' });
    expect(searchCalls).toContainEqual({ action: 'upsert', userId: UID, path: `.personal_ontology_groups/${groupId}.md` });
  });

  it('appendToGroup triggers kb_indexer enqueue + search upsert', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'g1');
    const groupId = created.group!.group_id;
    await groups.appendToGroup(UID, groupId, 'text');
    expect(kbEnqueueCalls).toContainEqual({ userId: UID, relPath: `.personal_ontology_groups/${groupId}.md`, op: 'upsert' });
  });

  it('deleteGroup triggers kb_indexer enqueue delete + search drop', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup(UID, 'g1');
    const groupId = created.group!.group_id;
    await groups.deleteGroup(UID, groupId);
    expect(kbEnqueueCalls).toContainEqual({ userId: UID, relPath: `.personal_ontology_groups/${groupId}.md`, op: 'delete' });
    expect(searchCalls).toContainEqual({ action: 'drop', userId: UID, path: `.personal_ontology_groups/${groupId}.md` });
  });
});

// ── 模板元数据台账 ────────────────────────────────────────────────────────

describe('personal_ontology_groups › groups.md template line', () => {
  it('parse/serialize round-trips the optional 模板 row', async () => {
    const groups = await loadModule();
    const text = [
      '# 记忆分组',
      '',
      '> 最后更新: 2026-08-03T00:00:00 | 共 1 个分组',
      '',
      '### abc123',
      '- 标题: 课程',
      '- 文件: .personal_ontology_groups/abc123.md',
      '- 创建时间: 2026-08-03T00:00:00',
      '- 更新时间: 2026-08-03T00:00:00',
      '- 模板: student@0.2.0-review.1',
      '',
    ].join('\n');
    const parsed = groups.parseGroupsMarkdown(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].template_id).toBe('student');
    expect(parsed[0].template_version).toBe('0.2.0-review.1');
    expect(groups.serializeGroupsMarkdown(parsed)).toContain('- 模板: student@0.2.0-review.1');
  });

  it('illegal template_ref is tolerated as no-template', async () => {
    const groups = await loadModule();
    const text = [
      '### abc123',
      '- 标题: 课程',
      '- 模板: bad ref!!',
      '',
    ].join('\n');
    const parsed = groups.parseGroupsMarkdown(text);
    expect(parsed[0].template_id).toBeUndefined();
    expect(parsed[0].template_version).toBeUndefined();
  });

  it('no template row → template fields undefined', async () => {
    const groups = await loadModule();
    const parsed = groups.parseGroupsMarkdown('### abc123\n- 标题: 课程\n');
    expect(parsed[0].template_id).toBeUndefined();
  });
});

describe('personal_ontology_groups › @asof field value marker', () => {
  it('parses a lone asof marker', async () => {
    const groups = await loadModule();
    const parsed = groups.parseFieldValueLine('- 目前大四 [手动] @asof:2026-09');
    expect(parsed).toEqual({ value: '目前大四', source: '手动', asOf: '2026-09' });
  });

  it('parses proj + asof markers in both orders', async () => {
    const groups = await loadModule();
    expect(groups.parseFieldValueLine('- 值 [智能] @proj:p1 @asof:2026-09'))
      .toEqual({ value: '值', source: '智能', project: 'p1', asOf: '2026-09' });
    expect(groups.parseFieldValueLine('- 值 [智能] @asof:2026-09 @proj:p1'))
      .toEqual({ value: '值', source: '智能', project: 'p1', asOf: '2026-09' });
  });

  it('legacy single proj marker still parses unchanged', async () => {
    const groups = await loadModule();
    expect(groups.parseFieldValueLine('- 值 [手动] @proj:p1'))
      .toEqual({ value: '值', source: '手动', project: 'p1' });
    expect(groups.parseFieldValueLine('- 值 [手动]'))
      .toEqual({ value: '值', source: '手动' });
  });

  it('malformed asof is ignored, never promoted to project', async () => {
    const groups = await loadModule();
    // 13 月 / 9 月补零缺失 / 非 asof 前缀杂项：前者忽略，后者保留原样（原行为）
    expect(groups.parseFieldValueLine('- 值 [手动] @asof:2026-13'))
      .toEqual({ value: '值', source: '手动' });
    expect(groups.parseFieldValueLine('- 值 [手动] @asof:2026-9'))
      .toEqual({ value: '值', source: '手动' });
    expect(groups.parseFieldValueLine('- 值 [手动] @weird:x'))
      .toEqual({ value: '值', source: '手动', project: 'weird:x' });
  });

  it('serialize round-trips value + source + proj + asof', async () => {
    const groups = await loadModule();
    const line = groups.serializeFieldValueLine({ value: '值[含括号', source: '导入', project: 'p1', asOf: '2026-09' });
    expect(line).toBe('- 值\\[含括号 [导入] @proj:p1 @asof:2026-09');
    expect(groups.parseFieldValueLine(line))
      .toEqual({ value: '值[含括号', source: '导入', project: 'p1', asOf: '2026-09' });
    expect(groups.serializeFieldValueLine({ value: '值', source: '手动' })).toBe('- 值 [手动]');
  });

  it('isStaleAsOf: exactly 12 months is fresh, 13 is stale, invalid never flags', async () => {
    const groups = await loadModule();
    const now = new Date('2027-10-05T00:00:00Z');
    expect(groups.isStaleAsOf('2026-10', now)).toBe(false); // 恰 12 个月
    expect(groups.isStaleAsOf('2026-09', now)).toBe(true);  // 13 个月
    expect(groups.isStaleAsOf('2025-01', now)).toBe(true);  // 跨年远期
    expect(groups.isStaleAsOf('2027-10', now)).toBe(false); // 当月
    expect(groups.isStaleAsOf('2026-13', now)).toBe(false); // 非法输入不制造噪音
    expect(groups.isStaleAsOf(undefined, now)).toBe(false);
  });
});

describe('personal_ontology_groups › @verified field value marker', () => {
  it('parses the bare verified marker alone and combined with proj + asof', async () => {
    const groups = await loadModule();
    expect(groups.parseFieldValueLine('- 常住北京 [手动] @verified'))
      .toEqual({ value: '常住北京', source: '手动', verified: true });
    expect(groups.parseFieldValueLine('- 值 [智能] @proj:p1 @asof:2026-09 @verified'))
      .toEqual({ value: '值', source: '智能', project: 'p1', asOf: '2026-09', verified: true });
    // verified 是裸标记：不许掉进 project（误当项目 id）
    expect(groups.parseFieldValueLine('- 值 [手动] @verified').project).toBeUndefined();
  });

  it('serialize round-trips verified with all other markers', async () => {
    const groups = await loadModule();
    const line = groups.serializeFieldValueLine({ value: '值', source: '导入', project: 'p1', asOf: '2026-09', verified: true });
    expect(line).toBe('- 值 [导入] @proj:p1 @asof:2026-09 @verified');
    expect(groups.parseFieldValueLine(line))
      .toEqual({ value: '值', source: '导入', project: 'p1', asOf: '2026-09', verified: true });
    expect(groups.serializeFieldValueLine({ value: '值', source: '手动' })).toBe('- 值 [手动]');
  });

  it('setFieldValueVerified toggles without touching other markers, and is idempotent', async () => {
    const groups = await loadModule();
    const created = await groups.createGroup('test-user-groups', '核实档组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue('test-user-groups', gid, '居住地', '常住北京', '手动', 'p1', '2026-09');

    const on = await groups.setFieldValueVerified('test-user-groups', gid, '居住地', '常住北京', true);
    expect(on.ok).toBe(true);
    let fields = await groups.listGroupFields('test-user-groups', gid);
    expect(fields.fields?.[0].values[0])
      .toMatchObject({ value: '常住北京', source: '手动', project: 'p1', asOf: '2026-09', verified: true });

    // 再点一次（幂等）与取消：其余标记原样保留
    await groups.setFieldValueVerified('test-user-groups', gid, '居住地', '常住北京', true);
    const off = await groups.setFieldValueVerified('test-user-groups', gid, '居住地', '常住北京', false);
    expect(off.ok).toBe(true);
    fields = await groups.listGroupFields('test-user-groups', gid);
    expect(fields.fields?.[0].values[0])
      .toMatchObject({ value: '常住北京', source: '手动', project: 'p1', asOf: '2026-09' });
    expect(fields.fields?.[0].values[0].verified).toBeUndefined();

    const missing = await groups.setFieldValueVerified('test-user-groups', gid, '居住地', '不存在的值', true);
    expect(missing.ok).toBe(false);
  });

  it('independent tier round-trips and cycles: none → source → independent → none', async () => {
    const groups = await loadModule();
    // 落盘解析：两档 marker 各自认出，裸标兼容
    expect(groups.parseFieldValueLine('- 值 [手动] @verified:independent'))
      .toEqual({ value: '值', source: '手动', verified: 'independent' });
    const line = groups.serializeFieldValueLine({ value: '值', source: '导入', verified: 'independent' });
    expect(line).toBe('- 值 [导入] @verified:independent');
    expect(groups.parseFieldValueLine(line)).toEqual({ value: '值', source: '导入', verified: 'independent' });
    // 裸标记仍是 source 档（存量兼容），不被 independent 覆盖
    expect(groups.parseFieldValueLine('- 值 [手动] @verified').verified).toBe(true);

    // toggle 三态：none → source → independent → none
    const created = await groups.createGroup('test-user-groups', '两档核实组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue('test-user-groups', gid, '居住地', '常住北京', '手动');
    await groups.setFieldValueVerified('test-user-groups', gid, '居住地', '常住北京', true);
    let fields = await groups.listGroupFields('test-user-groups', gid);
    expect(fields.fields?.[0].values[0].verified).toBe(true);
    await groups.setFieldValueVerified('test-user-groups', gid, '居住地', '常住北京', 'independent');
    fields = await groups.listGroupFields('test-user-groups', gid);
    expect(fields.fields?.[0].values[0].verified).toBe('independent');
    await groups.setFieldValueVerified('test-user-groups', gid, '居住地', '常住北京', false);
    fields = await groups.listGroupFields('test-user-groups', gid);
    expect(fields.fields?.[0].values[0].verified).toBeUndefined();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  detachMemorySource,
  ensureRoleTemplateMemoryRecord,
  ensureSourcedMemoryRecord,
  loadMemoryRecords,
  memoryContentHash,
  serializeMemoryRecords,
} from '../../../src/main/features/memory-records';

// 来源剥离须同时匹配 kind 与 sourceId，不能误删同名的角色模板来源。
// 用序列化器构造双源旧记录，验证剥离一个来源后其他来源和正文仍保留。

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-mem-records-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('memory-records › detachMemorySource kind scoping', () => {
  it('只剥同 kind 来源：与 cognition_asset 撞 sourceId 的 role_template 存量记录不受波及', () => {
    const file = path.join(tmpDir, 'MEMORY.md');
    const roleText = '模板带进来的工作习惯。';
    const cogText = '认知资产投影的结论。';
    const roleRecord = {
      recordId: 'mem_0000000000000001',
      text: roleText,
      contentSha256: memoryContentHash(roleText),
      independent: false,
      sources: [{ kind: 'role_template' as const, sourceId: 'shared_1' }],
    };
    const cogRecord = {
      recordId: 'mem_0000000000000002',
      text: cogText,
      contentSha256: memoryContentHash(cogText),
      independent: false,
      sources: [{ kind: 'cognition_asset' as const, sourceId: 'shared_1' }],
    };
    fs.writeFileSync(file, serializeMemoryRecords([roleRecord, cogRecord]), 'utf8');

    const result = detachMemorySource(file, 'shared_1', 10_000, 'cognition_asset');

    expect(result.ok).toBe(true);
    expect(result.detachedSourceIds).toEqual(['shared_1']);
    const kept = loadMemoryRecords(file);
    expect(kept.map((record) => record.text)).toEqual([roleText]);
    expect(kept[0].sources).toEqual([{ kind: 'role_template', sourceId: 'shared_1' }]);
  });

  it('kind 不匹配时不改文件：role_template 来源对 cognition_asset 剥离请求不可见', () => {
    const file = path.join(tmpDir, 'role-templates', 'tpl_9.md');
    expect(ensureRoleTemplateMemoryRecord(file, 'tpl_9', '模板记忆。', 10_000).ok).toBe(true);
    const before = fs.readFileSync(file, 'utf8');

    const result = detachMemorySource(file, 'tpl_9', 10_000, 'cognition_asset');

    expect(result.ok).toBe(true);
    expect(result.detachedSourceIds).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(loadMemoryRecords(file)).toHaveLength(1);
  });

  it('kind 匹配时维持原剥除语义：剥空且非 independent 的记录删除，剩余来源的记录保留', () => {
    const file = path.join(tmpDir, 'MEMORY.md');
    expect(ensureSourcedMemoryRecord(file, 'cog_a', '认知投影。', 10_000).ok).toBe(true);
    // 同文本再挂 role_template 来源：剥离 cognition_asset 后记录须保留且剩该来源。
    expect(ensureRoleTemplateMemoryRecord(file, 'tpl_b', '认知投影。', 10_000).ok).toBe(true);
    expect(ensureSourcedMemoryRecord(file, 'cog_solo', '只有认知来源的投影。', 10_000).ok).toBe(true);
    expect(ensureRoleTemplateMemoryRecord(file, 'tpl_c', '纯模板记忆。', 10_000).ok).toBe(true);

    // 剥唯一来源（剥空且非 independent）→ 整条记录删除。
    const solo = detachMemorySource(file, 'cog_solo', 10_000, 'cognition_asset');
    expect(solo.ok).toBe(true);
    expect(solo.detachedSourceIds).toEqual(['cog_solo']);
    expect(loadMemoryRecords(file).map((record) => record.text))
      .toEqual(['认知投影。', '纯模板记忆。']);

    // 剥多来源记录中的一个来源 → 记录保留且只剩 role_template 来源。
    const shared = detachMemorySource(file, 'cog_a', 10_000, 'cognition_asset');
    expect(shared.ok).toBe(true);
    expect(shared.detachedSourceIds).toEqual(['cog_a']);
    const records = loadMemoryRecords(file);
    expect(records.map((record) => record.text)).toEqual(['认知投影。', '纯模板记忆。']);
    expect(records[0].sources).toEqual([{ kind: 'role_template', sourceId: 'tpl_b' }]);
    expect(records[1].sources).toEqual([{ kind: 'role_template', sourceId: 'tpl_c' }]);
  });
});

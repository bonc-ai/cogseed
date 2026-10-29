/** 同模板双源旧记忆可有多条不同正文，恢复时可能仅部分成功。
 * 存储的同源单条约束保持不变，只有全部记忆和组数据恢复成功才清归档；
 * 部分失败保留归档，确保未恢复正文仍可取回。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let CATALOG: any[] = [];

vi.mock('../../src/main/features/role_templates', () => ({
  listRoleTemplates: () => JSON.parse(JSON.stringify(CATALOG)),
  getRoleTemplate: (id: string) => {
    const found = CATALOG.find((t) => t.template_id === id);
    return found ? JSON.parse(JSON.stringify(found)) : undefined;
  },
  listScenarios: () => [],
  getScenario: () => undefined,
}));
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
const UID = 'probe-user-memloss-r3';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-probe-memloss-r3-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  CATALOG = [{
    template_id: 'probe',
    name: '探针角色',
    description: '',
    version: '1.0.0',
    preset_groups: [{ id: 'background', title: '学习背景', fields: [{ id: 'major', name: '专业' }] }],
    bundle: { skill_ids: [], agent_ids: [] },
  }];
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const { userMemoryFile, userProfileFile } = await import('../../src/main/paths');
  const memory = await import('../../src/main/features/memory');
  const templates = await import('../../src/main/features/personal_ontology_template_files');
  const { serializeMemoryRecords, memoryContentHash, listRoleTemplateMemoryTexts } =
    await import('../../src/main/features/memory-records');
  return { userMemoryFile, userProfileFile, memory, templates, serializeMemoryRecords, memoryContentHash, listRoleTemplateMemoryTexts };
}

function sourcedRecord(hexSuffix: string, text: string) {
  return {
    // SAFE_RECORD_ID = /^mem_[a-f0-9]{16}$/（memory-records.ts:11）——探针按
    // 真实 id 域生成（纯 hex 16 位），否则 parseHeader 判非法隔离。
    recordId: `mem_${hexSuffix.padEnd(16, '0').slice(0, 16)}`,
    text,
    contentSha256: memoryContentHashOf(text),
    independent: false,
    sources: [{ kind: 'role_template', sourceId: 'probe' }],
  } as any;
}

// hash 计算延迟绑定（须在动态 import 之后取同一模块实现）。
let memoryContentHashOf: (text: string) => string = () => '';

describe('模板记忆的部分恢复与归档保留', () => {
  it('对照组：单源单条 → 卸载归档 → 重装完整恢复', async () => {
    const s = await setup();
    memoryContentHashOf = s.memoryContentHash;
    expect((await s.templates.installTemplateFile(UID, 'probe')).ok).toBe(true);

    // legacy USER.md 一条该模板的记忆。
    fs.mkdirSync(path.dirname(s.userProfileFile(UID)), { recursive: true });
    fs.writeFileSync(s.userProfileFile(UID), s.serializeMemoryRecords([sourcedRecord('a1', '对照组记忆单条')]), 'utf8');

    const un = await s.templates.uninstallTemplateFile(UID, 'probe', true);
    expect(un.ok).toBe(true);
    expect(un.archived_memory_count).toBe(1);

    const re = await s.templates.installTemplateFile(UID, 'probe', true);
    expect(re.ok).toBe(true);
    expect(re.restored_memory_count).toBe(1);
    // 活独立文件完整恢复、归档已清（正常语义）。
    const own = s.memory.roleTemplateMemoryFile(UID, 'probe');
    expect(fs.readFileSync(own, 'utf8')).toContain('对照组记忆单条');
    expect(s.templates.readTemplateMemoryArchive(UID, 'probe')).toBeNull();
  });

  it('双源两条不同文本 → 卸载归档两条 → 重装只回一条，归档保留（Y 不再永久丢失）', async () => {
    const s = await setup();
    memoryContentHashOf = s.memoryContentHash;
    expect((await s.templates.installTemplateFile(UID, 'probe')).ok).toBe(true);

    // legacy 双源：USER.md 一条 X、MEMORY.md 一条 Y（同模板、不同文本——
    // collect 的文本去重（seen.has(text)）拦不住不同文本）。
    fs.mkdirSync(path.dirname(s.userProfileFile(UID)), { recursive: true });
    fs.writeFileSync(s.userProfileFile(UID), s.serializeMemoryRecords([sourcedRecord('b1', '双源记忆X-用户画像侧')]), 'utf8');
    fs.writeFileSync(s.userMemoryFile(UID), s.serializeMemoryRecords([sourcedRecord('c1', '双源记忆Y-共享记忆侧')]), 'utf8');

    // 卸载（归档记忆）：collect 双源两条都进归档。
    const un = await s.templates.uninstallTemplateFile(UID, 'probe', true);
    expect(un.ok).toBe(true);
    expect(un.archived_memory_count).toBe(2);
    const archived = fs.readFileSync(path.join(un.archive_dir!, 'probe.memory.md'), 'utf8');
    expect(archived).toContain('双源记忆X-用户画像侧');
    expect(archived).toContain('双源记忆Y-共享记忆侧');

    // 重装（恢复原数据）：restore 逐条写同一独立文件——第一条成功，第二条
    // 被 ensureSourcedMemoryRecordWithKind 的 source_content_mismatch 拒绝
    // （同源单条硬约束维持，写入侧契约用例继续锁定）。
    const re = await s.templates.installTemplateFile(UID, 'probe', true);
    expect(re.ok).toBe(true);
    expect(re.restored_memory_count).toBe(1);

    const own = s.memory.roleTemplateMemoryFile(UID, 'probe');
    const live = fs.readFileSync(own, 'utf8');
    expect(live).toContain('双源记忆X-用户画像侧');
    expect(live).not.toContain('双源记忆Y-共享记忆侧'); // Y 恢复失败

    // 修复后断言（原探针断言「归档被清=Y 永久丢失」为漏洞，已反转）：
    // 恢复未全成功 → 归档保留，Y 仍在盘上（重装可再试），不再永久丢失。
    const kept = s.templates.readTemplateMemoryArchive(UID, 'probe');
    expect(kept).not.toBeNull();
    expect([...(kept!.user || []), ...(kept!.memory || [])]).toContain('双源记忆Y-共享记忆侧');
  });

  it('事实基础（写入侧契约）：同模板第二条不同文本直接被拒——「同源单条」存储模型在场', async () => {
    const s = await setup();
    memoryContentHashOf = s.memoryContentHash;
    const first = s.memory.addRoleTemplateMemoryEntry(UID, 'user', 'probe', '第一条记忆文本');
    expect(first.ok).toBe(true);
    const second = s.memory.addRoleTemplateMemoryEntry(UID, 'user', 'probe', '第二条不同的记忆文本');
    // 同 (kind=role_template, sourceId=probe) 已挂第一条 → 不同文本直接
    // source_content_mismatch 拒绝——归档/恢复管线的多条数组契约与此冲突。
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain('source_content_mismatch');
  });
});

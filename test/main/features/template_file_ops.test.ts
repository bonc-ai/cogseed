import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 模板文件 ops：安装（installTemplateFile）、复合 id 读取（readContentById）、
 * 分节字段/流水写入（appendFieldValueToRef / appendFlowEntryToRef）、
 * 流水升格（promoteEntryToRef）、字段清单（listFieldsByRef）测试。
 */

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

// ── F-r1-12 测试缝（默认全透传，不影响其他用例）────────────────────────────
// ① mock fileEditLock：beforeLock 可在「被测函数的 editPoDoc 拿锁执行前」注入
//    一次他方经锁的写值，精确复现「锁外读组 → 归档落盘 → 锁内删组」窗口内的
//    并发提交；afterLock 可在「第一次锁释放后」注入一次他方完整操作，复现
//    「主落盘完成后、后续步骤执行前」的合法串行序交错（F-r3-8）。
const hookState = vi.hoisted(() => ({
  beforeLock: null as null | (() => Promise<void>),
  afterLock: null as null | (() => Promise<void>),
}));
vi.mock('../../../src/main/util/locks', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/main/util/locks')>();
  return {
    ...orig,
    fileEditLock: (absPath: string) => {
      const mutex = orig.fileEditLock(absPath);
      const wrapped = Object.create(mutex) as typeof mutex;
      (wrapped as unknown as { runExclusive: typeof mutex.runExclusive }).runExclusive = (fn, ...rest) => {
        if (hookState.beforeLock) {
          const hook = hookState.beforeLock;
          hookState.beforeLock = null; // 防递归：注入写自身也走同一把锁
          return hook().then(() => mutex.runExclusive(fn, ...rest));
        }
        const p = mutex.runExclusive(fn, ...rest);
        if (hookState.afterLock) {
          const hook = hookState.afterLock;
          hookState.afterLock = null; // 用后即清：只在第一次锁释放后触发
          return p.then(async (v) => { await hook(); return v; });
        }
        return p;
      };
      return wrapped;
    },
  };
});
// ② mock writeTextAtomicSync：可让 `_backup_` 归档目录的写入抛错，验证
//    「归档写失败 → 卸载中止且组保留」。
const archiveFail = vi.hoisted(() => ({ failArchiveWrite: false }));
// ②b mock writeJson：可让个人本体文档落盘抛错，验证「installTemplateFile
//     落盘失败 → 归档保留、重试仍可恢复」。故障注入走模块缝而不是 fs.chmod：
//     Windows 的目录权限位不参与写访问判定（chmod 0o555 之后写入照常成功），
//     只有 POSIX 才能用只读目录制造 EACCES。
const poDocFail = vi.hoisted(() => ({ failWrite: false }));
vi.mock('../../../src/main/storage', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/main/storage')>();
  return {
    ...orig,
    writeJson: async (filePath: string, data: unknown, isCurrent?: () => boolean) => {
      if (poDocFail.failWrite && path.basename(filePath) === 'personal-ontology.json') {
        throw new Error('simulated po document write failure');
      }
      return orig.writeJson(filePath, data, isCurrent);
    },
    writeTextAtomicSync: (filePath: string, text: string | Buffer, encoding?: BufferEncoding) => {
      if (archiveFail.failArchiveWrite && path.basename(path.dirname(filePath)).startsWith('_backup_')) {
        throw new Error('simulated archive write failure');
      }
      return orig.writeTextAtomicSync(filePath, text, encoding);
    },
  };
});

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-tmpl-ops';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-tmpl-ops-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import('../../../src/main/features/personal_ontology_template_files');
}

function groupsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

function readFile(rel: string): string {
  return fs.readFileSync(path.join(groupsDir(), rel), 'utf8');
}

describe('template_file_ops › installTemplateFile', () => {
  it('creates <template_id>.md with all sections + empty pits, and a ledger row', async () => {
    const m = await loadMod();
    const res = await m.installTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.already_installed).toBeUndefined();
    expect(res.created).toHaveLength(1);
    expect(res.created![0].template_id).toBe('student');

    const fileText = readFile('student.md');
    expect(fileText).toContain('# 学生（模板）');
    expect(fileText).toContain('> 模板: student@0.2.0-review.1');
    // 全部分节 + 全部空坑落盘
    for (const section of ['学习背景', '目标与节奏', '时间与约束', '掌握状态', '学术诚信', '学期与课程', '任务与期限', '材料与掌握', '计划与记录', '协作关系']) expect(fileText).toContain(`## ${section}`);
    for (const field of ['教育阶段', '专业与学习方向', '学习目标', '学习风格', '学习节奏', '可用时间', '时间约束', '优势与薄弱领域', '学术诚信边界', '学期／学习周期', '课程清单', '教学要求', '作业', '考试', '截止时间', '获准学习材料', '知识掌握状态', '学习计划', '完成记录', '教师与同伴', '协作项目']) {
      expect(fileText).toContain(`### ${field}`);
    }
    expect(fileText).toContain('### 流水');

    // 台账行
    const groups = await m.readGroups(UID);
    const row = groups.find((g) => g.template_id === 'student');
    expect(row).toBeDefined();
    expect(row!.title).toBe('学生');
    expect(row!.rel_path).toBe('.personal_ontology_groups/student.md');
    expect(row!.template_version).toBe('0.2.0-review.1');
  });

  it('is idempotent: second install → already_installed, no new file overwrite', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    // 用户已填一个值
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    await m.appendFieldValueToRef(UID, m.buildContentRef(row.group_id, '课程'), '专业', '计算机科学', '手动');
    const first = readFile('student.md');
    const again = await m.installTemplateFile(UID, 'student');
    expect(again.ok).toBe(true);
    expect(again.already_installed).toBe(true);
    expect(readFile('student.md')).toBe(first); // 文件未被重置
  });

  it('reports name conflicts with plain groups (no template_id)', async () => {
    const m = await loadMod();
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    await groups.createGroup(UID, '学习背景');
    const res = await m.installTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.conflict_groups).toEqual([{ group_id: expect.any(String), title: '学习背景' }]);
  });

  it('unknown template → error', async () => {
    const m = await loadMod();
    const res = await m.installTemplateFile(UID, 'no-such-template');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('template not found');
  });

  // ── F-r2-5：并发安装的锁内终审 ──────────────────────────────────────────

  it('F-r2-5: 并发双装同模板只落一份组（锁内终审幂等）', async () => {
    const m = await loadMod();
    const [a, b] = await Promise.all([
      m.installTemplateFile(UID, 'student'),
      m.installTemplateFile(UID, 'student'),
    ]);
    // 一个装成、一个 already_installed（拿锁顺序不定，但恰好各一）
    expect([a, b].filter((r) => r.ok && !r.already_installed)).toHaveLength(1);
    expect([a, b].filter((r) => r.already_installed)).toHaveLength(1);
    // 同 templateId 的组只有一份——第二份是不同 id 的孤儿（迁移/卸载 find 不到）
    const { loadPoDocSync } = await import('../../../src/main/features/po/store');
    const groups = loadPoDocSync(UID).groups.filter((g) => g.kind === 'template' && g.templateId === 'student');
    expect(groups).toHaveLength(1);
  });

  it('F-r2-5: 并发装满上限只落 MAX_INSTALLED_TEMPLATES 份（锁内终审超限）', async () => {
    const m = await loadMod();
    const results = await Promise.all([
      m.installTemplateFile(UID, 'student'),
      m.installTemplateFile(UID, 'scholar'),
      m.installTemplateFile(UID, 'fde'),
      m.installTemplateFile(UID, 'product_manager'),
    ]);
    expect(results.filter((r) => r.ok && !r.already_installed)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.error === 'template_limit_reached')).toHaveLength(1);
    const { loadPoDocSync } = await import('../../../src/main/features/po/store');
    expect(loadPoDocSync(UID).groups.filter((g) => g.kind === 'template')).toHaveLength(3);
  });

  it('F-r2-5: 已装分支提前返回不清归档（并发 restore 输方保住唯一归档副本）', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.uninstallTemplateFile(UID, 'student');
    expect(m.templateHasArchive(UID, 'student')).toBe(true);

    // fresh 装先拿锁（不清归档）；restore 装后拿锁 → already_installed 必须在
    // clearTemplateArchives 之前提前返回——其恢复的数据并未落盘，此刻归档仍
    // 是唯一副本。
    const [a, b] = await Promise.all([
      m.installTemplateFile(UID, 'student', false),
      m.installTemplateFile(UID, 'student', true),
    ]);
    expect([a, b].filter((r) => r.ok && !r.already_installed)).toHaveLength(1);
    expect([a, b].filter((r) => r.already_installed)).toHaveLength(1);
    expect(m.templateHasArchive(UID, 'student')).toBe(true); // 唯一归档副本未被误清
  });

  it('F-r3-8: 主落盘后他方完整卸载，清档不得删掉他方刚写的新归档', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.uninstallTemplateFile(UID, 'student');
    expect(m.templateHasArchive(UID, 'student')).toBe(true);

    // 合法串行序交错：restore 重装的主落盘（第一次 editPoDoc）刚完成、清档
    // 尚未执行的窗口里，他方完整卸载（锁内归档最新组 + 删组）。随后本调用的
    // 清档不得把他方刚写的新归档一并删掉——组已删 + 归档也没 = 数据永久丢。
    hookState.afterLock = async () => {
      await m.uninstallTemplateFile(UID, 'student');
    };
    let res;
    try {
      res = await m.installTemplateFile(UID, 'student', true);
    } finally {
      hookState.afterLock = null;
    }
    expect(res.ok).toBe(true);
    // 他方卸载生效：模板组已不在
    expect(m.readGroups(UID).some((g) => g.template_id === 'student')).toBe(false);
    // 他方卸载写的新归档仍在，且含恢复过的数据
    expect(m.templateHasArchive(UID, 'student')).toBe(true);
    const archived = m.readTemplateArchive(UID, 'student');
    expect(archived).toContain('本科');
  });
});

describe('template_file_ops › readContentById (复合 id 分节读取)', () => {
  let m: Awaited<ReturnType<typeof loadMod>>;
  let ref: string;

  beforeEach(async () => {
    m = await loadMod();
    const inst = await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    ref = m.buildContentRef(row.group_id, '学习背景');
  });

  it('composite ref returns the section markdown (with ## title, fields, flow)', async () => {
    const res = await m.readContentById(UID, ref);
    expect(res.ok).toBe(true);
    expect(res.section).toBe('学习背景');
    expect(res.content).toContain('## 学习背景');
    expect(res.content).toContain('### 教育阶段');
    expect(res.content).toContain('### 流水');
    expect(res.content).not.toContain('## 目标与节奏'); // 不含其他分节
  });

  it('plain group id returns the whole file (backward compat)', async () => {
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '手工组');
    await groups.appendToGroup(UID, created.group!.group_id, '一条流水');
    const res = await m.readContentById(UID, created.group!.group_id);
    expect(res.ok).toBe(true);
    expect(res.section).toBeUndefined();
    expect(res.content).toContain('一条流水');
  });

  it('unknown section → error', async () => {
    const badRef = ref.replace('::学习背景', '::不存在的分节');
    const res = await m.readContentById(UID, badRef);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('section not found');
  });
});

describe('template_file_ops › appendFieldValueToRef (分节字段写入)', () => {
  let m: Awaited<ReturnType<typeof loadMod>>;
  let ref: string;

  beforeEach(async () => {
    m = await loadMod();
    const inst = await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    ref = m.buildContentRef(row.group_id, '学习背景');
  });

  it('writes a value into an empty pit with source marker', async () => {
    const res = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');
    expect(res.ok).toBe(true);
    expect(readFile('student.md')).toContain('### 教育阶段\n- 硕士 [智能]');
  });

  it('dedupes exact same value+source, appends different values', async () => {
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');
    const dup = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');
    expect(dup.ok).toBe(true);
    const fileText = readFile('student.md');
    expect(fileText.match(/- 硕士 \[智能\]/g)).toHaveLength(1); // 去重
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '博士', '智能');
    expect(readFile('student.md')).toContain('- 硕士 [智能]\n- 博士 [智能]');
  });

  it('creates a user-defined field section on the fly', async () => {
    const res = await m.appendFieldValueToRef(UID, ref, '我的自定义字段', '值甲', '手动');
    expect(res.ok).toBe(true);
    expect(readFile('student.md')).toContain('### 我的自定义字段\n- 值甲 [手动]');
  });

  it('unknown section → error', async () => {
    const res = await m.appendFieldValueToRef(UID, `${ref}::不存在`, '教育阶段', 'x', '手动');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('section not found');
  });

  it('plain group ref forwards to dual-zone appendFieldValue', async () => {
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const created = await groups.createGroup(UID, '手工组');
    const res = await m.appendFieldValueToRef(UID, created.group!.group_id, '偏好', '喜欢大白话', '候选');
    expect(res.ok).toBe(true);
    expect(readFile(`${created.group!.group_id}.md`)).toContain('## 字段区');
    expect(readFile(`${created.group!.group_id}.md`)).toContain('- 喜欢大白话 [候选]');
  });
});

describe('template_file_ops › appendFlowEntryToRef (分节流水) & promoteEntryToRef (升格)', () => {
  let m: Awaited<ReturnType<typeof loadMod>>;
  let ref: string;

  beforeEach(async () => {
    m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    ref = m.buildContentRef(row.group_id, '学习背景');
  });

  it('appends flow entry to the section flow (not file-level)', async () => {
    const res = await m.appendFlowEntryToRef(UID, ref, '参加了数学建模竞赛');
    expect(res.ok).toBe(true);
    expect(readFile('student.md')).toContain('### 流水\n\n参加了数学建模竞赛');
  });

  it('promotes a section flow entry into the same section field (source 手动)', async () => {
    await m.appendFlowEntryToRef(UID, ref, '参加了数学建模竞赛');
    const res = await m.promoteEntryToRef(UID, ref, '参加了数学建模竞赛', '教育阶段');
    expect(res.ok).toBe(true);
    const fileText = readFile('student.md');
    expect(fileText).toContain('### 教育阶段\n- 参加了数学建模竞赛 [手动]');
    expect(fileText).not.toContain('参加了数学建模竞赛\n'); // 流水条目已移除（流水区不再含）
    expect(fileText).toContain('### 流水'); // 空流水小节仍在
  });

  it('promote unknown entry → error', async () => {
    const res = await m.promoteEntryToRef(UID, ref, '不存在的条目', '教育阶段');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('entry not found');
  });
});

describe('template_file_ops › listFieldsByRef (分节字段清单，含空坑)', () => {
  it('returns section fields including empty pits, in file order', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能');

    const res = await m.listFieldsByRef(UID, ref);
    expect(res.ok).toBe(true);
    const names = res.fields!.map((f) => f.name);
    expect(names).toEqual(['教育阶段', '专业与学习方向']);
    expect(res.fields![0].values).toEqual([{ value: '硕士', source: '智能' }]);
    expect(res.fields![1].values).toEqual([]); // 空坑
  });
});

// ── 二期 D5：模板分节字段来源项目标记（@proj:<pid>）────────────────────────

describe('template_file_ops › project source marker on template sections', () => {
  it('appendFieldValueToRef with project persists @proj:<pid> into the section file', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    const r = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');
    expect(r.ok).toBe(true);
    expect(readFile('student.md')).toContain('- 硕士 [智能] @proj:p_abc');
  });

  it('listFieldsByRef returns the project field on values', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');

    const res = await m.listFieldsByRef(UID, ref);
    expect(res.ok).toBe(true);
    expect(res.fields![0].values).toEqual([{ value: '硕士', source: '智能', project: 'p_abc' }]);
  });

  it('same value+source+project dedupes on template sections too', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');
    const r2 = await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士', '智能', 'p_abc');
    expect(r2.ok).toBe(true);
    const res = await m.listFieldsByRef(UID, ref);
    expect(res.fields![0].values).toHaveLength(1);
  });

  it('round-trips a section value with project through serialize/parse', async () => {
    const m = await loadMod();
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const fv = { value: '机器学习', source: '智能', project: 'p_abc' };
    const line = groups.serializeFieldValueLine(fv);
    expect(line).toBe('- 机器学习 [智能] @proj:p_abc');
    expect(groups.parseFieldValueLine(line)).toEqual(fv);
  });
});

describe('template_file_ops › uninstall / archive / reinstall-restore', () => {
  it('uninstall archives the template file and removes the ledger row', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    // 写入一条字段值，验证归档时数据保留
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');

    const res = await m.uninstallTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.archive_dir).toBeTruthy();
    // 台账移除
    expect(m.readGroups(UID).some((g) => g.template_id === 'student')).toBe(false);
    // 原文件已移走
    expect(fs.existsSync(path.join(groupsDir(), 'student.md'))).toBe(false);
    // 归档目录有旧文件
    expect(fs.existsSync(path.join(res.archive_dir!, 'student.md'))).toBe(true);
  });

  it('reinstall with restoreData restores archived field values', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.uninstallTemplateFile(UID, 'student');

    const again = await m.installTemplateFile(UID, 'student', true);
    expect(again.ok).toBe(true);
    expect(again.restored_from_archive).toBe(true);
    // 数据恢复
    const row2 = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref2 = m.buildContentRef(row2.group_id, '学习背景');
    const fields = await m.listFieldsByRef(UID, ref2);
    const edu = fields.fields!.find((f) => f.name === '教育阶段');
    expect(edu && edu.values).toEqual([{ value: '本科', source: '手动' }]);
  });

  it('reinstall without restoreData builds a fresh empty template', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.uninstallTemplateFile(UID, 'student');

    const again = await m.installTemplateFile(UID, 'student', false);
    expect(again.ok).toBe(true);
    expect(again.restored_from_archive).toBeFalsy();
    const row2 = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref2 = m.buildContentRef(row2.group_id, '学习背景');
    const fields = await m.listFieldsByRef(UID, ref2);
    const edu = fields.fields!.find((f) => f.name === '教育阶段');
    expect(!edu || !edu.values || edu.values.length === 0).toBe(true);
  });

  it('uninstall is idempotent for a template that is not installed', async () => {
    const m = await loadMod();
    const res = await m.uninstallTemplateFile(UID, 'student');
    expect(res.ok).toBe(true);
    expect(res.archive_dir).toBeUndefined();
  });

  it('uninstall with archiveMemory archives role-tagged global memory and removes it from USER.md', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    // 写入一条带角色标签的全局记忆
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '会主动核查工具执行过程');
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(1);

    const res = await m.uninstallTemplateFile(UID, 'student', true);
    expect(res.ok).toBe(true);
    expect(res.archived_memory_count).toBe(1);
    // 归档文件存在
    expect(fs.existsSync(path.join(res.archive_dir!, 'student.memory.md'))).toBe(true);
    // 搬迁后（2026-09-22）：条目在模板独立文件，卸载后独立文件删除。
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(0);
    const ownFile = path.join(tmpDir, UID, 'cloud', 'memory', 'role-templates', 'student.md');
    expect(fs.existsSync(ownFile)).toBe(false);
  });

  it('P-r2-9: 组归档写失败时卸载整体中止，活记忆不被先行删除（分裂态修复）', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '会主动核查工具执行过程');
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(1);

    // 注入：_backup_ 归档目录的写入全部失败（组归档必失败）。
    archiveFail.failArchiveWrite = true;
    let res;
    try {
      res = await m.uninstallTemplateFile(UID, 'student', true);
    } finally {
      archiveFail.failArchiveWrite = false;
    }
    expect(res.ok).toBe(false);
    // 组保留（既有 r2 修复的一半：归档失败即不删组）。
    expect(m.readGroups(UID).some((g) => g.template_id === 'student')).toBe(true);
    // 活记忆保留（P-r2-9 修复的另一半：修复前记忆分支在锁外先行删除，
    // 组归档一失败即成分裂态——模板还在、活记忆只剩归档副本、无恢复入口）。
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(1);
    const ownFile = path.join(tmpDir, UID, 'cloud', 'memory', 'role-templates', 'student.md');
    expect(fs.existsSync(ownFile)).toBe(true);

    // 注入解除后重试：归档 + 删除一次完成，数据不丢。
    const retry = await m.uninstallTemplateFile(UID, 'student', true);
    expect(retry.ok).toBe(true);
    expect(retry.archived_memory_count).toBe(1);
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(0);
    expect(fs.existsSync(path.join(retry.archive_dir!, 'student.memory.md'))).toBe(true);
  });

  it('reinstall with restoreData restores archived global memory', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '会主动核查工具执行过程');
    await m.uninstallTemplateFile(UID, 'student', true);

    const again = await m.installTemplateFile(UID, 'student', true);
    expect(again.ok).toBe(true);
    expect(again.restored_memory_count).toBe(1);
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(1);
    const templateMd = fs.readFileSync(path.join(tmpDir, UID, 'cloud', 'memory', 'role-templates', 'student.md'), 'utf8');
    expect(templateMd).toContain('会主动核查工具执行过程');
    expect(templateMd).toContain('role_template');
  });

  it('reinstall without restoreData does not restore archived memory', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '会主动核查工具执行过程');
    await m.uninstallTemplateFile(UID, 'student', true);

    const again = await m.installTemplateFile(UID, 'student', false);
    expect(again.ok).toBe(true);
    expect(again.restored_memory_count).toBeFalsy();
    expect(mem.countRoleTemplateMemoryEntries(UID, 'student')).toBe(0);
  });

  it('B-1: archive writes the memory file BEFORE removing live data (crash-safe order)', async () => {
    const m = await loadMod();
    const mem = await import('../../../src/main/features/memory');
    await m.installTemplateFile(UID, 'student');
    await mem.addRoleTemplateMemoryEntry(UID, 'user', 'student', '崩溃窗口保护条目');
    const un = await m.uninstallTemplateFile(UID, 'student', true);
    expect(un.ok).toBe(true);
    expect(un.archived_memory_count).toBe(1);
    // 归档文件先于活数据删除存在：模拟归档已写但活数据未删的窗口
    // （重试卸载应基于"已归档文本"而非重新收集活数据 —— 本实现顺序保证归档先写）
    const archivedText = fs.readFileSync(path.join(un.archive_dir!, 'student.memory.md'), 'utf8');
    expect(archivedText).toContain('崩溃窗口保护条目');
  });

  it('B-2: readTemplateArchive picks the NEWEST backup when multiple exist', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    // 手工造两个归档目录（旧 + 新），内容不同
    const base = groupsDir();
    const oldDir = path.join(base, '_backup_1000000000000');
    const newDir = path.join(base, '_backup_2000000000000');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'student.md'), '# 旧数据');
    fs.writeFileSync(path.join(newDir, 'student.md'), '# 新数据');
    expect(m.readTemplateArchive(UID, 'student')).toContain('新数据');
  });

  it('B-2: reinstall with restoreData clears the archives afterwards', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const un = await m.uninstallTemplateFile(UID, 'student', true);
    expect(fs.existsSync(path.join(un.archive_dir!, 'student.md'))).toBe(true);
    const again = await m.installTemplateFile(UID, 'student', true);
    expect(again.ok).toBe(true);
    // 归档已清理（数据已回活）
    expect(m.templateHasArchive(UID, 'student')).toBe(false);
    expect(m.templateHasMemoryArchive(UID, 'student')).toBe(false);
  });

  it('F-r1-10: 重装恢复时 editPoDoc 落盘失败 → 归档保留，重试仍可恢复（清理必须在落盘成功之后）', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.uninstallTemplateFile(UID, 'student');
    expect(m.templateHasArchive(UID, 'student')).toBe(true);

    // 模拟 editPoDoc 落盘失败：个人本体文档写入抛错 →
    // installTemplateFile 整体 reject。注入必须走模块缝（storage.writeJson）
    // 而不是 fs.chmod：Windows 上目录权限位不阻止写入，只读目录仍能落盘。
    poDocFail.failWrite = true;
    try {
      // 断言注入的那次失败，避免「因为别的原因 reject」也能过。
      await expect(m.installTemplateFile(UID, 'student', true)).rejects.toThrow('simulated po document write failure');
    } finally {
      poDocFail.failWrite = false;
    }

    // 归档未被清理：此刻归档是唯一磁盘副本，重试重装必须仍能完整恢复。
    expect(m.templateHasArchive(UID, 'student')).toBe(true);
    const again = await m.installTemplateFile(UID, 'student', true);
    expect(again.ok).toBe(true);
    expect(again.restored_from_archive).toBe(true);
    const row2 = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref2 = m.buildContentRef(row2.group_id, '学习背景');
    const fields = await m.listFieldsByRef(UID, ref2);
    const edu = fields.fields!.find((f) => f.name === '教育阶段');
    expect(edu && edu.values).toEqual([{ value: '本科', source: '手动' }]);
  });
});

// ── D5（specs/009 T012）：模板分节写路径的变更前留档 ────────────────────────
// 模板分节的写操作走 mutateTemplateFile，此前在 writeTextAtomicSync 之前没有
// snapshotGroupHistory——改值/删值/删字段/流水升格四条路径全都没有变更前快照
// （普通组走 mutateGroupContent 有写前留档）。以下断言修复前会失败（D5 举证）。

describe('template_file_ops › D5 变更前留档（模板分节写路径快照）', () => {
  /** 读该组历史目录下全部快照全文（不依赖文件名格式，只挑 .md）。 */
  // v2：历史快照是 po-history 下的 JSON（整组状态），渲染回模板方言文本后
  // 与旧行为逐字对照——断言本体不变，只换了快照存储的读取方式。
  let viewMod: Awaited<ReturnType<typeof loadView>> | undefined;
  function loadView() {
    return import('../../../src/main/features/po/view');
  }
  async function readHistorySnapshots(groupId: string): Promise<string[]> {
    if (!viewMod) viewMod = await loadView();
    const dir = path.join(tmpDir, UID, 'cloud', 'cognition', 'po-history', groupId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return viewMod!.renderTemplateGroupMarkdown(parsed.group);
      });
  }

  async function setup(): Promise<{ m: Awaited<ReturnType<typeof loadMod>>; groupId: string; ref: string }> {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    return { m, groupId: row.group_id, ref: m.buildContentRef(row.group_id, '学习背景') };
  }

  it('分节字段改值：历史里能找到改前那版（含旧值，逐字）', async () => {
    const { m, groupId, ref } = await setup();
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    const before = readFile('student.md');

    const res = await m.setFieldValueToRef(UID, ref, '教育阶段', '本科', '硕士');
    expect(res.ok).toBe(true);

    const snaps = await readHistorySnapshots(groupId);
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps).toContain(before); // 改前那版逐字在历史里
    expect(before).toContain('- 本科 [手动]');
    expect(readFile('student.md')).toContain('- 硕士 [手动]');
  });

  it('分节字段删值：历史里有删前那版且内容逐字一致', async () => {
    const { m, groupId, ref } = await setup();
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '辅修心理学', '手动');
    const before = readFile('student.md');

    const res = await m.removeFieldValueToRef(UID, ref, '教育阶段', '本科');
    expect(res.ok).toBe(true);

    const snaps = await readHistorySnapshots(groupId);
    expect(snaps).toContain(before); // 删前那版逐字一致
    expect(before).toContain('- 本科 [手动]');
    const after = readFile('student.md');
    expect(after).not.toContain('- 本科 [手动]');
    expect(after).toContain('- 辅修心理学 [手动]');
    expect(after).toContain('### 教育阶段'); // 空坑保留（小节不删）
  });

  it('恢复快照后分节结构（## 分节 / ### 流水）与值顺序不变', async () => {
    const { m, groupId, ref } = await setup();
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '值一', '手动');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '值二', '手动');
    const before = readFile('student.md');
    // 再写一笔，让「最后一次写之前」的状态（= before）成为最新快照
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '值三', '手动');

    const hist = groups.listGroupHistory(UID, groupId);
    expect(hist.length).toBeGreaterThan(0);
    const res = await groups.restoreGroupSnapshot(UID, groupId, hist[0].id);
    expect(res.ok).toBe(true);

    const restored = readFile('student.md');
    expect(restored).toBe(before); // 逐字一致（最强断言）
    // 显式断言任务验收点：分节结构 + 值顺序
    expect(restored).toContain('## 学习背景');
    expect(restored).toMatch(/### 教育阶段\n- 值一 \[手动\]\n- 值二 \[手动\]/);
    expect(restored).toContain('### 流水');
    expect(restored).not.toContain('值三');
  });

  it('「没走到要写」与「内容未变」的分支不产生快照（T011 顺序验收）', async () => {
    const { m, groupId, ref } = await setup();
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    // 首次内容写入：留一版改前状态（v2 口径：安装时为空组不留档）
    expect(await readHistorySnapshots(groupId)).toHaveLength(1);

    // ① 同值同源去重（changed:false，序列化后内容未变）→ 不新增快照
    const dup = await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');
    expect(dup.ok).toBe(true);
    expect(await readHistorySnapshots(groupId)).toHaveLength(1);

    // ② mutator 拒绝（旧值不存在，没走到要写）→ 不留档
    const miss = await m.setFieldValueToRef(UID, ref, '教育阶段', '不存在的旧值', '新值');
    expect(miss.ok).toBe(false);
    expect(await readHistorySnapshots(groupId)).toHaveLength(1);
  });
});

/* ═══════════ 时间锚三态 · 模板分节同款（specs/014 T006）═══════════ */

describe('template_file_ops › asOf 三态透传（specs/014 T006）', () => {
  it('分节字段：set 清除/设置/缺省三态与普通组一致；非法报错不写', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const groups = await m.readGroups(UID);
    const row = groups.find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科在读', '手动', undefined, '2026-01');

    // 缺省：只改值，保留 asOf（M12）。
    expect((await m.setFieldValueToRef(UID, ref, '教育阶段', '本科在读', '本科四年级')).ok).toBe(true);
    let fields = await m.listFieldsByRef(UID, ref);
    expect(fields.fields?.find((f) => f.name === '教育阶段')?.values[0])
      .toMatchObject({ value: '本科四年级', asOf: '2026-01' });

    // set：换锚。
    expect((await m.setFieldValueToRef(UID, ref, '教育阶段', '本科四年级', '本科四年级', { asOf: '2026-05' })).ok).toBe(true);
    fields = await m.listFieldsByRef(UID, ref);
    expect(fields.fields?.find((f) => f.name === '教育阶段')?.values[0].asOf).toBe('2026-05');

    // clear：只删锚。
    expect((await m.setFieldValueToRef(UID, ref, '教育阶段', '本科四年级', '本科四年级', { clearAsOf: true })).ok).toBe(true);
    fields = await m.listFieldsByRef(UID, ref);
    expect(fields.fields?.find((f) => f.name === '教育阶段')?.values[0].asOf).toBeUndefined();

    // 非法：报错且文件未变。
    const before = readFile('student.md');
    expect(await m.setFieldValueToRef(UID, ref, '教育阶段', '本科四年级', '本科四年级', { asOf: '2026-13' }))
      .toEqual({ ok: false, error: 'invalid asof' });
    expect(readFile('student.md')).toBe(before);
    // 用户线 append 的非法同样报错。
    expect(await m.appendFieldValueToRef(UID, ref, '教育阶段', '硕士在读', '手动', undefined, undefined, { asOf: '2026-9' }))
      .toEqual({ ok: false, error: 'invalid asof' });
  });
});

// ── 全文保存的值 id 保全（一对多）─────────────────────────────────────────

describe('template_file_ops › writeTemplateFileContent 值 id 保全', () => {
  it('F-r1-11: 同字段同文本多值经全文保存后 id 一对一保全（无重复、无漂移）', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    // 同字段两条同文本值（来源不同 → 不触发同值同源去重）
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '双学位', '手动');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '双学位', '智能');

    const { loadPoDocSync } = await import('../../../src/main/features/po/store');
    const valueIds = () => loadPoDocSync(UID).groups
      .find((g) => g.templateId === 'student')!.values.map((v) => v.id);
    const before = valueIds();
    expect(before.filter((id, i) => before.indexOf(id) !== i)).toEqual([]); // 保存前本就无重复

    // 编辑器原样保存（内容未变 → 值 id 必须全部原地保留）
    const text = m.readTemplateFileText(UID, 'student');
    const res = await m.writeTemplateFileContent(UID, row.group_id, text);
    expect(res.ok).toBe(true);

    const after = valueIds();
    expect(after).toHaveLength(before.length);
    expect(new Set(after)).toEqual(new Set(before)); // id 集合不变
    // 两条同文本值各拿各的旧 id——重复 id 会让按 id 的删/改一次命中两条。
    expect(after.filter((id, i) => after.indexOf(id) !== i)).toEqual([]);
  });
});

// ── F-r1-12：卸载归档的锁外渲染窗口 ────────────────────────────────────────

describe('template_file_ops › F-r1-12 卸载归档窗口', () => {
  it('锁外读组与锁内删组之间的并发提交必须进归档（归档用锁内最新组渲染）', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    const row = m.readGroups(UID).find((g) => g.template_id === 'student')!;
    const ref = m.buildContentRef(row.group_id, '学习背景');
    await m.appendFieldValueToRef(UID, ref, '教育阶段', '本科', '手动');

    // 在 uninstall 的 editPoDoc 拿锁执行前注入一次他方经锁的写值：
    // 模拟「锁外读组之后、锁内删组之前」窗口内的并发提交。
    hookState.beforeLock = async () => {
      await m.appendFieldValueToRef(UID, ref, '教育阶段', '窗口期写入', '手动');
    };
    try {
      const un = await m.uninstallTemplateFile(UID, 'student');
      expect(un.ok).toBe(true);
      const archivedText = fs.readFileSync(path.join(un.archive_dir!, 'student.md'), 'utf8');
      expect(archivedText).toContain('本科 [手动]');
      // 窗口内提交的值进了归档，而不是随组被静默删掉
      expect(archivedText).toContain('窗口期写入');
    } finally {
      hookState.beforeLock = null;
    }
  });

  it('归档写入失败 → 卸载中止且组保留（归档失败即不删，重试可完成）', async () => {
    const m = await loadMod();
    await m.installTemplateFile(UID, 'student');
    expect(m.readGroups(UID).some((g) => g.template_id === 'student')).toBe(true);

    archiveFail.failArchiveWrite = true;
    try {
      const res = await m.uninstallTemplateFile(UID, 'student');
      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
    } finally {
      archiveFail.failArchiveWrite = false;
    }
    // 组未被删除：卸载失败后数据仍在活文档。
    expect(m.readGroups(UID).some((g) => g.template_id === 'student')).toBe(true);
    // 归档失败解除后重试卸载成功。
    const retry = await m.uninstallTemplateFile(UID, 'student');
    expect(retry.ok).toBe(true);
    expect(fs.existsSync(path.join(retry.archive_dir!, 'student.md'))).toBe(true);
  });
});

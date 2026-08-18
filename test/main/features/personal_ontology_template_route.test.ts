import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 模板文件组（阶段 D）的路由与字段清单行为：
 * - listGroupFields 对模板文件返回跨分节字段并标注 isCustom（自定义字段）
 * - confirmCandidate 对模板组：T-box 字段命中 → 写对应分节；
 *   自定义字段名（非 T-box）→ 拒绝并回退流水；无 targetField → 首个分节流水
 */

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'test-user-tplroute';
const GROUP_ID = 'tpl-group-000001';

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-onto-tplroute-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function groupsDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups');
}

/** 直接落一个模板文件组：groups.md 台账行 + student.md 模板文件。 */
function seedTemplateGroup() {
  const dir = groupsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'groups.md'), [
    '# 记忆分组',
    '',
    '> 最后更新: 2026-08-06T00:00:00 | 共 1 个分组',
    '',
    `### ${GROUP_ID}`,
    '- 标题: 学生',
    '- 文件: .personal_ontology_groups/student.md',
    '- 创建时间: 2026-08-04T00:00:00',
    '- 更新时间: 2026-08-05T00:00:00',
    '- 模板: student@1.0.0',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'student.md'), [
    '# 学生（模板）',
    '',
    '> 模板: student@0.2.0-review.1 | 已安装: 2026-08-04T00:00:00',
    '',
    '## 学习背景',
    '',
    '### 教育阶段',
    '',
    '### 专业与学习方向',
    '',
    '### 流水',
    '',
    '## 目标与节奏',
    '',
    '### 学习目标',
    '',
    '### 个人信息',
    '- 张浩，大三学生 [手动]',
    '',
    '### 流水',
    '',
  ].join('\n'));
}

function candidatesMdPath(): string {
  return path.join(tmpDir, UID, 'local', 'ontology_candidates', 'candidates.md');
}

function seedCandidate(id: string, text: string) {
  const file = candidatesMdPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `# 个人本体候选（待确认）`,
    '',
    `> 最后更新: 2026-08-06T00:00:00 | 共 1 条待确认`,
    '',
    `### ${id}`,
    '- 类型: preference',
    '- 置信度: high',
    `- 摘要: ${text}`,
    '- 记忆去向: user',
    `- 记忆文本: ${text}`,
    '- 来源: ',
    '',
  ].join('\n'));
}

describe('personal ontology template group routing', () => {
  it('listGroupFields parses template files across sections and marks custom fields', async () => {
    seedTemplateGroup();
    const groups = await import('../../../src/main/features/personal_ontology_groups');
    const res = await groups.listGroupFields(UID, GROUP_ID);
    expect(res.ok).toBe(true);
    const names = (res.fields || []).map((f) => f.name);
    // 跨分节：学习背景 + 目标与节奏 的字段都在，流水小节不进字段清单
    expect(names).toContain('教育阶段');
    expect(names).toContain('专业与学习方向');
    expect(names).toContain('学习目标');
    expect(names).toContain('个人信息');
    expect(names).not.toContain('流水');
    // T-box 字段 isCustom=false，升格出来的「个人信息」isCustom=true
    const byName = Object.fromEntries((res.fields || []).map((f) => [f.name, f]));
    expect(byName['教育阶段'].isCustom).toBe(false);
    expect(byName['学习目标'].isCustom).toBe(false);
    expect(byName['个人信息'].isCustom).toBe(true);
    // 值保留（含来源标记）
    expect(byName['个人信息'].values).toEqual([{ value: '张浩，大三学生', source: '手动' }]);
  });

  it('confirmCandidate writes to the T-box field section when targetField hits', async () => {
    seedTemplateGroup();
    seedCandidate('cand-tbox-1', '本学期修财务管理课程');
    const poc = await import('../../../src/main/features/personal_ontology_candidates');
    const res = await poc.confirmCandidate(UID, 'cand-tbox-1', {
      toGlobalMemory: false,
      toGroupIds: [GROUP_ID],
      targetField: '教育阶段',
    });
    expect(res.ok).toBe(true);
    expect(res.fieldWrites).toEqual([
      expect.objectContaining({ groupId: GROUP_ID, fieldName: '教育阶段', ok: true }),
    ]);
    // 值写入「学习背景」分节的「教育阶段」小节，来源=候选
    const text = fs.readFileSync(path.join(groupsDir(), 'student.md'), 'utf8');
    // 注意：split 分隔符必须带换行锚点，避免误匹配 `### 教育阶段` 字段标题里的子串
    const courseSection = text.split('\n## 学习背景\n')[1].split('\n## 目标与节奏\n')[0];
    expect(courseSection).toContain('- 本学期修财务管理课程 [候选]');
    // 未污染其他分节/流水
    expect(courseSection).not.toContain('### 个人信息');
    // 候选已从池移除
    const after = await poc.listCandidates(UID);
    expect(after.candidate_updates).toHaveLength(0);
  });

  it('confirmCandidate refuses non-T-box field names and falls back to first-section flow', async () => {
    seedTemplateGroup();
    seedCandidate('cand-custom-1', '自定义字段拦截测试');
    const poc = await import('../../../src/main/features/personal_ontology_candidates');
    const res = await poc.confirmCandidate(UID, 'cand-custom-1', {
      toGlobalMemory: false,
      toGroupIds: [GROUP_ID],
      targetField: '个人信息', // 模板外的自定义字段名 → 不得被候选自动写入
    });
    expect(res.ok).toBe(true);
    expect(res.fieldWrites).toEqual([
      expect.objectContaining({ groupId: GROUP_ID, fieldName: '个人信息', ok: false }),
    ]);
    const text = fs.readFileSync(path.join(groupsDir(), 'student.md'), 'utf8');
    // 自定义字段「个人信息」未被候选追加新值（仍是原来的 1 条）
    const skillSection = text.split('\n## 目标与节奏\n')[1];
    expect(skillSection.match(/- .+ \[手动\]/g) || []).toHaveLength(1);
    // 回退到首个分节（学习背景）流水区
    const courseSection = text.split('\n## 学习背景\n')[1].split('\n## 目标与节奏\n')[0];
    expect(courseSection.split('### 流水')[1]).toContain('自定义字段拦截测试');
  });

  it('confirmCandidate without targetField writes to first-section flow', async () => {
    seedTemplateGroup();
    seedCandidate('cand-noft-1', '无字段建议的候选');
    const poc = await import('../../../src/main/features/personal_ontology_candidates');
    const res = await poc.confirmCandidate(UID, 'cand-noft-1', {
      toGlobalMemory: false,
      toGroupIds: [GROUP_ID],
    });
    expect(res.ok).toBe(true);
    const text = fs.readFileSync(path.join(groupsDir(), 'student.md'), 'utf8');
    const courseSection = text.split('\n## 学习背景\n')[1].split('\n## 目标与节奏\n')[0];
    expect(courseSection.split('### 流水')[1]).toContain('无字段建议的候选');
    // 普通组路径不受影响：字段区不应出现
    expect(text).not.toContain('## 字段区');
  });
});

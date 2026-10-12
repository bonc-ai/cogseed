/**
 * 模型侧矛盾暴露（specs/014 US-903 / T011 / T018 / T022）。
 *
 *   ① 有矛盾 → 事实挂 disputed + conflictedWith（≤2 条、截断）；
 *   ② 无矛盾 → 元素深度相等（零差异承诺 I-9：不挂任何键）；
 *   ③ 对端受限 → 只置位不带文本（B5/A9：受限正文不进模型侧标记）；
 *   ④ 只读索引不写盘（I-11：读取前后 conflicts.md 的内容与 mtime 不变）；
 *   ⑤ restricted 值仍不进事实数组（既有行为复验）；
 *   ⑥ auto-forecast prompt 有「disputed 不单方面采信」句（T022，B4①）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_indexer', () => ({
  enqueue: () => {},
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));
vi.mock('../../../../src/main/features/search', () => ({
  upsertContext: () => {},
  dropContext: () => {},
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-disputed';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-disputed-'));
  prevWs = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});
afterEach(() => {
  if (prevWs === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function conflictsMd(): string {
  return path.join(tmpDir, UID, 'cloud', 'contexts', '.personal_ontology_groups', 'conflicts.md');
}

/** 造一条台账记录（绕过 LLM judge，按 serializeConflictsMd 的真实块格式落盘）。 */
function seedConflictRecord(groupId: string, field: string, a: string, b: string): void {
  const conflictId = `oc-seed${Math.floor(Math.random() * 1e6)}`;
  const block = [
    `### ${conflictId}`,
    `- 分组: ${groupId}`,
    `- 字段: ${field}`,
    `- 值A: ${a}`,
    `- 值B: ${b}`,
    `- 检出: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  const file = conflictsMd();
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# 本体分组字段值冲突台账\n\n';
  fs.writeFileSync(file, `${existing}${existing.endsWith('\n') ? '' : '\n'}${block}`, 'utf8');
}

describe('模型侧矛盾暴露（specs/014 T018/T019）', () => {
  it('① 有矛盾 → disputed + conflictedWith（对端值、非自身）', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const pk = await import('../../../../src/main/features/recall/projection-knowledge');
    const created = await groups.createGroup(UID, '矛盾组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住上海', '手动');
    seedConflictRecord(gid, '居住地', '常住北京', '常住上海');

    const facts = await pk.loadOntologyFacts(UID, {});
    const beijing = facts.find((fact) => fact.value === '常住北京');
    const shanghai = facts.find((fact) => fact.value === '常住上海');
    expect(beijing?.disputed).toBe(true);
    expect(beijing?.conflictedWith).toEqual(['常住上海']);
    expect(shanghai?.disputed).toBe(true);
    expect(shanghai?.conflictedWith).toEqual(['常住北京']);
  });

  it('② 无矛盾 → 元素深度相等（不挂任何键）', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const pk = await import('../../../../src/main/features/recall/projection-knowledge');
    const created = await groups.createGroup(UID, '安静组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');
    const before = await pk.loadOntologyFacts(UID, {});
    expect(before.every((fact) => fact.disputed === undefined && fact.conflictedWith === undefined)).toBe(true);
    // 只读索引读一遍后再取——产物逐字一致（索引没有副作用）。
    const conflicts = await import('../../../../src/main/features/recall/ontology-conflicts');
    await conflicts.readLiveConflicts(UID);
    expect(await pk.loadOntologyFacts(UID, {})).toEqual(before);
  });

  it('③ 对端受限 → 只置位不带文本；⑤ restricted 值不进事实数组', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const pk = await import('../../../../src/main/features/recall/projection-knowledge');
    const created = await groups.createGroup(UID, '受限矛盾组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住上海', '手动');
    await groups.setFieldValueSensitivity(UID, gid, '居住地', '常住上海', 'restricted');
    seedConflictRecord(gid, '居住地', '常住北京', '常住上海');

    const facts = await pk.loadOntologyFacts(UID, {});
    expect(facts.some((fact) => fact.value === '常住上海')).toBe(false); // ⑤ restricted 不进数组
    const beijing = facts.find((fact) => fact.value === '常住北京');
    expect(beijing?.disputed).toBe(true);
    expect(beijing?.conflictedWith).toBeUndefined(); // ③ 受限对端不带文本
  });

  it('④ 只读索引不写盘（内容与 mtime 均不变）', async () => {
    const groups = await import('../../../../src/main/features/personal_ontology_groups');
    const conflicts = await import('../../../../src/main/features/recall/ontology-conflicts');
    const created = await groups.createGroup(UID, '只读组');
    const gid = created.group!.group_id;
    await groups.appendFieldValue(UID, gid, '居住地', '常住北京', '手动');
    await groups.appendFieldValue(UID, gid, '居住地', '常住上海', '手动');
    seedConflictRecord(gid, '居住地', '常住北京', '常住上海');
    const file = conflictsMd();
    const before = fs.readFileSync(file, 'utf8');
    const beforeStat = fs.statSync(file);
    await new Promise((resolve) => setTimeout(resolve, 8));
    const live = await conflicts.readLiveConflicts(UID);
    expect(live).toHaveLength(1);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('⑥ auto-forecast prompt 写明 disputed 不单方面采信（T022 / B4①）', async () => {
    const { AUTO_FORECAST_PROMPT } = await import('../../../../src/main/features/kstar/auto-forecast');
    expect(AUTO_FORECAST_PROMPT).toContain('conflictedWith is non-empty is disputed');
    expect(AUTO_FORECAST_PROMPT).toContain('Do not treat it as a single settled fact');
  });
});

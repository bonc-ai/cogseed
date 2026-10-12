/**
 * 候选内容 v1 迁移（migrateCandidateContentFormat）专测（2026-09-30 r4）。
 *
 * 迁移由 listRecallCandidates 触发（candidate-service.ts:1188），此前零专测：
 * 锁 + marker 幂等 + 单条坏候选容错三项机制均无「旧格式落盘 → list → 断言
 * 迁移结果」的黑盒用例锁定。本文件四点断言：
 * ① 落盘文件改写为规范格式且原文无损（lossless）；
 * ② candidate-migrations/candidate-content-v1.json marker 已写入；
 * ③ 再次调用不重复改写（marker 幂等，mtime 不变）；
 * ④ 混入形状损坏候选时整体不抛错、其余照常迁移（marker 仍写）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedQuery: async (text: string) => {
    const digest = createHash('sha256').update(text).digest();
    return Array.from({ length: 512 }, (_, i) => (digest[i % 32] / 255 - 0.5) * 0.2);
  },
}));

let tmpDir: string;
let previousRoot: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-candidate-content-mig-'));
  previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
  process.env.COGSEED_WORKSPACE_ROOT = tmpDir;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
  else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function service() {
  return import('../../../../src/main/features/recall/candidate-service');
}

function findCandidateFile(root: string, candidateId: string): string {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === `${candidateId}.json`) return full;
    }
  }
  throw new Error(`candidate file not found: ${candidateId}`);
}

function markerFile(): string {
  return path.join(tmpDir, 'user-a', 'cloud', 'recall', 'records', 'candidate-migrations', 'candidate-content-v1.json');
}

describe('候选内容 v1 迁移（锁 + marker 幂等 + 单条坏候选容错）', () => {
  it('旧格式落盘 → list 触发：规范格式无损改写、marker 写入、幂等、坏候选不拖垮', async () => {
    const candidates = await service();
    const good = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Always confirm the rollout scope before shipping a config change.',
      summary: 'Confirm rollout scope',
      value: '规范写入阶段的正文。',
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'memory', id: 'mem-cm-good' }],
    });
    const bad = await candidates.saveRecallCandidate('user-a', {
      judgment: 'Keep the staging database seeded before a demo run.',
      summary: 'Seed staging before demo',
      suggestedType: 'rule',
      suggestedScope: 'product',
      sourceRefs: [{ kind: 'memory', id: 'mem-cm-bad' }],
    });

    // 好档改成旧格式（v1 bubble capture 形态）：缺 contentFormatVersion/
    // taxonomyVersion、无 evidenceRefs 数组、证据解释在 value。
    const goodFile = findCandidateFile(tmpDir, good.id);
    const legacy = JSON.parse(fs.readFileSync(goodFile, 'utf8')) as Record<string, unknown>;
    delete legacy.contentFormatVersion;
    delete legacy.taxonomyVersion;
    delete legacy.evidenceRefs;
    legacy.value = '旧格式里的证据解释文本——迁移必须无损保留。';
    fs.writeFileSync(goodFile, JSON.stringify(legacy));

    // 坏档：pending_review 却没有证据（asCandidate 抛——形状损坏）。
    const badFile = findCandidateFile(tmpDir, bad.id);
    const broken = JSON.parse(fs.readFileSync(badFile, 'utf8')) as Record<string, unknown>;
    broken.evidenceRefs = [];
    fs.writeFileSync(badFile, JSON.stringify(broken));

    // save 的内部去重（candidate-service.ts:1364/1399 的 captureKey/重复检查）
    // 就会调 listRecallCandidates——迁移在降级**之前**已跑完并写下 marker。这不是
    // 「旧格式从未迁移」的起点；删掉 marker 还原被测前提，list 才会走改写路径。
    expect(fs.existsSync(markerFile())).toBe(true);
    fs.rmSync(markerFile(), { force: true });

    // ④ + 触发：坏候选混入时整体不抛错，好候选照常出现在列表里。
    const listed = await candidates.listRecallCandidates('user-a');
    expect(listed.map((item) => item.id)).toContain(good.id);
    expect(listed.map((item) => item.id)).not.toContain(bad.id);

    // ① 落盘改写为规范格式，且原文无损（文本仍在记录里，迁移不删字）。
    const after = JSON.parse(fs.readFileSync(goodFile, 'utf8')) as Record<string, unknown>;
    expect(after.contentFormatVersion).toBe(1);
    expect(after.taxonomyVersion).toBe(2);
    expect(Array.isArray(after.evidenceRefs)).toBe(true);
    expect(fs.readFileSync(goodFile, 'utf8')).toContain('旧格式里的证据解释文本');

    // ② marker 已写入（坏候选被逐条容错跳过不算失败，全扫描完成后仍写）。
    expect(fs.existsSync(markerFile())).toBe(true);

    // ③ 幂等：marker 在场时再次调用不重复改写（mtime 不变）。
    const mtime = fs.statSync(goodFile).mtimeMs;
    await candidates.listRecallCandidates('user-a');
    expect(fs.statSync(goodFile).mtimeMs).toBe(mtime);
  });
});

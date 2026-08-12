/**
 * 候选确认管线测试：ExternalResource → 候选池 → 确认卡片。
 * 管线只做资源→候选映射与卡片构造；卡片回调落地在 messaging 测试中覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir = '';
let previousRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pc-ontology-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('personal context ontology pipeline', () => {
  const eventResource = {
    resourceId: 'feishu:tenant-1:calendar_event:evt_123',
    resourceType: 'calendar_event' as const,
    title: '线性代数',
    sourceUrl: 'https://feishu.cn/cal/evt_123',
    observedAt: new Date().toISOString(),
    accessLabel: 'personal' as const,
    retentionPolicy: 'source-linked' as const,
  };

  it('maps a calendar event to a structured candidate', async () => {
    const { resourceToCandidates } = await import('../../../src/main/features/personal_context/ontology-pipeline');
    const candidates = resourceToCandidates(eventResource, {
      start: '2026-08-12 10:00',
      end: '2026-08-12 11:30',
      location: 'A201',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].judgment).toBe('日程：线性代数（A201），2026-08-12 10:00 – 2026-08-12 11:30');
    expect(candidates[0].suggestedType).toBe('template');
    expect(candidates[0].uncertainty).toContain('feishu.cn');
  });

  it('maps non-event resources to reference-level candidates', async () => {
    const { resourceToCandidates } = await import('../../../src/main/features/personal_context/ontology-pipeline');
    const candidates = resourceToCandidates({
      ...eventResource,
      resourceId: 'feishu:tenant-1:document:doc_456',
      resourceType: 'document' as const,
      title: '课程大纲',
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].judgment).toBe('已接入资源：课程大纲（文档）');
    expect(candidates[0].suggestedType).toBe('personal');
  });

  it('submits candidates into the ontology pool and returns ids', async () => {
    const { submitCandidatesForResource } = await import('../../../src/main/features/personal_context/ontology-pipeline');
    const ids = await submitCandidatesForResource('user-1', eventResource, { start: '2026-08-12 10:00' });
    expect(ids).toHaveLength(1);
    const ontology = await import('../../../src/main/features/personal_ontology_candidates');
    const pool = await ontology.listCandidates('user-1');
    expect(pool.candidate_updates.map((c) => c.candidate_id)).toEqual(ids);
    expect(pool.candidate_updates[0].summary).toContain('线性代数');
  });

  it('deduplicates repeated submissions of the same resource', async () => {
    const { submitCandidatesForResource } = await import('../../../src/main/features/personal_context/ontology-pipeline');
    const first = await submitCandidatesForResource('user-1', eventResource, { start: '2026-08-12 10:00' });
    expect(first).toHaveLength(1);
    // 重复同步/重复事件投递：同 judgment 不再入池。
    const second = await submitCandidatesForResource('user-1', eventResource, { start: '2026-08-12 10:00' });
    expect(second).toHaveLength(0);
    const ontology = await import('../../../src/main/features/personal_ontology_candidates');
    const pool = await ontology.listCandidates('user-1');
    expect(pool.candidate_updates).toHaveLength(1);
  });

  it('builds a confirm card whose buttons carry the candidate id', async () => {
    const { setCurrentLang } = await import('../../../src/main/i18n');
    setCurrentLang('zh');
    const { buildCandidateConfirmCard } = await import('../../../src/main/features/personal_context/ontology-pipeline');
    const card = buildCandidateConfirmCard({ candidateId: 'ob-1', summary: '日程：线性代数' });
    const actions = (card.elements?.[1] ?? {}) as { actions?: Array<{ value?: Record<string, unknown> }> };
    const buttons = actions.actions ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.value).toEqual({ action: 'candidate_approve', candidate_id: 'ob-1' });
    expect(buttons[1]?.value).toEqual({ action: 'candidate_reject', candidate_id: 'ob-1' });
  });
});

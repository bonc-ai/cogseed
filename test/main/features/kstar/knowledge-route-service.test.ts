import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-kstar-knowledge-route-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KSTAR unified ability-asset routing', () => {
  it('promotes one confirmed candidate and materializes the same asset into Personal Ontology', async () => {
    const [{ saveRecallCandidate }, { listGroups, createGroup }, { readContentById }, { routeConfirmedKstarCandidate }] = await Promise.all([
      import('../../../../src/main/features/recall/candidate-service'),
      import('../../../../src/main/features/personal_ontology_groups'),
      import('../../../../src/main/features/personal_ontology_template_files'),
      import('../../../../src/main/features/kstar/knowledge-route-service'),
    ]);
    const group = await createGroup('route-user', '工作方式');
    const groupId = group.group!.group_id;
    const candidate = await saveRecallCandidate('route-user', {
      judgment: 'Technical decisions must include evidence and risks.',
      summary: 'Evidence-backed technical decisions',
      suggestedType: 'personal',
      suggestedScope: 'product,architecture',
      sourceRefs: [{ kind: 'execution', id: 'kse-run-a' }],
      learningSignal: {
        expectedResult: 'The decision is auditable.',
        actualResult: 'The decision included evidence and risks.',
        deltaR: 0.5,
        deltaA: 0.2,
        outcome: 'better_than_expected',
        confidence: 0.9,
        source: 'review',
      },
    });

    const routed = await routeConfirmedKstarCandidate('route-user', candidate.id, {
      ontology: { groupId },
    });

    expect(routed.asset).toMatchObject({
      id: expect.stringMatching(/^aa-/),
      type: 'personal',
      ontologyRefs: [{ groupId }],
      learningSignal: { deltaR: 0.5, outcome: 'better_than_expected' },
    });
    expect(routed.candidate).toMatchObject({ status: 'promoted', promotedAssetId: routed.asset.id });
    expect(routed.ontology).toMatchObject({ ok: true });
    expect((await listGroups('route-user')).some((item) => item.group_id === groupId)).toBe(true);
    const content = await readContentById('route-user', groupId);
    expect(content.content).toContain('Technical decisions must include evidence and risks.');
  });
});

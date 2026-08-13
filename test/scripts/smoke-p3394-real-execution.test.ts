import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectSmokeContracts, runSmoke } from '../../scripts/smoke-p3394-real-execution.mjs';

let root = '';
const uid = 'smoke-user';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3394-smoke-'));
  fs.writeFileSync(path.join(root, 'users.json'), JSON.stringify({ current_user_id: uid }));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function seed() {
  const base = path.join(root, uid, 'local', 'kstar', 'executions');
  fs.mkdirSync(path.join(base, 'receipt-exec'), { recursive: true });
  fs.mkdirSync(path.join(base, 'prepared-receipt'), { recursive: true });
  fs.mkdirSync(path.join(base, 'baseline-1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'treatment-1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'validations'), { recursive: true });
  fs.mkdirSync(path.join(root, uid, 'cloud', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(root, uid, 'cloud', 'sessions', 'gmember-real.jsonl'), '{}\n');

  writeJson(path.join(base, 'prepared-receipt', 'record.json'), {
    executionId: 'prepared-receipt',
    sessionId: 'gmember-real',
    boundary: 'real',
  });
  writeJson(path.join(base, 'prepared-receipt', 'context-reuse-receipt.json'), { status: 'prepared' });

  writeJson(path.join(base, 'receipt-exec', 'record.json'), {
    executionId: 'receipt-exec',
    sessionId: 'gmember-real',
    boundary: 'real',
  });
  writeJson(path.join(base, 'baseline-1', 'record.json'), {
    executionId: 'baseline-1',
    sessionId: 'gmember-real',
    boundary: 'real',
    resultRef: 'output:one',
  });
  writeJson(path.join(base, 'treatment-1', 'record.json'), {
    executionId: 'treatment-1',
    sessionId: 'gmember-real',
    boundary: 'real',
    artifactIds: ['a1'],
  });
  writeJson(path.join(base, 'receipt-exec', 'context-reuse-receipt.json'), {
    status: 'completed',
    targetContextId: 'ctx-real',
    baselineExecutionId: 'baseline-1',
    treatmentExecutionId: 'treatment-1',
  });
  writeJson(path.join(base, 'validations', 'validation-1.json'), { status: 'pass' });

  const pending = path.join(root, uid, 'local', 'kstar', 'pending-evidence.jsonl');
  fs.mkdirSync(path.dirname(pending), { recursive: true });
  fs.writeFileSync(pending, `${JSON.stringify({
    boundary: { mode: 'real', provider: 'meta-skill-engine-mcp' },
  })}\n`);

  // ── P3394 保底切片数据（inspectP3394BaselineContracts）──────────────
  // 1. 空间：gate passed + main_skill_ref
  fs.mkdirSync(path.join(root, uid, 'cloud', 'spaces'), { recursive: true });
  writeJson(path.join(root, uid, 'cloud', 'spaces', 'sp_1.json'), {
    space_id: 'sp_1',
    name: '复杂项目交付',
    gate_status: 'passed',
    main_skill_ref: { asset_id: 'sk-handoff', version: '1.0.0' },
  });
  // 2. 事件账本
  fs.mkdirSync(path.join(root, uid, 'cloud', 'mate_agent', 'asset-events'), { recursive: true });
  fs.writeFileSync(path.join(root, uid, 'cloud', 'mate_agent', 'asset-events', 'sk-handoff.jsonl'), `${JSON.stringify({ event_id: 'e1', event_type: 'asset_user_confirmed' })}\n`);
  // 3. 能力包（未过期）
  fs.mkdirSync(path.join(root, uid, 'cloud', 'mate_agent', 'capability-packs'), { recursive: true });
  writeJson(path.join(root, uid, 'cloud', 'mate_agent', 'capability-packs', 'cp_1.json'), {
    pack_id: 'cp_1',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  // 4. ReviewDecision 账本
  fs.mkdirSync(path.join(root, uid, 'cloud', 'mate_agent', 'review-decisions'), { recursive: true });
  fs.writeFileSync(path.join(root, uid, 'cloud', 'mate_agent', 'review-decisions', 'cand-1.jsonl'), `${JSON.stringify({ decision_id: 'rd_1', decision_type: 'accept' })}\n`);
  // 5. Skill 生命周期建议
  fs.mkdirSync(path.join(root, uid, 'cloud', 'mate_agent', 'skill-lifecycle'), { recursive: true });
  fs.writeFileSync(path.join(root, uid, 'cloud', 'mate_agent', 'skill-lifecycle', 'sk-handoff.jsonl'), `${JSON.stringify({ recommendation_id: 'slr_1', recommendation_type: 'no_change' })}\n`);
  // 6. EvaluationContract
  fs.mkdirSync(path.join(root, uid, 'local', 'kstar', 'evaluation-contracts'), { recursive: true });
  writeJson(path.join(root, uid, 'local', 'kstar', 'evaluation-contracts', 'ec_1.json'), { evaluation_contract_id: 'ec_1' });
  // 7. 成本遥测
  fs.mkdirSync(path.join(root, uid, 'local', 'mate_agent', 'cost-telemetry'), { recursive: true });
  fs.writeFileSync(path.join(root, uid, 'local', 'mate_agent', 'cost-telemetry', '2026-08.jsonl'), `${JSON.stringify({ record_id: 'ct_1' })}\n`);
}

describe('p3394 smoke contract', () => {
  it('reports named missing prerequisites without mutating data', () => {
    const before = fs.readdirSync(root);

    const out = inspectSmokeContracts(root, uid);

    expect(out.ok).toBe(false);
    expect(out.missing).toContain('baseline_execution');
    expect(out.missing).toContain('collaboration_context');
    expect(out.missing).toContain('kstar_boundary_result');
    expect(fs.readdirSync(root)).toEqual(before);
  });

  it('requires completed receipts to reference both contrast execution IDs', () => {
    seed();
    writeJson(path.join(root, uid, 'local', 'kstar', 'executions', 'receipt-exec', 'context-reuse-receipt.json'), {
      status: 'completed',
      targetContextId: 'ctx-real',
      baselineExecutionId: 'baseline-1',
    });

    const out = inspectSmokeContracts(root, uid);

    expect(out.ok).toBe(false);
    expect(out.missing).toContain('completed_receipt_contrast_ids');
  });

  it('passes a fully seeded acceptance contract', () => {
    seed();

    const out = runSmoke({ root, uid });

    expect(out.ok).toBe(true);
    expect(out.summary).toMatchObject({
      baseline: true,
      treatment: true,
      completedReceipt: true,
      completedReceiptHasContrast: true,
      validations: 1,
    });
  });
});

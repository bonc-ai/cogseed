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

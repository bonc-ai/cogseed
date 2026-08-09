import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function safeId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value); }
function boundaryMode(value) {
  if (value === 'real' || value === 'degraded' || value === 'test-double') return value;
  if (value && typeof value === 'object') return boundaryMode(value.mode);
  return null;
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function mask(value) { const s = String(value || ''); return s.length <= 8 ? `${s.slice(0, 2)}***${s.slice(-2)}` : `${s.slice(0, 4)}...${s.slice(-4)}`; }

export function resolveSmokeUser(root, requested) {
  if (requested && safeId(requested)) return requested;
  const registry = readJson(path.join(root, 'users.json'));
  const uid = registry?.current_user_id || registry?.dev_current_user_id;
  return safeId(uid) ? uid : null;
}

function findKstarBoundary(root, uid) {
  const pendingPath = path.join(root, uid, 'local', 'kstar', 'pending-evidence.jsonl');
  if (!fs.existsSync(pendingPath)) return null;
  for (const line of fs.readFileSync(pendingPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = (() => { try { return JSON.parse(line); } catch { return null; } })();
    const mode = boundaryMode(row?.boundary);
    if (mode) return { mode, provider: row?.boundary?.provider || 'meta-skill-engine-mcp' };
  }
  return null;
}

export function inspectSmokeContracts(root, uid) {
  const base = path.join(root, uid, 'local', 'kstar', 'executions');
  const missing = [];
  const executions = [];
  if (fs.existsSync(base)) {
    for (const name of fs.readdirSync(base, { withFileTypes: true })) {
      if (!name.isDirectory() || !safeId(name.name) || name.name === 'contrasts' || name.name === 'validations') continue;
      const record = readJson(path.join(base, name.name, 'record.json'));
      if (record) executions.push(record);
    }
  }

  const realSession = executions.find((r) => r.sessionId && r.sessionId !== 'pending' && fs.existsSync(path.join(root, uid, 'cloud', 'sessions', `${r.sessionId}.jsonl`)))
    || executions.find((r) => r.sessionId && r.sessionId !== 'pending');
  const receipts = executions.map((r) => readJson(path.join(base, r.executionId, 'context-reuse-receipt.json'))).filter(Boolean);
  const preparedReceipt = receipts.find((receipt) => receipt.status === 'prepared');
  const completedReceipt = receipts.find((receipt) => receipt.status === 'completed');
  const completedReceiptHasContrast = !!completedReceipt
    && safeId(completedReceipt.baselineExecutionId)
    && safeId(completedReceipt.treatmentExecutionId);
  const collaborationContext = receipts.find((receipt) => safeId(receipt.targetContextId));
  const validations = fs.existsSync(path.join(base, 'validations')) ? fs.readdirSync(path.join(base, 'validations')).filter((n) => n.endsWith('.json')) : [];
  const baseline = executions.find((r) => r.executionId.startsWith('baseline-'));
  const treatment = executions.find((r) => r.executionId.startsWith('treatment-'));
  const resultRef = executions.find((r) => r.resultRef || (r.artifactIds || []).length);
  const kstarBoundary = findKstarBoundary(root, uid);

  if (!realSession) missing.push('real_resolvable_session');
  if (!collaborationContext) missing.push('collaboration_context');
  if (!preparedReceipt) missing.push('prepared_receipt');
  if (!baseline) missing.push('baseline_execution');
  if (!treatment) missing.push('treatment_execution');
  if (!completedReceipt) missing.push('completed_receipt');
  else if (!completedReceiptHasContrast) missing.push('completed_receipt_contrast_ids');
  if (!validations.length) missing.push('validator_result');
  if (!kstarBoundary) missing.push('kstar_boundary_result');
  if (!resultRef) missing.push('result_or_artifact_reference');
  return {
    ok: missing.length === 0,
    missing,
    summary: {
      uid: mask(uid),
      executions: executions.length,
      baseline: !!baseline,
      treatment: !!treatment,
      preparedReceipt: !!preparedReceipt,
      completedReceipt: !!completedReceipt,
      completedReceiptHasContrast,
      validations: validations.length,
      collaborationContext: !!collaborationContext,
      boundary: kstarBoundary?.mode || null,
      hasResultRef: !!resultRef,
    },
  };
}

export function runSmoke({ root = process.env.ORKAS_WORKSPACE_ROOT, uid = process.env.ORKAS_P3394_SMOKE_UID } = {}) {
  if (!root) return { ok: false, missing: ['ORKAS_WORKSPACE_ROOT'] };
  const resolvedUid = resolveSmokeUser(root, uid);
  if (!resolvedUid) return { ok: false, missing: ['current_user_id'] };
  return inspectSmokeContracts(path.resolve(root), resolvedUid);
}

function main() {
  const result = runSmoke();
  console.log(JSON.stringify(result.summary || { missing: result.missing }, null, 2));
  if (!result.ok) {
    console.error(`P3394 smoke prerequisites missing: ${result.missing.join(', ')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

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

/**
 * P3394 保底切片契约检查（PRD 11.3 保底 Must 的磁盘侧验证）：
 * 空间上架（gate_status=passed + main_skill_ref）、事件账本、能力包、
 * ReviewDecision、Skill 生命周期建议、EvaluationContract、成本遥测。
 * 注意：这是"契约存在性"检查，不替代真实运行 Evidence（AC-07 需要目标
 * Agent 日志）——Mock/骨架不得通过。
 */
export function inspectP3394BaselineContracts(root, uid) {
  const missing = [];
  const summary = {};

  // 1. 空间：至少一个通过上架 Gate 且绑定 Main Skill
  const spacesDir = path.join(root, uid, 'cloud', 'spaces');
  const spaces = [];
  if (fs.existsSync(spacesDir)) {
    for (const name of fs.readdirSync(spacesDir)) {
      if (!name.endsWith('.json')) continue;
      const s = readJson(path.join(spacesDir, name));
      if (s && s.space_id) spaces.push(s);
    }
  }
  const gated = spaces.find((s) => s.gate_status === 'passed' && s.main_skill_ref?.asset_id);
  summary.spaces = spaces.length;
  summary.gatedSpace = !!gated;
  if (!gated) missing.push('gated_space_with_main_skill');

  // 2. 事件账本：至少一个资产有事件
  const eventsDir = path.join(root, uid, 'cloud', 'mate_agent', 'asset-events');
  let eventFiles = [];
  if (fs.existsSync(eventsDir)) eventFiles = fs.readdirSync(eventsDir).filter((n) => n.endsWith('.jsonl'));
  summary.assetEventLogs = eventFiles.length;
  if (!eventFiles.length) missing.push('asset_event_ledger');

  // 3. 能力包：存在且未过期
  const packsDir = path.join(root, uid, 'cloud', 'mate_agent', 'capability-packs');
  let packs = [];
  if (fs.existsSync(packsDir)) {
    packs = fs.readdirSync(packsDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => readJson(path.join(packsDir, n)))
      .filter(Boolean);
  }
  const validPack = packs.find((p) => p.pack_id && new Date(p.expires_at).getTime() > Date.now());
  summary.capabilityPacks = packs.length;
  summary.validCapabilityPack = !!validPack;
  if (!validPack) missing.push('valid_capability_pack');

  // 4. ReviewDecision 账本
  const rdDir = path.join(root, uid, 'cloud', 'mate_agent', 'review-decisions');
  let rdFiles = [];
  if (fs.existsSync(rdDir)) rdFiles = fs.readdirSync(rdDir).filter((n) => n.endsWith('.jsonl'));
  summary.reviewDecisions = rdFiles.length;
  if (!rdFiles.length) missing.push('review_decision_ledger');

  // 5. Skill 生命周期建议（skilllifecycle flag 默认 on）
  const slDir = path.join(root, uid, 'cloud', 'mate_agent', 'skill-lifecycle');
  let slFiles = [];
  if (fs.existsSync(slDir)) slFiles = fs.readdirSync(slDir).filter((n) => n.endsWith('.jsonl'));
  summary.skillLifecycle = slFiles.length;
  if (!slFiles.length) missing.push('skill_lifecycle_recommendation');

  // 6. EvaluationContract（Baseline 的 evaluation_contract_ref 指向真实对象）
  const ecDir = path.join(root, uid, 'local', 'kstar', 'evaluation-contracts');
  let ecFiles = [];
  if (fs.existsSync(ecDir)) ecFiles = fs.readdirSync(ecDir).filter((n) => n.endsWith('.json'));
  summary.evaluationContracts = ecFiles.length;
  if (!ecFiles.length) missing.push('evaluation_contract');

  // 7. 成本遥测（本地）
  const ctDir = path.join(root, uid, 'local', 'mate_agent', 'cost-telemetry');
  let ctFiles = [];
  if (fs.existsSync(ctDir)) ctFiles = fs.readdirSync(ctDir).filter((n) => n.endsWith('.jsonl'));
  summary.costTelemetry = ctFiles.length;
  if (!ctFiles.length) missing.push('cost_telemetry');

  return { ok: missing.length === 0, missing, summary: { uid: mask(uid), ...summary } };
}

export function runSmoke({ root = process.env.ORKAS_WORKSPACE_ROOT, uid = process.env.ORKAS_P3394_SMOKE_UID } = {}) {
  if (!root) return { ok: false, missing: ['ORKAS_WORKSPACE_ROOT'] };
  const resolvedUid = resolveSmokeUser(root, uid);
  if (!resolvedUid) return { ok: false, missing: ['current_user_id'] };
  const contracts = inspectSmokeContracts(path.resolve(root), resolvedUid);
  const baseline = inspectP3394BaselineContracts(path.resolve(root), resolvedUid);
  return {
    ok: contracts.ok && baseline.ok,
    missing: [...contracts.missing, ...baseline.missing],
    summary: { ...contracts.summary, ...baseline.summary },
  };
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

/**
 * Evaluation Contract — the success criteria a TaskRun is judged against.
 *
 * PRD §8.2 Skill Baseline 的组成部分：正式 TaskRun 必须绑定 Evaluation
 * Contract（success_criteria + comparison_method），且必须在执行前冻结
 * （RG-S3-15：冻结先于执行，事后反填 = REWORK）。
 *
 * P0 最小版：只做创建/冻结/读取与列表，不实现 ExpectedResultSnapshot 的
 * 完整评价机制（那是 Gate A 完整闭环，P1）。冻结即不可变——修改需要新契约。
 *
 * 存储：`<uid>/local/kstar/evaluation-contracts/<contract_id>.json`（机器私有，
 * 与 baseline 同属执行证据）。
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { readJson, writeJson, nowIso, safeId } from '../../storage';
import { userLocalRoot } from '../../paths';
import { maskId } from '../../util/log-redact';

const log = createLogger('evaluation-contract');

const MAX_CRITERIA = 20;
const MAX_CRITERION_LENGTH = 500;

export interface EvaluationContract {
  evaluation_contract_id: string;
  /** 契约约束的 Main Skill 资产（引用不复制）。 */
  skill_asset_id: string;
  skill_version: string;
  /** 成功标准（每条一句，结构化；上限 20 条）。 */
  success_criteria: string[];
  /** 比较方法（如 "baseline_treatment_diff"）；可选。 */
  comparison_method?: string;
  owner: string;
  /** 契约自身版本（契约内容变化 → 新契约或新版本）。 */
  version: string;
  created_at: string;
  /** 冻结时间——必须早于 TaskRun 开始（RG-S3-15）。 */
  frozen_at: string;
}

export interface CreateEvaluationContractInput {
  skillAssetId: string;
  skillVersion: string;
  successCriteria: string[];
  comparisonMethod?: string;
  owner?: string;
  version?: string;
  createdAt?: string;
}

function assertCriteria(criteria: string[]): void {
  if (!Array.isArray(criteria) || criteria.length === 0) throw new Error('evaluation contract requires success criteria');
  if (criteria.length > MAX_CRITERIA) throw new Error('too many success criteria');
  for (const c of criteria) {
    if (typeof c !== 'string' || !c.trim()) throw new Error('invalid success criterion');
    if (c.length > MAX_CRITERION_LENGTH) throw new Error('success criterion too long');
  }
}

export function evaluationContractPath(uid: string, contractId: string): string {
  return path.join(userLocalRoot(uid), 'kstar', 'evaluation-contracts', `${contractId}.json`);
}

function evaluationContractsDir(uid: string): string {
  return path.join(userLocalRoot(uid), 'kstar', 'evaluation-contracts');
}

/** 创建并冻结一份 Evaluation Contract（创建即冻结，事后不可改）。 */
export async function createEvaluationContract(
  uid: string,
  input: CreateEvaluationContractInput,
): Promise<EvaluationContract> {
  if (!safeId(input.skillAssetId)) throw new Error('invalid skill asset id');
  if (typeof input.skillVersion !== 'string' || !input.skillVersion) throw new Error('invalid skill version');
  assertCriteria(input.successCriteria);

  const contract: EvaluationContract = {
    evaluation_contract_id: `ec_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    skill_asset_id: input.skillAssetId,
    skill_version: input.skillVersion,
    success_criteria: input.successCriteria,
    ...(input.comparisonMethod ? { comparison_method: input.comparisonMethod } : {}),
    owner: input.owner ?? 'local-user',
    version: input.version ?? '1',
    created_at: input.createdAt ?? nowIso(),
    frozen_at: nowIso(),
  };
  await writeJson(evaluationContractPath(uid, contract.evaluation_contract_id), contract);
  log.info(`created evaluation contract user=${maskId(uid)} ec=${maskId(contract.evaluation_contract_id)} skill=${maskId(input.skillAssetId)}@${input.skillVersion}`);
  return contract;
}

export async function readEvaluationContract(uid: string, contractId: string): Promise<EvaluationContract | null> {
  if (!safeId(contractId)) return null;
  try {
    const data = await readJson<EvaluationContract>(evaluationContractPath(uid, contractId));
    // readJson 对不存在文件返回默认 {}——按字段存在性判定，而非假设抛错
    if (!data || typeof data.evaluation_contract_id !== 'string') return null;
    return data;
  } catch (err) {
    log.warn(`read evaluation contract user=${maskId(uid)} ec=${maskId(contractId)}: ${(err as Error).message}`);
    return null;
  }
}

/** 某资产的全部契约（按文件名倒序，最新在前）。 */
export async function listEvaluationContracts(uid: string, skillAssetId: string): Promise<EvaluationContract[]> {
  const dir = evaluationContractsDir(uid);
  let names: string[];
  try {
    names = await import('node:fs/promises').then((fs) => fs.readdir(dir));
  } catch {
    return [];
  }
  const out: EvaluationContract[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const contract = await readEvaluationContract(uid, name.slice(0, -'.json'.length));
    if (contract && contract.skill_asset_id === skillAssetId) out.push(contract);
  }
  // 最新在前；同毫秒（nowIso 精度）时按 contract id 升序，保证确定性
  return out.sort((a, b) => {
    const t = a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    if (t !== 0) return t;
    return a.evaluation_contract_id < b.evaluation_contract_id ? -1 : 1;
  });
}

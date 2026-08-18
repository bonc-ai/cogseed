/**
 * Minimum Capability Pack — 跨 Agent 复用的最小能力包（PRD §3.7/§9.1）。
 *
 * 只装引用，不装内容（AC-06）：main_skill_ref / 资产版本引用 / 本体切片引用
 * 均为 asset_id + version，绝不复制资产正文。能力包由已确认资产与空间绑定
 * 组装；目标 Agent 加载后先输出任务理解 + Action Plan（FR-REU-02）。
 *
 * 存储：`<uid>/cloud/cogseed/capability-packs/<pack_id>.json`（可同步，
 * 复用证明需跨入口追溯；内容仅为引用，无敏感副本）。
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createLogger } from '../../logger';
import { readJson, writeJson, nowIso, safeId } from '../../storage';
import { cogseedAgentCapabilityPacksDir } from '../../paths';
import { maskId } from '../../util/log-redact';

const log = createLogger('capability-pack');

export interface CapabilityPackAssetRef {
  asset_id: string;
  version: string;
  content_hash?: string;
}

export interface MinimumCapabilityPack {
  pack_id: string;
  purpose: string;
  main_skill_ref: CapabilityPackAssetRef;
  /** 本体切片引用（recall context-projection 输出）。 */
  ontology_slice_refs: string[];
  rule_refs: string[];
  template_refs: string[];
  personal_context_ref?: string;
  artifact_version_refs: string[];
  /** 溯源（供 Receipt reusedRefs）：全部资产引用去重。 */
  asset_ids: string[];
  versions: Array<{ asset_id: string; version: string }>;
  scope: string;
  permissions: string[];
  /** 目标端运行时角色（agent-a/agent-b），非厂商。 */
  target_agent: string;
  created_at: string;
  expires_at: string;
}

export interface BuildCapabilityPackInput {
  purpose: string;
  mainSkillRef: CapabilityPackAssetRef;
  ontologySliceRefs?: string[];
  ruleRefs?: string[];
  templateRefs?: string[];
  personalContextRef?: string;
  artifactVersionRefs?: string[];
  scope?: string;
  permissions?: string[];
  targetAgent: string;
  /** 有效期（小时），默认 24。 */
  expiresInHours?: number;
}

function assertRef(ref: CapabilityPackAssetRef, field: string): void {
  if (!ref || !safeId(ref.asset_id) || typeof ref.version !== 'string' || !ref.version) {
    throw new Error(`invalid ${field}`);
  }
}

function normRefs(values: string[] | undefined, field: string): string[] {
  if (!values) return [];
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === 'string' && v.trim() && v.length <= 512) out.add(v.trim());
  }
  return [...out];
}

/** 从已确认资产与空间绑定组装最小能力包（引用不复制）。 */
export async function buildCapabilityPack(
  uid: string,
  input: BuildCapabilityPackInput,
): Promise<MinimumCapabilityPack> {
  if (!input.purpose || typeof input.purpose !== 'string' || !input.purpose.trim()) {
    throw new Error('capability pack requires purpose');
  }
  assertRef(input.mainSkillRef, 'main skill ref');
  if (!input.targetAgent || typeof input.targetAgent !== 'string' || !input.targetAgent.trim()) {
    throw new Error('capability pack requires target agent');
  }

  const created = nowIso();
  const expiresInHours = input.expiresInHours ?? 24;
  const expires = new Date(Date.now() + expiresInHours * 3_600_000).toISOString();

  const ontologySliceRefs = normRefs(input.ontologySliceRefs, 'ontology slice refs');
  const ruleRefs = normRefs(input.ruleRefs, 'rule refs');
  const templateRefs = normRefs(input.templateRefs, 'template refs');
  const artifactVersionRefs = normRefs(input.artifactVersionRefs, 'artifact version refs');

  // 溯源去重（Main Skill + 规则 + 模板 + 本体切片 + Artifact）
  const assetIds = new Set<string>([input.mainSkillRef.asset_id]);
  for (const ref of [...ruleRefs, ...templateRefs, ...ontologySliceRefs]) {
    const id = ref.split(':').pop() ?? ref;
    if (id) assetIds.add(id);
  }
  for (const ref of artifactVersionRefs) {
    const id = ref.split(':').pop() ?? ref;
    if (id) assetIds.add(id);
  }

  const pack: MinimumCapabilityPack = {
    pack_id: `cp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    purpose: input.purpose.trim(),
    main_skill_ref: input.mainSkillRef,
    ontology_slice_refs: ontologySliceRefs,
    rule_refs: ruleRefs,
    template_refs: templateRefs,
    ...(input.personalContextRef ? { personal_context_ref: input.personalContextRef } : {}),
    artifact_version_refs: artifactVersionRefs,
    asset_ids: [...assetIds],
    versions: [
      { asset_id: input.mainSkillRef.asset_id, version: input.mainSkillRef.version },
    ],
    scope: input.scope ?? 'default',
    permissions: input.permissions ?? [],
    target_agent: input.targetAgent.trim(),
    created_at: created,
    expires_at: expires,
  };

  await writeJson(capabilityPackPath(uid, pack.pack_id), pack);
  log.info(`built capability pack user=${maskId(uid)} pack=${maskId(pack.pack_id)} purpose=${pack.purpose.slice(0, 40)}`);
  return pack;
}

export function capabilityPackPath(uid: string, packId: string): string {
  return path.join(cogseedAgentCapabilityPacksDir(uid), `${packId}.json`);
}

export async function readCapabilityPack(uid: string, packId: string): Promise<MinimumCapabilityPack | null> {
  if (!safeId(packId)) return null;
  try {
    const data = await readJson<MinimumCapabilityPack>(capabilityPackPath(uid, packId));
    if (!data || typeof data.pack_id !== 'string') return null;
    return data;
  } catch (err) {
    log.warn(`read capability pack user=${maskId(uid)} pack=${maskId(packId)}: ${(err as Error).message}`);
    return null;
  }
}

/** 是否已过期（过期后不得继续注入目标 Agent）。 */
export function isCapabilityPackExpired(pack: MinimumCapabilityPack, now = new Date()): boolean {
  return new Date(pack.expires_at).getTime() <= now.getTime();
}

/**
 * cognition_kernel/resolve — 统一读接口。
 *
 * 任务要取「关于我」的字段时只走这一个口，不再分别去读本体与资产库。
 * 输出 bound / missing 两段；missing 的四种原因各自对应一个**不同的用户动作**：
 *   no_value        → 应当提问并回填
 *   restricted      → 值标了"仅自己可见"，需用户改敏感级
 *   not_authorized  → 来源资产被暂停/越权/不在适用范围，先治理再谈取用
 *   stale           → 本体值指向的来源资产已不存在，修引用
 * 调用方因此不需要再猜"为什么没取到"。
 *
 * 取值规则：
 *   1. 本体手编值优先（用户直说的算）；
 *   2. 带 assetId 的值是**引用态**：从可用的来源资产取 live 正文，避免陈旧副本；
 *   3. restricted 的值不进任务读取；
 *   4. 资产侧只有显式声明了本体落点（ontologyRefs.field 命中）才作为字段来源，
 *      不做字段名猜测；
 *   5. 同一字段多条可用值 → 取最新，并标 disputed + conflictsWith（仲裁留给治理）。
 *
 * 本文件分两层：resolveFromSnapshot 是纯函数（可单测），resolvePersonalFields 是
 * 装配层（动态 import 现有 po/ 与 recall/，只读不改写）。
 */

import {
  PERSONAL_FIELD_POLICY_VERSION,
  type MissingPersonalField,
  type MissingReason,
  type OntologyFieldValueView,
  type PersonalAssetView,
  type PersonalFieldResolution,
  type PersonalFieldRef,
  type PersonalSourceSnapshot,
  type ResolvePersonalFieldsRequest,
  type ResolvedPersonalField,
} from './types';

const MAX_CONFLICT_TEXT = 120;
const MAX_CONFLICTS = 2;

function clip(text: string): string {
  return text.length > MAX_CONFLICT_TEXT ? text.slice(0, MAX_CONFLICT_TEXT) + '…' : text;
}

function missingOf(ref: PersonalFieldRef, reason: MissingReason): MissingPersonalField {
  const required = ref.required !== false;
  return {
    fieldName: ref.fieldName,
    ...(ref.groupId ? { groupId: ref.groupId } : {}),
    required,
    reason,
  };
}

/** 同一字段多条可用值时的冲突标注（只带非受限对端，最多 2 条）。 */
function conflictsOf(primaryText: string, others: readonly string[]): string[] {
  const seen = new Set([primaryText.trim()]);
  const out: string[] = [];
  for (const raw of others) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(clip(text));
    if (out.length >= MAX_CONFLICTS) break;
  }
  return out;
}

/** 纯函数核心：从快照解析所需字段，不做任何 I/O。 */
export function resolveFromSnapshot(
  request: ResolvePersonalFieldsRequest,
  snapshot: PersonalSourceSnapshot,
): PersonalFieldResolution {
  const bound: ResolvedPersonalField[] = [];
  const missing: MissingPersonalField[] = [];
  const assetById = new Map<string, PersonalAssetView>(snapshot.assets.map((a) => [a.id, a]));

  for (const ref of request.fields ?? []) {
    const fieldName = String(ref?.fieldName ?? '').trim();
    if (!fieldName) continue;
    const normalized: PersonalFieldRef = { ...ref, fieldName };
    const inScope = (v: { fieldName: string; groupId: string }) =>
      v.fieldName === fieldName && (!normalized.groupId || v.groupId === normalized.groupId);

    const values = snapshot.values.filter(inScope);
    if (values.length) {
      const usable = values.filter((v) => !v.restricted);
      if (!usable.length) {
        missing.push(missingOf(normalized, 'restricted'));
        continue;
      }
      const manual = usable.filter((v) => !v.assetId);
      const ranked = [...(manual.length ? manual : usable)].sort((a, b) =>
        String(b.updatedAt).localeCompare(String(a.updatedAt)),
      );
      const primary: OntologyFieldValueView = ranked[0];
      const others = ranked.slice(1).map((v) => v.text);
      const conflictPatch = others.length ? conflictsOf(primary.text, others) : [];

      if (primary.assetId) {
        const asset = assetById.get(primary.assetId);
        if (!asset) {
          missing.push(missingOf(normalized, 'stale'));
          continue;
        }
        if (!asset.eligible) {
          missing.push(missingOf(normalized, 'not_authorized'));
          continue;
        }
        bound.push({
          fieldName,
          ...(normalized.groupId ? { groupId: normalized.groupId } : {}),
          value: asset.statement.trim(),
          source: 'personal_asset',
          sourceId: asset.id,
          version: asset.version,
        ...(asset.revision ? { revision: asset.revision } : {}),
          ...(primary.asOf ? { asOf: primary.asOf } : {}),
          ...(primary.verified !== undefined ? { verified: primary.verified } : {}),
          updatedAt: asset.updatedAt || primary.updatedAt,
          ...(conflictPatch.length ? { disputed: true as const, conflictsWith: conflictPatch } : {}),
        });
        continue;
      }

      bound.push({
        fieldName,
        ...(normalized.groupId ? { groupId: normalized.groupId } : {}),
        value: primary.text.trim(),
        source: 'ontology_value',
        sourceId: primary.id,
        ...(primary.asOf ? { asOf: primary.asOf } : {}),
        ...(primary.verified !== undefined ? { verified: primary.verified } : {}),
        updatedAt: primary.updatedAt,
        ...(conflictPatch.length ? { disputed: true as const, conflictsWith: conflictPatch } : {}),
      });
      continue;
    }

    // 本体没有这个字段值：看资产是否显式声明了这个落点
    const declared = snapshot.assets.filter((a) =>
      a.ontologyRefs.some((r) => r.field === fieldName && (!normalized.groupId || r.groupId === normalized.groupId)),
    );
    if (declared.length) {
      const eligible = declared.filter((a) => a.eligible);
      if (!eligible.length) {
        missing.push(missingOf(normalized, 'not_authorized'));
        continue;
      }
      const sorted = [...eligible].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const asset = sorted[0];
      const conflictPatch = conflictsOf(asset.statement, sorted.slice(1).map((a) => a.statement));
      bound.push({
        fieldName,
        ...(normalized.groupId ? { groupId: normalized.groupId } : {}),
        value: asset.statement.trim(),
        source: 'personal_asset',
        sourceId: asset.id,
        version: asset.version,
        ...(asset.revision ? { revision: asset.revision } : {}),
        updatedAt: asset.updatedAt,
        ...(conflictPatch.length ? { disputed: true as const, conflictsWith: conflictPatch } : {}),
      });
      continue;
    }

    missing.push(missingOf(normalized, 'no_value'));
  }

  return { bound, missing, policyVersion: PERSONAL_FIELD_POLICY_VERSION };
}

// ── 装配层（只读现有存储，不改写）──────────────────────────────────────────

/** 读一份快照：本体值 + personal 资产（含任务期准入判定结果）。
 *
 * 统一库优先：迁移/新写入产生的断言（store）按 (groupId,fieldName)
 * 槽位遮蔽旧账（po 值/资产投影）——同槽以库为准；库为空（未迁移）时行为
 * 与旧实现逐位一致。消费面因此可以逐个切到统一库而不需要一次性搬家。
 */
export async function loadPersonalSourceSnapshot(
  uid: string,
  context?: ResolvePersonalFieldsRequest['context'],
): Promise<PersonalSourceSnapshot> {
  const [{ loadPoDocSync }, { listAbilityAssets }, { filterRecallAssetsForAgentRead }, { loadCognitionStoreSync }] =
    await Promise.all([
      import('../po/store'),
      import('../recall/asset-service'),
      import('../recall/prompt-injection'),
      import('./store'),
    ]);

  const values: OntologyFieldValueView[] = [];
  const doc = loadPoDocSync(uid);
  for (const group of doc.groups ?? []) {
    const nameById = new Map(group.fields.map((f) => [f.id, f.name]));
    for (const value of group.values ?? []) {
      const fieldName = nameById.get(value.fieldId);
      if (!fieldName) continue;
      values.push({
        id: value.id,
        groupId: group.id,
        fieldId: value.fieldId,
        fieldName,
        text: value.text,
        source: value.source,
        updatedAt: value.updatedAt,
        ...(value.asOf ? { asOf: value.asOf } : {}),
        ...(value.verified !== undefined ? { verified: value.verified } : {}),
        ...(value.restricted ? { restricted: true } : {}),
        ...(value.assetId ? { assetId: value.assetId } : {}),
      });
    }
  }

  // 统一库断言：库值全量进场；旧值被同槽（groupId+fieldName）或
  // 同名字段（库内无组断言按 fieldName 全局遮蔽）让位——任务侧寻址键是字段名。
  // 治理态同口径：paused/archived
  // **占槽但不供值**——槽位已归统一库，暂停/归档只是收回这条值，不能让迁移
  // 前的旧值复活；deleted 才释放槽位回落旧值。restricted 随 active 值透传。
  const store = loadCognitionStoreSync(uid);
  const storeValues: OntologyFieldValueView[] = [];
  const groupedKeys = new Set<string>();
  const grouplessNames = new Set<string>();
  for (const object of Object.values(store.objects)) {
    // 兼容桥管理的断言已由上方 po/asset 权威读口装配，保留完整引用准入，不重复投影。
    if (object.managedSource || object.kind !== 'assertion' || object.status === 'deleted') continue;
    // 占槽键与取值侧同源：断言缺 fieldName 时用 title 兜底（与下方
    // storeValues 的 fieldName 口径一致，否则占槽键落成 "g||undefined"）。
    const nameKey = object.fieldName ?? object.title;
    const slotKey = object.groupId ? `${object.groupId}||${nameKey}` : '';
    if (slotKey) groupedKeys.add(slotKey);
    else grouplessNames.add(nameKey);
    if (object.status !== 'active') continue;
    storeValues.push({
      id: object.id,
      groupId: object.groupId ?? '',
      fieldId: '',
      fieldName: object.fieldName ?? object.title,
      text: object.statement,
      source: object.origin,
      updatedAt: object.updatedAt,
      ...(object.asOf ? { asOf: object.asOf } : {}),
      ...(object.verified !== undefined ? { verified: object.verified } : {}),
      ...(object.restricted === true ? { restricted: true } : {}),
    });
  }
  if (storeValues.length || groupedKeys.size || grouplessNames.size) {
    const filtered = values.filter(
      (v) => !groupedKeys.has(`${v.groupId}||${v.fieldName}`) && !grouplessNames.has(v.fieldName),
    );
    values.length = 0;
    values.push(...filtered, ...storeValues);
  }

  const personalAssets = (await listAbilityAssets(uid)).filter((a) => a.type === 'personal');
  const eligibleIds = new Set<string>();
  try {
    const eligible = await filterRecallAssetsForAgentRead(
      uid,
      personalAssets,
      (context ?? {}) as Parameters<typeof filterRecallAssetsForAgentRead>[2],
    );
    for (const asset of eligible) eligibleIds.add(asset.id);
  } catch {
    // 准入判定失败时按"全部不可用"处理：宁少取，不越权。
  }

  const assets: PersonalAssetView[] = personalAssets.map((asset) => ({
    id: asset.id,
    title: String(asset.title ?? ''),
    statement: String(asset.statement ?? ''),
    version: String(asset.activeVersion ?? asset.version ?? ''),
    revision: String(asset.version ?? ''),
    status: String(asset.status ?? ''),
    updatedAt: String(asset.updatedAt ?? ''),
    ontologyRefs: (asset.ontologyRefs ?? []).map((ref) => ({
      groupId: ref.groupId,
      ...(ref.field ? { field: ref.field } : {}),
    })),
    eligible: eligibleIds.has(asset.id),
  }));

  return { values, assets };
}

/**
 * 统一读接口（任务侧唯一入口）。
 *
 * 注意：本函数只读。缺值（missing: no_value）由调用方决定是否转成提问与回填，
 * 回填必须走 Delta（见 delta.ts），不得直接写存储。
 */
export async function resolvePersonalFields(
  uid: string,
  request: ResolvePersonalFieldsRequest,
): Promise<PersonalFieldResolution> {
  if (!uid) {
    return {
      bound: [],
      missing: (request.fields ?? []).map((ref) => missingOf(ref, 'no_value')),
      policyVersion: PERSONAL_FIELD_POLICY_VERSION,
    };
  }
  const snapshot = await loadPersonalSourceSnapshot(uid, request.context);
  return resolveFromSnapshot(request, snapshot);
}

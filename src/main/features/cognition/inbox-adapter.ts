/**
 * 「待我处理」的读适配器。
 *
 * 只做一件事：把 canonical 层的资产、统一候选池、来源目录读出来，喂给
 * `buildCognitionInbox`。判断"什么算待办"的规则一条都不在这里——那些在
 * formal-assets/inbox.ts，与晋升 gate、Runtime gate 复用同一批函数。
 * 这里如果自己加一句 if，待办就会和 gate 分叉，用户看到的和系统执行的
 * 就不是同一套标准了。
 */

import { createLogger } from '../../logger';
import { safeId } from '../../storage';
import {
  archiveAbilityAsset,
  listAbilityAssetVersions,
  mergeAbilityAssets,
  readAbilityAsset,
  updateAbilityAsset,
} from '../recall/asset-service';
import {
  deferRecallCandidate,
  ignoreRecallCandidate,
  listRecallCandidates,
  promoteRecallCandidate,
  recallCandidateConflictingTypes,
  rejectRecallCandidate,
} from '../recall/candidate-service';
import { listAssetChangeProposals } from '../recall/asset-approval-service';
import { decideAssetChangeProposal } from '../recall/asset-approval-service';
import {
  decideCleanupUncertainItem,
  listCleanupReports,
  pendingCleanupUncertainItems,
} from '../recall/cleanup-report-service';
import {
  decideInspectionFinding,
  listInspectionRuns,
  pendingInspectionFindings,
  readInspectionSettings,
} from '../recall/asset-inspection-service';
import { listFormalAssets } from '../recall/formal-assets';
import { buildCognitionInbox, groupCognitionInbox, type CognitionInboxItem } from '../recall/formal-assets/inbox';
import { validatePromotionByAssetType } from '../recall/formal-assets/promotion';
import { latestAssetVersionDiff, type AssetVersionDiff } from '../recall/formal-assets/version-diff';
import { readInstalledSkillForAsset } from '../recall/skill-draft-service';
import { bindingHasDecision, bindingIsStale, readSkillBinding } from '../recall/skill-binding-service';
import { listCognitionSources } from '../recall/source-catalog';

// 治理分组（specs/010 T012）从本桶透出：IPC 层经 cognition.* 统一取件，
// 不再开第二条 import 路径。
export { groupCognitionInbox };

const log = createLogger('cognition.inbox');

/** 来源目录里"已经用不了"的两档。pending/processing 只是还没好，不是坏了。 */
const UNAVAILABLE_SOURCE_STATUSES = new Set(['failed', 'paused']);

/** 待办条目的 id 前缀 → 它背后真正的对象。前缀由 formal-assets/inbox.ts 的
 *  `item()` 调用点决定，是**稳定契约**（同样的事实必须算出同样的 id，否则前端
 *  列表会闪）——所以这里按前缀分发，而不是重新算一遍"这条待办是什么"。 */
const CANDIDATE_ITEM_PREFIXES = ['candidate:', 'conflict:', 'ineligible:', 'evidence:'] as const;
/** 资产类待办：specs/010 之前一律"没有一键动作"（要改的是资产内容本身）。
 *  010 起其中缺边界类有了**就地处断**（补边界条件）；其余（skill / skill-upgrade /
 *  rule-scope / template / source）仍是编辑，落点在资产详情。 */
const ASSET_ITEM_PREFIXES = [
  'skill:', 'skill-upgrade:', 'rule-scope:',
  'template:', 'rule-boundary:', 'source:',
] as const;

export interface CognitionInboxResolveInput {
  id?: unknown;
  action?: unknown;
  note?: unknown;
  /** `set_boundary` 的条件（specs/010 T028）；IPC 层已校验数组形状。 */
  applicableWhen?: unknown;
  forbiddenWhen?: unknown;
  /** `keep`/`merge` 的保留/合并目标（specs/010 T032）。 */
  targetAssetId?: unknown;
}

export type CognitionInboxResolveAction = 'accept' | 'reject' | 'defer' | 'ignore'
  | 'claim' | 'set_boundary' | 'keep' | 'merge';

export type CognitionInboxResolveErrorCode =
  /** id 形状就不对。 */
  | 'invalid_item_id'
  /** 这类待办今天没有一键处置动作（回执里写明该去哪里处理）。 */
  | 'unsupported_item_kind'
  /** 对象对，但这个动作不适用。 */
  | 'unsupported_action'
  /** 补条件未过门禁（specs/010 T028）——**且不落库**。 */
  | 'invalid_boundary'
  /** 锁内 expectedVersion 重检不一致（specs/010 T021/T030）——不静默覆盖。 */
  | 'version_conflict'
  /** 选边后保留侧没过晋升闸门（2026-09-29 第 2 批）：另一边已出局、保留侧
   *  待用户到候选详情完成完整确认——不是失败态，是半程回执。 */
  | 'promotion_gate_rejected';

export interface CognitionInboxResolveResult {
  ok: true;
  /** 实际被动到的对象类型与状态，供前端原地更新。 */
  target: 'recall_candidate' | 'asset_change_proposal' | 'cleanup_uncertain' | 'inspection_finding' | 'asset';
  status: string;
}

/** 与 `recallCandidateError` 同约定：错误码挂在 Error 上，由 IPC 包装层透出成
 *  `{ ok:false, error, code }`——全仓统一一种错误形状，渲染层不必按通道分支。 */
function inboxResolveError(code: CognitionInboxResolveErrorCode, message: string, extra?: Record<string, string>): Error & { code: CognitionInboxResolveErrorCode } {
  const error = new Error(message) as Error & { code: CognitionInboxResolveErrorCode } & Record<string, string>;
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

/**
 * 写路径错误的稳定化翻译（specs/010 T021/T030）：乐观版本撞车 → `version_conflict`
 * （不静默覆盖、不落终态）；找不到对象 → `unsupported_item_kind`；其余原样透出
 * （不吞原因——晋升闸门自己的码表由渲染层翻译）。
 */
async function settle<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const message = String((error as Error)?.message || error);
    if (/version conflict/i.test(message)) {
      throw inboxResolveError('version_conflict', '这条资产刚被别的改动更新过（版本冲突），请重试');
    }
    if (/not found/i.test(message)) {
      throw inboxResolveError('unsupported_item_kind', '这条待办指向的对象已经不存在了（可能刚被删除或合并）。');
    }
    throw error;
  }
}

/** 读一条可写的资产；终态（purged/revoked/deleted）如实拒绝，不给"看起来能处理"的假动作。 */
async function readMutableAssetOrReject(userId: string, assetId: string) {
  const asset = await settle(() => readAbilityAsset(userId, assetId));
  if (['purged', 'revoked', 'deleted', 'archived'].includes(String(asset.status))) {
    throw inboxResolveError('unsupported_item_kind', `这条资产已是终态（${asset.status}），不能再在这里处置。`);
  }
  return asset;
}

/**
 * 待确认清单的处置通道（specs/008 T007；语义随 T046 扩展；specs/010 就地处断）。
 *
 * 分发原则：**只有真正落到了某个对象上的处置才算成功**。没有动作可做的类别
 * 抛 `unsupported_item_kind` 并指出该去哪里处理——被拦截的操作不得计为成功，
 * 假装成功比拒绝更糟（用户会以为事情办完了）。
 */
export async function resolveCognitionInboxItem(
  userId: string,
  input: CognitionInboxResolveInput,
): Promise<CognitionInboxResolveResult> {
  const id = typeof input.id === 'string' ? input.id : '';
  const action = typeof input.action === 'string' ? input.action : '';
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined;
  if (!id) throw inboxResolveError('invalid_item_id', '待办 id 不能为空');

  const candidatePrefix = CANDIDATE_ITEM_PREFIXES.find((prefix) => id.startsWith(prefix));
  if (candidatePrefix) {
    const candidateId = id.slice(candidatePrefix.length);
    if (!safeId(candidateId)) {
      throw inboxResolveError('invalid_item_id', `待办 id 里的候选编号不合法：${candidateId}`);
    }
    // 冲突选边（specs/010 T031 / US-302）：claim = 保留本边。另一边**不由客户端
    // 提供**——主进程用同一套冲突口径重算同组候选并逐一 reject，避免客户端
    // 缓存与闸门分叉。顺序必须**先拒其余、再晋升**：晋升闸门会把"同判断已存在
    // 另一类型"拦下（假审批的根源），选边的语义就是先让另一边出局。
    if (action === 'claim' && candidatePrefix === 'conflict:') {
      const candidates = await listRecallCandidates(userId);
      const conflicting = recallCandidateConflictingTypes(candidates);
      const mine = candidates.find((candidate) => candidate.id === candidateId);
      if (!mine) throw inboxResolveError('unsupported_item_kind', '这条冲突待办指向的候选已经不存在了。');
      const reason = note || `与候选 ${candidateId} 冲突，裁定保留后者`;
      const others = candidates.filter((candidate) => {
        if (candidate.id === candidateId) return false;
        // 冲突表记的是「与它不同类型的那些类型」——非空即在同一冲突组。
        const conflictTypes = conflicting.get(candidate.id) || [];
        return conflictTypes.length > 0 && String(candidate.judgment || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
          === String(mine.judgment || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      });
      for (const other of others) {
        await rejectRecallCandidate(userId, other.id, reason).catch((error) => {
          log.warn('inbox conflict claim: sibling reject degraded', {
            userId, candidateId: other.id, error: (error as Error).message,
          });
        });
      }
      // 晋升闸门（证据/风险/相似）照旧生效（2026-09-29 第 2 批）：它拒绝时
      // 不再裸抛内部错误——转成结构化 code（promotion_gate_rejected）带
      // 候选编号，前端据此引导去候选详情走完整三选一，而不是笼统报错。
      try {
        await promoteRecallCandidate(userId, candidateId, { actor: 'user', ...(note ? { decisionReason: note } : {}) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw inboxResolveError('promotion_gate_rejected',
          `选边已生效（另一条已出局），但保留的这一条没有通过晋升检查：${message}。可到「待我处理」的候选详情里查看并完成确认。`,
          { candidateId });
      }
      return { ok: true, target: 'recall_candidate', status: 'claimed' };
    }
    // 2026-09-29 第 2 批·一物一链：accept 直调分支删除——candidate_pending_review
    // 已停产（inbox.ts），普通候选的确认唯一入口是候选卡/详情的完整三选一；
    // 这里保留直调就是第二条不带冲突选项的确认链（B1）。reject/defer/ignore
    // 是"移出清单"类动作（不落库），保留。
    if (action === 'reject') {
      await rejectRecallCandidate(userId, candidateId, note);
      return { ok: true, target: 'recall_candidate', status: 'rejected' };
    }
    if (action === 'defer') {
      await deferRecallCandidate(userId, candidateId, note);
      return { ok: true, target: 'recall_candidate', status: 'deferred' };
    }
    if (action === 'ignore') {
      await ignoreRecallCandidate(userId, candidateId, note);
      return { ok: true, target: 'recall_candidate', status: 'ignored' };
    }
    throw inboxResolveError(
      'unsupported_action',
      `候选类待办只支持 reject / defer / ignore${candidatePrefix === 'conflict:' ? ' / claim' : ''}，收到 ${action || '(空)'}`,
    );
  }

  // AI 提议的实质变化（specs/008 US-406 / T046）：清单里的「稍后处理」项在这里处置。
  if (id.startsWith('proposal:')) {
    const proposalId = id.slice('proposal:'.length);
    if (!safeId(proposalId)) throw inboxResolveError('invalid_item_id', `待办 id 里的提议编号不合法：${proposalId}`);
    if (action !== 'accept' && action !== 'reject' && action !== 'defer') {
      throw inboxResolveError('unsupported_action', `提议类待办支持 accept / reject / defer，收到 ${action || '(空)'}`);
    }
    const result = await decideAssetChangeProposal(
      userId,
      proposalId,
      action === 'accept' ? 'confirm' : action === 'reject' ? 'reject' : 'defer',
    );
    return { ok: true, target: 'asset_change_proposal', status: result.state };
  }

  // 大扫除拿不准项（specs/008 US-403 / T046）：处置 = 给个意见，不是执行某个动作。
  // 「不管它」= reject（从清单移走、报告留档）；「回头再看」= defer。
  // accept 没有对应动作：当初就是因为我拿不准才没动手，凭空"接受"等于让我瞎猜。
  if (id.startsWith('cleanup:')) {
    const [, reportId, assetId] = id.split(':');
    if (!safeId(reportId) || !safeId(assetId)) throw inboxResolveError('invalid_item_id', `待办 id 不合法：${id}`);
    if (action === 'accept') {
      throw inboxResolveError(
        'unsupported_action',
        '这条待办没有可执行的建议动作——当初就是因为拿不准才没动手。请到资产详情里直接改，或选「拒绝」把它从清单移走。',
      );
    }
    if (action !== 'reject' && action !== 'defer') {
      throw inboxResolveError('unsupported_action', `大扫除拿不准项支持 reject / defer，收到 ${action || '(空)'}`);
    }
    await decideCleanupUncertainItem(userId, reportId, assetId, action === 'reject' ? 'dismissed' : 'deferred');
    return { ok: true, target: 'cleanup_uncertain', status: action === 'reject' ? 'dismissed' : 'deferred' };
  }

  // 后台巡检的发现（specs/008 US-405；specs/010 T032 扩就地处断）：默认处置的是
  // "要不要继续提醒"；冲突/重复类多一条"这两条资产怎么办"——选边归档或合并，
  // 处置完把 finding.key 记入 dismissedFindingKeys（**当轮即从清单消失**，不等
  // 下一轮巡检）。名单由主进程从自己的巡检记录重算，不信任客户端。
  if (id.startsWith('inspection:')) {
    const key = id.slice('inspection:'.length);
    if (!key) throw inboxResolveError('invalid_item_id', `待办 id 不合法：${id}`);
    if (action === 'keep' || action === 'merge') {
      const targetAssetId = typeof input.targetAssetId === 'string' ? input.targetAssetId : '';
      if (!safeId(targetAssetId)) throw inboxResolveError('invalid_item_id', `选边/合并需要合法的目标资产编号，收到：${targetAssetId || '(空)'}`);
      const [runs, settings] = await Promise.all([listInspectionRuns(userId, 1), readInspectionSettings(userId)]);
      const finding = pendingInspectionFindings(runs, settings.dismissedFindingKeys, settings.deferredFindingKeys)
        .find((entry) => entry.key === key);
      if (!finding) throw inboxResolveError('unsupported_item_kind', '这条巡检发现已经不在最新一轮里了（可能刚被处置或刷新）。');
      if (!finding.assetIds.includes(targetAssetId)) {
        throw inboxResolveError('invalid_item_id', `目标资产不在本条发现的名单里：${targetAssetId}`);
      }
      const others = finding.assetIds.filter((assetId) => assetId !== targetAssetId);
      if (action === 'merge') {
        for (const other of others) {
          await settle(() => mergeAbilityAssets(userId, other, targetAssetId, {
            actor: 'user',
            reason: note || `治理待办：合并疑似重复（保留 ${targetAssetId}）`,
          })).catch((error) => {
            // 不同类型合并被既有闸门拒——如实转成 unsupported_action，不偷偷改类型。
            const message = String((error as Error)?.message || error);
            if (/same type/i.test(message)) {
              throw inboxResolveError('unsupported_action', '两条资产的类型不同，不能合并——请先到资产详情对齐类型，或改用「保留这一条」。');
            }
            throw error;
          });
        }
        await decideInspectionFinding(userId, key, 'dismissed');
        return { ok: true, target: 'inspection_finding', status: 'merged' };
      }
      for (const other of others) {
        await settle(() => archiveAbilityAsset(userId, other, {
          actor: 'user',
          reason: note || `与 ${targetAssetId} 冲突，选边保留`,
        }));
      }
      await decideInspectionFinding(userId, key, 'dismissed');
      return { ok: true, target: 'inspection_finding', status: 'kept' };
    }
    if (action === 'accept') {
      throw inboxResolveError(
        'unsupported_action',
        '这条是巡检的建议，没有可执行的动作（巡检不改资产）。请到资产详情里处理，或选「不管它」让它不再提醒。',
      );
    }
    if (action !== 'reject' && action !== 'defer') {
      throw inboxResolveError('unsupported_action', `巡检发现支持 keep / merge / reject / defer，收到 ${action || '(空)'}`);
    }
    await decideInspectionFinding(userId, key, action === 'reject' ? 'dismissed' : 'deferred');
    return { ok: true, target: 'inspection_finding', status: action === 'reject' ? 'dismissed' : 'deferred' };
  }

  // ── 缺边界：就地补条件（specs/010 T028 / US-304）─────────────────────────
  // 通过判据 = 产生待办的**同一道闸门**（validatePromotionByAssetType，system
  // 档）：不通过就拒绝且**不落库**——不允许"先存进来再说"的坏规则。
  if (id.startsWith('rule-boundary:')) {
    const assetId = id.slice('rule-boundary:'.length);
    if (!safeId(assetId)) throw inboxResolveError('invalid_item_id', `待办 id 不合法：${id}`);
    if (action !== 'set_boundary') {
      throw inboxResolveError('unsupported_action', `缺边界待办支持 set_boundary，收到 ${action || '(空)'}`);
    }
    const applicableWhen = Array.isArray(input.applicableWhen)
      ? input.applicableWhen.filter((value) => typeof value === 'string' && value.trim()).map((value) => String(value).trim())
      : [];
    const forbiddenWhen = Array.isArray(input.forbiddenWhen)
      ? input.forbiddenWhen.filter((value) => typeof value === 'string' && value.trim()).map((value) => String(value).trim())
      : [];
    // 「合不合法」不在这里另立标准——空条件留给下面的同一道闸门判
    //（validatePromotionByAssetType 是"什么叫有边界"的唯一判据，D6/N-03）。
    const asset = await readMutableAssetOrReject(userId, assetId);
    const validation = validatePromotionByAssetType({
      judgment: asset.statement,
      suggestedType: 'rule',
      suggestedScope: asset.scope,
      applicableWhen,
      forbiddenWhen,
    }, { actor: 'system' });
    if (validation.reasons.includes('rule_boundary_required')) {
      throw inboxResolveError('invalid_boundary', '条件仍未通过规则门禁：规则的适用与禁用范围需要补齐。');
    }
    await settle(() => updateAbilityAsset(userId, assetId, {
      applicableWhen,
      forbiddenWhen,
      expectedVersion: asset.version,
      reason: note || '治理待办：补齐规则边界',
      actor: 'user',
    }));
    return { ok: true, target: 'asset', status: 'boundary_set' };
  }

  if (ASSET_ITEM_PREFIXES.some((prefix) => id.startsWith(prefix))) {
    throw inboxResolveError(
      'unsupported_item_kind',
      '这类待办要改的是资产内容本身（换证据 / 重新生成 Skill / 改范围），没有一键处置动作——请到资产详情里处理。',
    );
  }

  throw inboxResolveError('unsupported_item_kind', `没有处置动作能对应这个待办 id：${id}`);
}

export async function listCognitionInbox(userId: string): Promise<CognitionInboxItem[]> {
  // AI 提议的实质变化：待处理与"稍后处理"都进清单（"稍后不丢"就靠这条）。
  const pendingAssetChanges = await listAssetChangeProposals(userId)
    .then((proposals) => proposals
      .filter((proposal) => proposal.state === 'pending' || proposal.state === 'deferred')
      .map((proposal) => ({
        proposalId: proposal.id,
        assetId: proposal.assetId,
        ...(proposal.reason ? { reason: proposal.reason } : {}),
      })))
    .catch((error) => {
      log.warn('inbox asset change read degraded', { userId, error: (error as Error).message });
      return [];
    });

  const pendingCleanupItems = await listCleanupReports(userId)
    .then((reports) => pendingCleanupUncertainItems(reports))
    .catch((error) => {
      log.warn('inbox cleanup read degraded', { userId, error: (error as Error).message });
      return [];
    });

  const pendingInspectionItems = await Promise.all([
    listInspectionRuns(userId, 1),
    readInspectionSettings(userId),
  ])
    .then(([runs, settings]) => pendingInspectionFindings(runs, settings.dismissedFindingKeys, settings.deferredFindingKeys))
    .catch((error) => {
      log.warn('inbox inspection read degraded', { userId, error: (error as Error).message });
      return [];
    });

  const [assets, candidates, sourceGroups] = await Promise.all([
    listFormalAssets(userId),
    listRecallCandidates(userId).catch((error) => {
      log.warn('inbox candidate read degraded', { userId, error: (error as Error).message });
      return [];
    }),
    listCognitionSources(userId).catch((error) => {
      log.warn('inbox source read degraded', { userId, error: (error as Error).message });
      return [];
    }),
  ]);

  // skill_method 的 generatedSkillId 不在资产记录上，得问一次已安装 Skill。
  // 读失败时不能当成"还没生成"，否则会给用户一个可能重复创建 Skill 的假建议。
  // 资产本身仍保留给来源失效、敏感级等其他治理检查。
  const skillStateUnknownAssetIds = new Set<string>();
  const skillUpgradeCurrentAssetIds = new Set<string>();
  const skillUpgradeRejectedAssetIds = new Set<string>();
  const withSkillState = await Promise.all(assets.map(async (asset) => {
    if (asset.assetType !== 'skill_method' || asset.payload.kind !== 'skill_method') return asset;
    let generatedSkillId: string | undefined;
    try { generatedSkillId = await readInstalledSkillForAsset(userId, asset.assetId); }
    catch (error) {
      log.warn('inbox installed skill read degraded', {
        userId, assetId: asset.assetId, error: (error as Error).message,
      });
      skillStateUnknownAssetIds.add(asset.assetId);
      return asset;
    }
    try {
      const binding = await readSkillBinding(userId, asset.assetId);
      if (binding && !bindingIsStale(binding, asset.version)) {
        skillUpgradeCurrentAssetIds.add(asset.assetId);
      }
      if (binding && bindingHasDecision(binding, asset.version, ['rejected'])) {
        skillUpgradeRejectedAssetIds.add(asset.assetId);
      }
    } catch (error) {
      log.warn('inbox skill binding read degraded', {
        userId, assetId: asset.assetId, error: (error as Error).message,
      });
    }
    return generatedSkillId
      ? { ...asset, payload: { ...asset.payload, generatedSkillId } }
      : asset;
  }));

  // 变更类待办要知道"最近一次改了什么"。版本快照本来就存着全量内容，这里
  // 只是把相邻两版比一遍；读失败按"没有版本历史"处理——宁可少报一条变更，
  // 也不要凭空断言资产没变过。
  const latestDiffs = new Map<string, AssetVersionDiff>();
  await Promise.all(withSkillState.map(async (asset) => {
    try {
      const diff = latestAssetVersionDiff(asset.assetId, await listAbilityAssetVersions(userId, asset.assetId));
      if (diff) latestDiffs.set(asset.assetId, diff);
    } catch (error) {
      log.warn('inbox version history read degraded', {
        userId, assetId: asset.assetId, error: (error as Error).message,
      });
    }
  }));

  const unavailableSourceIds = new Set(sourceGroups
    .flatMap((group) => group.items)
    .filter((item) => UNAVAILABLE_SOURCE_STATUSES.has(item.status))
    .map((item) => item.id));

  // 同文本被分成两类的冲突表。跨候选判断，单条算不出来，能力判据要靠它才能
  // 得出与晋升闸门一致的 eligibility——`promoteRecallCandidate` 也是这么算的。
  const conflictingTypes = recallCandidateConflictingTypes(candidates);
  return buildCognitionInbox({
    assets: withSkillState,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      status: candidate.status,
      ...(candidate.judgment ? { judgment: candidate.judgment } : {}),
      ...(candidate.suggestedType ? { suggestedType: candidate.suggestedType } : {}),
      // 下面这批内容字段不是给展示用的，是给能力判据跑正式资产准入门槛用的。
      // 少给一个，这条候选就会被当成"无法评估、不收紧"，不合格候选又会混回
      // `candidate_pending_review`——那正是假审批的入口。
      ...(candidate.value !== undefined ? { value: candidate.value } : {}),
      ...(candidate.summary !== undefined ? { summary: candidate.summary } : {}),
      ...(candidate.suggestedScope ? { suggestedScope: candidate.suggestedScope } : {}),
      ...(candidate.suggestedAction ? { suggestedAction: candidate.suggestedAction } : {}),
      ...(candidate.applicableWhen ? { applicableWhen: candidate.applicableWhen } : {}),
      ...(candidate.forbiddenWhen ? { forbiddenWhen: candidate.forbiddenWhen } : {}),
      ...(conflictingTypes.get(candidate.id)?.length
        ? { conflictingTypes: conflictingTypes.get(candidate.id)! }
        : {}),
      // 两个 refs 都要给：能力判据对"证据是否齐全"看的是 sourceRefs 与
      // evidenceRefs 两者（asCandidate 的不变量也是两者）。只给一个，待办算出
      // 来的可操作性就和 `recall.candidates.list` 分叉——同一条候选在两个页面
      // 上一个说能确认、一个说不能。
      ...(candidate.sourceRefs ? { sourceRefs: candidate.sourceRefs } : {}),
      ...(candidate.evidenceRefs ? { evidenceRefs: candidate.evidenceRefs } : {}),
    })),
    unavailableSourceIds,
    latestDiffs,
    pendingAssetChanges,
    pendingCleanupItems,
    pendingInspectionFindings: pendingInspectionItems,
    skillStateUnknownAssetIds,
    skillUpgradeCurrentAssetIds,
    skillUpgradeRejectedAssetIds,
  });
}

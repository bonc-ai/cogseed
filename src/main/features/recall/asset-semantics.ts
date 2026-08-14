/** 认知资产的语义字段：什么时候该用、什么时候绝对不能用，以及敏感级别。
 *
 *  证据（evidenceRefs）回答「凭什么这么说」，本体引用（ontologyRefs）回答
 *  「挂在个人本体的哪里」，关系表（asset-relations.ts）回答「和别的资产什么关系」，
 *  这里回答剩下的一个问题：这条资产在什么情境下可用。
 *
 *  忠实约束：全部可选。缺失表示「没记录过」，不表示「无限制」——尤其
 *  forbiddenWhen 为空只代表没人写过禁用条件，消费方不得据此推断该资产随处可用。
 */

const MAX_CONDITIONS = 32;
const MAX_CONDITION_LENGTH = 500;

function boundedCondition(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`malformed ability asset ${field}`);
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`malformed ability asset ${field}`);
  if (text.length > MAX_CONDITION_LENGTH) throw new Error(`ability asset ${field} is too long`);
  return text;
}

/** 适用/禁用条件。自然语言短句，投影层用来决定带不带这条资产，
 *  也直接展示给用户看——所以不做结构化解析，只做长度与去重约束。 */
export function normalizeAbilityAssetConditions(
  value: unknown,
  field: 'applicableWhen' | 'forbiddenWhen',
): string[] {
  if (!Array.isArray(value)) throw new Error(`malformed ability asset ${field}`);
  if (value.length > MAX_CONDITIONS) throw new Error(`too many ability asset ${field} entries`);
  const conditions: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const text = boundedCondition(raw, field);
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    conditions.push(text);
  }
  return conditions;
}

/** 敏感级别，取自规范 16.1。
 *
 *  刻意没有 L3——L3 是「禁止沉淀」，被 `util/cognition-sensitivity` 的准入闸挡在
 *  候选之前，永远不可能成为一条资产。在这里留个 L3 取值，等于承认它可以存在，
 *  也会让「资产里有没有 L3」变成一个需要运行时检查的问题，而不是类型上就不可能。 */
export type AbilityAssetSensitivity = 'L0' | 'L1' | 'L2';

const SENSITIVITY_LEVELS = new Set<AbilityAssetSensitivity>(['L0', 'L1', 'L2']);

export function normalizeAbilityAssetSensitivity(value: unknown): AbilityAssetSensitivity {
  if (typeof value !== 'string' || !SENSITIVITY_LEVELS.has(value as AbilityAssetSensitivity)) {
    throw new Error('malformed ability asset sensitivity');
  }
  return value as AbilityAssetSensitivity;
}

export interface AbilityAssetSemantics {
  applicableWhen?: string[];
  forbiddenWhen?: string[];
  /** 缺失=没分过级，不等于 L0。消费方不得把缺失当作「已确认低风险」。 */
  sensitivity?: AbilityAssetSensitivity;
}

/** 从一条存量记录或更新入参上读语义字段。三个字段都可缺失（老资产没有），
 *  缺失就不出现在结果里，避免给存量记录凭空补上空数组。
 *
 *  形状与 `readAbilityAssetRelationContract` 一致：返回可直接展开的片段，
 *  这样服务层不必逐字段判断 undefined。 */
export function readAbilityAssetSemantics(value: Record<string, unknown>): AbilityAssetSemantics {
  return {
    ...(value.applicableWhen === undefined
      ? {}
      : { applicableWhen: normalizeAbilityAssetConditions(value.applicableWhen, 'applicableWhen') }),
    ...(value.forbiddenWhen === undefined
      ? {}
      : { forbiddenWhen: normalizeAbilityAssetConditions(value.forbiddenWhen, 'forbiddenWhen') }),
    ...(value.sensitivity === undefined
      ? {}
      : { sensitivity: normalizeAbilityAssetSensitivity(value.sensitivity) }),
  };
}

/** 规范 10.2 默认使用矩阵：成熟度与状态决定这条资产要不要默认带入。
 *
 *  **做成推导而不是存字段**，因为矩阵本身就是 `成熟度 → 行为` 的映射。
 *  再存一份「能否默认带入」会和 `maturity` 形成两个真相源：资产升到
 *  Transfer Validated 而那个字段忘了改，就会出现「已验证但仍不带入」的
 *  幽灵状态，且没人看得出是哪边错了。
 *
 *  跨作用域一律比同作用域更严——规范里每一行都是如此，没有例外。 */
export type AbilityAssetUsePolicy = 'never' | 'confirm' | 'prompt' | 'auto';

/** 供 `resolveDefaultUsePolicy` 取用的最小资产形状，避免这个纯函数
 *  反向依赖 candidate-service 的完整记录类型。 */
export interface AbilityAssetSemanticsHost {
  status: 'active' | 'paused' | 'archived' | 'deleted' | 'purged' | 'revoked';
  maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated' | 'stable';
}

export function resolveDefaultUsePolicy(
  asset: Pick<AbilityAssetSemanticsHost, 'status' | 'maturity'>,
  sameScope: boolean,
): AbilityAssetUsePolicy {
  // active 之外的每一种状态都不带入：paused/archived 是用户主动收起，
  // revoked/deleted/purged 是已撤销。这里不逐个列举，避免以后新增状态时
  // 漏掉一行就默默变成「可带入」。
  if (asset.status !== 'active') return 'never';
  switch (asset.maturity) {
    case 'seed':
      // Candidate 档：同作用域都不默认使用，跨作用域禁止。
      return 'never';
    case 'bud':
      // User Confirmed / Unverified：用户确认了内容，不代表效果已验证。
      return sameScope ? 'prompt' : 'confirm';
    case 'transfer_validated':
      // 只证明目标端正确读取并使用过。
      return sameScope ? 'auto' : 'confirm';
    case 'effectiveness_validated':
      return sameScope ? 'auto' : 'confirm';
    case 'stable':
      // 'stable' 是 effectiveness_validated 之上的稳定档，不能比它更松：
      // 跨作用域仍然要确认，因为「在这里稳定」不等于「换个场景也对」。
      return sameScope ? 'auto' : 'confirm';
    default:
      return 'never';
  }
}

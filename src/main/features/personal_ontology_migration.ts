/**
 * Personal Ontology — Role Template schema migration。
 *
 * 职责边界（收归结论的延续）：
 * - **catalog 是 schema authority**（`role_templates.ts`）；
 * - **已安装的模板文件是实例 schema 与 A-box 的事实载体**；
 * - 台账 `groups.md` 的 `installed_version` 只是缓存/索引状态，**不是权威**，
 *   分叉时以文件为准，下一次 detect 自愈。
 *
 * 整个 migration 留在 PO 内部：Workspace / Recall / 渲染层都不知道它存在，
 * 它们继续只消费 `personal_ontology_contract.ts` reconcile 之后的结果。
 *
 * 本阶段（第一版框架）**真正会执行的只有纯新增**：补 catalog 新加的字段空坑、
 * 补 catalog 新加的分节。rename / move / retire 只被 **识别并报告**，绝不
 * 偷偷当成 add + delete 去执行 —— 那会把用户的值搬到错误的坑里，或者让一个
 * 还有值的字段悄悄失去 T-box 身份。识别到这类变化时本轮拒绝升级版本号，
 * 让实例如实停在旧版本，而不是留下一个半迁移 schema。
 */

import { getRoleTemplate, type RoleTemplate, type PresetGroup, type TemplateField } from './role_templates';
import { safeId, writeTextAtomicSync, nowIso } from '../storage';
import { createLogger } from '../logger';
import { fileEditLock } from '../util/locks';
import {
  isValidTemplateVersion,
  writeGroups,
  notifyGroupUpserted,
  type FieldValue,
} from './personal_ontology_groups';
import {
  MAX_FILE_BYTES,
  backupTemplateFileForMigration,
  parseTemplateContent,
  pruneMigrationBackups,
  readGroups,
  readTemplateFileText,
  serializeTemplateContent,
  templateFileAbsPath,
  type TemplateFileContent,
  type TemplateSection,
} from './personal_ontology_template_files';

const log = createLogger('personal-ontology-migration');

// ── 版本比较 ───────────────────────────────────────────────────────────────

/**
 * semver 比较（支持现网在用的预发布后缀，如 `0.2.0-review.1`）。
 * 返回 <0 / 0 / >0。解析不出的部分按 0 处理 —— 这里唯一的用途是**拒绝降级**，
 * 不需要完整 semver 语义，但预发布必须低于同版本正式版（`1.0.0-rc.1` < `1.0.0`），
 * 否则跨客户端同步回来的正式版会被误判成「比 catalog 旧」而触发一次假迁移。
 */
export function compareTemplateVersion(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = String(v || '').split('-', 2);
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return { nums: [nums[0] || 0, nums[1] || 0, nums[2] || 0], pre: pre || '' };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  // 有预发布后缀的一方更低；两边都有则按标识符逐段比较（数字段按数值）。
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const sa = pa.pre.split('.');
  const sb = pb.pre.split('.');
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// ── Identity resolver ──────────────────────────────────────────────────────

export interface SectionIdentity {
  sectionId: string;
  /** catalog 当前的显示名。 */
  title: string;
}

export interface FieldIdentity {
  sectionId: string;
  sectionTitle: string;
  fieldId: string;
  /** catalog 当前的显示名。 */
  name: string;
}

export type IdentityMatch = 'current_name' | 'previous_name';

/**
 * 解析失败。**独立命名的类型，不是内联联合分支** —— 内联时 TS 无法把它从
 * `IdentityResolution<A>` 的失败分支直接转给 `IdentityResolution<B>`，
 * 各处 resolver 就得为「把失败原样往上传」写一遍重新构造。
 *
 * `not_found`  = catalog 里没有任何 identity 认领这个名字（用户自建字段，
 *                或已被产品下架且未声明为 retired）。
 * `ambiguous`  = 多个 identity 认领同一个名字。**必须失败，不许猜** ——
 *                猜错会把用户的值搬到别的坑里。正常情况下
 *                `validateRoleTemplateCatalog()` 已经在开发期拦下了它，
 *                这里是运行期的第二道门（catalog 可能来自将来的自定义模板）。
 */
export interface IdentityFailure {
  ok: false;
  reason: 'unknown_template' | 'not_found' | 'ambiguous';
  detail?: string;
}

export type IdentityResolution<T> =
  | { ok: true; matchedBy: IdentityMatch; identity: T }
  | IdentityFailure;

/**
 * 失败判定必须走这个 type guard，不能写 `if (!res.ok)`。仓库的 tsconfig 关了
 * `strictNullChecks`，`ok: true | false` 这种布尔判别式收窄在该模式下不生效，
 * 直接 `!res.ok` 之后 TS 仍把 res 当成整个联合，失败原样上传会编译不过。
 */
export function isIdentityFailure(res: IdentityResolution<unknown>): res is IdentityFailure {
  return res.ok === false;
}

/** 名字命中该 identity 的当前名 / 历史名 / 都不命中。 */
function matchName(current: string, previous: string[] | undefined, name: string): IdentityMatch | null {
  if (current === name) return 'current_name';
  if (previous && previous.includes(name)) return 'previous_name';
  return null;
}

/**
 * 从候选集里挑出唯一命中。**当前名优先于历史名**：产品把 A 改名成 B、同时又把
 * 一个新坑起名叫 A 时，文件里的「A」应该归那个当前就叫 A 的坑，而不是归历史上
 * 叫过 A 的旧坑。同一优先级内出现多个命中 → ambiguous。
 */
function pickUnique<T>(
  candidates: ReadonlyArray<T>,
  match: (item: T) => IdentityMatch | null,
  describe: (item: T) => string,
): IdentityResolution<T> {
  const current: T[] = [];
  const previous: T[] = [];
  for (const item of candidates) {
    const m = match(item);
    if (m === 'current_name') current.push(item);
    else if (m === 'previous_name') previous.push(item);
  }
  const tier: [T[], IdentityMatch] = current.length ? [current, 'current_name'] : [previous, 'previous_name'];
  const [hits, matchedBy] = tier;
  if (!hits.length) return { ok: false, reason: 'not_found' };
  if (hits.length > 1) {
    return { ok: false, reason: 'ambiguous', detail: hits.map(describe).join(', ') };
  }
  return { ok: true, matchedBy, identity: hits[0] };
}

function toSectionIdentity(sec: PresetGroup): SectionIdentity {
  return { sectionId: sec.id, title: sec.title };
}

function resolveSectionIn(
  template: RoleTemplate,
  sectionName: string,
): IdentityResolution<PresetGroup> {
  return pickUnique(
    template.preset_groups,
    (sec) => matchName(sec.title, sec.previous_names, sectionName),
    (sec) => sec.id,
  );
}

/**
 * 实例文件里的分节名 → catalog 当前 identity。
 * 任意历史名都是一步解析到位，不需要 v1→v2→v3 逐版本重放。
 */
export function resolveSectionIdentity(
  templateId: string,
  sectionName: string,
): IdentityResolution<SectionIdentity> {
  const template = getRoleTemplate(templateId);
  if (!template) return { ok: false, reason: 'unknown_template' };
  const res = resolveSectionIn(template, sectionName);
  if (isIdentityFailure(res)) return res;
  return { ok: true, matchedBy: res.matchedBy, identity: toSectionIdentity(res.identity) };
}

function resolveFieldIn(
  section: PresetGroup,
  fieldName: string,
): IdentityResolution<TemplateField> {
  return pickUnique(
    section.fields,
    (f) => matchName(f.name, f.previous_names, fieldName),
    (f) => f.id,
  );
}

/**
 * 实例文件里的 (分节名, 字段名) → catalog 当前 identity。
 * 解析作用域是**先定位分节、再在该分节内找字段** —— 与 `isTboxField` 的口径
 * 一致（字段名只在其所属分节内唯一）。字段被移到了别的分节时这里会
 * `not_found`，由 `findFieldIdentityAnywhere` 去认出「移动」这件事。
 */
export function resolveFieldIdentity(
  templateId: string,
  sectionName: string,
  fieldName: string,
): IdentityResolution<FieldIdentity> {
  const template = getRoleTemplate(templateId);
  if (!template) return { ok: false, reason: 'unknown_template' };
  const sec = resolveSectionIn(template, sectionName);
  if (isIdentityFailure(sec)) return sec;
  const field = resolveFieldIn(sec.identity, fieldName);
  if (isIdentityFailure(field)) return field;
  return {
    ok: true,
    matchedBy: field.matchedBy,
    identity: {
      sectionId: sec.identity.id,
      sectionTitle: sec.identity.title,
      fieldId: field.identity.id,
      name: field.identity.name,
    },
  };
}

/**
 * 全模板范围找字段 identity（不限分节）。只用来**区分**「字段被移到别的分节」
 * 和「字段被彻底下架」—— 前者本轮不支持迁移、必须拒绝升级，后者是 retire。
 * 不要拿它去寻址：跨分节同名字段在 catalog 里是合法的，这里会如实报 ambiguous。
 */
export function findFieldIdentityAnywhere(
  templateId: string,
  fieldName: string,
): IdentityResolution<FieldIdentity> {
  const template = getRoleTemplate(templateId);
  if (!template) return { ok: false, reason: 'unknown_template' };
  const flat = template.preset_groups.flatMap((sec) => sec.fields.map((f) => ({ sec, f })));
  const res = pickUnique(
    flat,
    ({ f }) => matchName(f.name, f.previous_names, fieldName),
    ({ f }) => f.id,
  );
  if (isIdentityFailure(res)) return res;
  return {
    ok: true,
    matchedBy: res.matchedBy,
    identity: {
      sectionId: res.identity.sec.id,
      sectionTitle: res.identity.sec.title,
      fieldId: res.identity.f.id,
      name: res.identity.f.name,
    },
  };
}

// ── 退役字段与三态 ─────────────────────────────────────────────────────────

export interface RetiredFieldIdentity {
  sectionId: string;
  sectionTitle: string;
  fieldId: string;
  /** 退役字段没有「当前显示名」，只有历史名；这里给命中的那一个。 */
  matchedName: string;
  retiredIn?: string;
}

/**
 * 实例文件里的字段属于哪一态。
 *
 * `active`   catalog 当前仍声明的正式字段 —— 可写落点。
 * `retired`  曾经属于官方 T-box、catalog 已用 `retired_fields` 明确声明退役。
 *            值全部保留、继续可读，但不再是可写落点。
 * `custom`   用户自己建的字段，从来不属于官方 T-box。
 *
 * 关键在于 retired 与 custom 的判据是**catalog 的显式声明**，不是「catalog 里
 * 找不到」。只凭找不到就判退役，等于把用户自建字段也说成官方历史字段；反过来
 * 没有这条声明，官方旧字段就会被说成用户自建的——这正是本轮要修的错误行为。
 */
export type FieldSlotStatus = 'active' | 'retired' | 'custom';

/** 实例文件里的 (分节名, 字段名) → 退役字段 identity。 */
export function resolveRetiredFieldIdentity(
  templateId: string,
  sectionName: string,
  fieldName: string,
): IdentityResolution<RetiredFieldIdentity> {
  const template = getRoleTemplate(templateId);
  if (!template) return { ok: false, reason: 'unknown_template' };
  const sec = resolveSectionIn(template, sectionName);
  if (isIdentityFailure(sec)) return sec;
  const retired = pickUnique(
    sec.identity.retired_fields || [],
    // 退役字段只有历史名，没有「当前名」；统一按 previous_name 命中。
    (r) => (r.previous_names?.includes(fieldName) ? 'previous_name' : null),
    (r) => r.id,
  );
  if (isIdentityFailure(retired)) return retired;
  return {
    ok: true,
    matchedBy: 'previous_name',
    identity: {
      sectionId: sec.identity.id,
      sectionTitle: sec.identity.title,
      fieldId: retired.identity.id,
      matchedName: fieldName,
      ...(retired.identity.retired_in ? { retiredIn: retired.identity.retired_in } : {}),
    },
  };
}

/**
 * 三态判定。在役优先于退役（catalog 若把一个退役字段重新启用，它就是 active）。
 * 未知模板 / 认不出的分节 → custom：拿不到官方依据时，只能说「这不是官方字段」，
 * 不能反过来说「这是官方退役字段」。
 */
export function roleTemplateFieldStatus(
  templateId: string,
  sectionName: string,
  fieldName: string,
): FieldSlotStatus {
  const active = resolveFieldIdentity(templateId, sectionName, fieldName);
  if (!isIdentityFailure(active)) return 'active';
  const retired = resolveRetiredFieldIdentity(templateId, sectionName, fieldName);
  if (!isIdentityFailure(retired)) return 'retired';
  return 'custom';
}

// ── Detection 的输入形状 ───────────────────────────────────────────────────

/**
 * 已安装实例的**结构投影**：detection 只需要「有哪些分节、每节有哪些字段、
 * 每个字段填了几条值」，不需要值本身。刻意做成一个小结构而不是直接吃
 * `TemplateFileContent`，让 detection 保持成一个可用 fixture 表覆盖的纯函数。
 */
export interface InstalledSectionShape {
  title: string;
  /** 字段名 + 已填值条数，顺序 = 文件里的出现顺序。 */
  fields: Array<{ name: string; valueCount: number }>;
}

export interface InstalledTemplateShape {
  /** 文件 meta 行里的版本 —— 实例 schema 的**权威**版本。 */
  version: string;
  sections: InstalledSectionShape[];
}

// ── Detection 结果 ─────────────────────────────────────────────────────────

/** catalog 有、实例文件没有的分节（整节新增，字段全是空坑）。 */
export interface AddedSection {
  sectionId: string;
  title: string;
  /** 插入位置 = catalog 里的分节下标（apply 按它把新节放回正确顺序）。 */
  catalogIndex: number;
  fields: Array<{ fieldId: string; name: string }>;
}

/** catalog 有、实例文件的对应分节里没有的字段（补空坑）。 */
export interface AddedField {
  sectionId: string;
  /** catalog 当前的分节标题（迁移后文件里也是这个）。 */
  sectionTitle: string;
  fieldId: string;
  name: string;
}

/**
 * 迁移后**应该长成的样子**：分节顺序、字段顺序、以及每个坑的来源指针。
 * 值不在这里，由 apply 按 `from` 从旧内容整块搬过去。
 *
 * 这是 plan 的执行骨架，也是未来 UI dry-run 能直接渲染的东西。有了它，
 * apply 不需要再回头查 catalog，就不会出现「plan 说的」和「apply 做的」
 * 各算一遍、两边悄悄分叉。retired / custom 字段不在骨架里 —— 它们不由
 * catalog 声明，apply 会把它们按原顺序跟在各自分节的在役字段之后。
 */
export interface MigrationTargetSection {
  sectionId: string;
  /** catalog 当前标题（迁移后文件里的标题）。 */
  title: string;
  /** 迁移前文件里的标题；整节新增时缺省。 */
  fromTitle?: string;
  fields: Array<{
    fieldId: string;
    /** catalog 当前字段名（迁移后文件里的字段名）。 */
    name: string;
    /** 迁移前它在文件里的位置；新补的空坑没有来源。 */
    from?: { sectionTitle: string; name: string };
  }>;
}

/**
 * 识别得出、但**不执行**的变化。带 `status` 是为了让调用方一眼看出
 * 「系统知道发生了什么，只是这一版不动手」，而不是被当成 add/delete 混过去。
 *
 * 现在只剩合并与拆分：这两类都要回答「值怎么并 / 怎么拆、留哪个顺序」，
 * 而 schema diff 本身答不出来 —— 猜错就是把用户的值搬进错误的坑，且事后
 * 无从分辨。rename / move / retire 已经有确定语义，不再进这个清单。
 */
export interface UnsupportedChange {
  kind: 'merge_field' | 'merge_section' | 'split_field' | 'split_section';
  status: 'requires_manual_or_future_migration';
  detail: string;
}

export interface MigrationConflict {
  kind:
    /** catalog 里没有这个模板。 */
    | 'unknown_template'
    /** 文件解析不出 meta / 分节，拿不到可信的实例 schema。 */
    | 'file_unparsable'
    /** 文件版本高于 catalog（跨客户端同步回来的更新版本）：不迁移、不降级。 */
    | 'version_ahead'
    /** 名字解析出多个 identity —— 必须由作者消歧，不猜。 */
    | 'ambiguous_identity'
    /**
     * catalog 里有分节/字段缺 `id` 或 id 形状非法。这是作者错误，运行期必须
     * 直接拒绝：identity 全靠 id 区分，一批 `undefined` 会把所有坑折叠成同一个
     * identity，于是「每个坑都已匹配」，检测不出任何缺失，静默什么都不做。
     * `validateRoleTemplateCatalog()` 在开发期拦它，这里是运行期的第二道门。
     */
    | 'malformed_catalog_identity'
    /**
     * 文件里有认不出的**分节**，catalog 又恰好有分节缺失：很可能是一次
     * 未声明 `previous_names` 的分节改名。分节层按最保守处理——拒绝。
     *
     * 为什么分节拦、字段不拦（见 `suspectedFieldRenames`）：用户没有任何入口
     * 能凭空造一个模板分节（`promoteEntryToRef` 必须落在已存在的分节上），
     * 所以「认不出的分节」本身就是异常信号；而「认不出的字段」是用户升格建坑
     * 的正常产物，天天都有。
     */
    | 'possible_undeclared_rename';
  detail: string;
}

export interface RoleTemplateMigrationDetection {
  templateId: string;
  /** 实例当前版本（**取自文件**，不是台账）。 */
  fromVersion: string;
  /** catalog 当前版本。 */
  toVersion: string;
  /** 台账记录的版本；与 fromVersion 不等 = 需要顺带自愈的缓存分叉。 */
  ledgerVersion?: string;
  needsMigration: boolean;
  additions: { sections: AddedSection[]; fields: AddedField[] };
  renamedSections: Array<{ sectionId: string; from: string; to: string }>;
  renamedFields: Array<{ sectionId: string; sectionTitle: string; fieldId: string; from: string; to: string }>;
  movedFields: Array<{
    fieldId: string;
    /** 文件里当前的字段名（可能同时还要改名，见 renamedFields）。 */
    name: string;
    fromSectionId: string;
    fromSectionTitle: string;
    toSectionId: string;
    toSectionTitle: string;
  }>;
  /**
   * 实例里存在、catalog 已明确声明退役的官方字段。**不是待办操作**：值原地
   * 保留，只是语义从 active 变成 retired（不再可写）。列在这里是为了让
   * 「退役」与「用户自建」在 plan 里就分得开，而不是都掉进 unknownInFile。
   */
  retiredFields: Array<{
    sectionId: string;
    sectionTitle: string;
    fieldId: string;
    name: string;
    valueCount: number;
    retiredIn?: string;
  }>;
  /**
   * 文件里存在、但 catalog 当前认不出的分节/字段。**信息项，不阻断**：
   * 用户自建字段是一等功能（升格建坑），把它当阻断条件会让所有用过该功能的
   * 用户永远迁不动。等 `retired_fields` 落地后，这里才能进一步区分
   * 「产品下架的旧字段」和「用户自建字段」。
   */
  unknownInFile: { sections: string[]; fields: Array<{ sectionTitle: string; name: string; valueCount: number }> };
  /**
   * 疑似未声明 `previous_names` 的**字段**改名：同一分节里既有认不出的名字、
   * 又有缺失的坑。**不阻断**，只报出来供日志排查。
   *
   * 它和「用户自建了一个字段 + catalog 恰好也新增了一个字段」在数据上完全
   * 同形，而后者是常态。让一个无法判定的信号去拦住一条已经判定安全的路径，
   * 结果是所有用过「升格建坑」的用户永远收不到新字段 —— 这个代价远大于收益：
   * 就算真的是未声明改名，补一个空坑也不会动旧值（旧值留在原字段里，只是变成
   * custom），等作者补上 `previous_names` 之后仍可由真正的 rename migration
   * 接手。真正能判定的改名（声明过 `previous_names` 的）走 renamedFields，
   * 那条是阻断的。
   */
  suspectedFieldRenames: Array<{ sectionTitle: string; unknown: string[]; missing: string[] }>;
  /** 识别到但本轮不执行的变化（合并 / 拆分）。非空 → 拒绝自动迁移。 */
  unsupportedChanges: UnsupportedChange[];
  conflicts: MigrationConflict[];
  /** 执行骨架（见 MigrationTargetSection）。canAutoApply 为 false 时不可用。 */
  target: MigrationTargetSection[];
}

/**
 * 比对「实例文件结构」与「catalog 当前 schema」，输出结构化结果。**只读不写。**
 *
 * catalog 不从参数进 —— 它是 schema authority，让调用方传一份进来等于允许
 * 拿一个假 catalog 去驱动真实文件的迁移。版本口径仍然显式出现在结果的
 * `toVersion` 里。
 *
 * 解析分三趟，而不是「按 catalog 分节逐节比对」：字段可能**跨分节移动**，
 * 一趟式比对会在原分节把它记成 move、又在目标分节把它记成 add，同一个
 * field_id 出现两次，apply 就会既搬走又新建一个空坑。
 */
export function detectRoleTemplateMigration(
  templateId: string,
  installed: InstalledTemplateShape,
  ledgerVersion?: string,
): RoleTemplateMigrationDetection {
  const base: RoleTemplateMigrationDetection = {
    templateId,
    fromVersion: installed?.version || '',
    toVersion: '',
    ...(ledgerVersion ? { ledgerVersion } : {}),
    needsMigration: false,
    additions: { sections: [], fields: [] },
    renamedSections: [],
    renamedFields: [],
    movedFields: [],
    retiredFields: [],
    unknownInFile: { sections: [], fields: [] },
    suspectedFieldRenames: [],
    unsupportedChanges: [],
    conflicts: [],
    target: [],
  };

  const template = getRoleTemplate(templateId);
  if (!template) {
    base.conflicts.push({ kind: 'unknown_template', detail: templateId });
    return base;
  }
  base.toVersion = template.version;

  const idShape = /^[a-z][a-z0-9_]*$/;
  const badIds: string[] = [];
  for (const sec of template.preset_groups || []) {
    if (!idShape.test(sec.id || '')) badIds.push(`section "${sec.title}"`);
    for (const f of sec.fields || []) {
      if (!idShape.test(f.id || '')) badIds.push(`field "${sec.title} · ${f.name}"`);
    }
  }
  if (badIds.length) {
    base.conflicts.push({ kind: 'malformed_catalog_identity', detail: badIds.join(', ') });
    return base;
  }

  if (!installed || !installed.version || !Array.isArray(installed.sections) || !installed.sections.length) {
    base.conflicts.push({ kind: 'file_unparsable', detail: 'installed template has no parsable version or sections' });
    return base;
  }

  if (compareTemplateVersion(installed.version, template.version) > 0) {
    base.conflicts.push({
      kind: 'version_ahead',
      detail: `installed ${installed.version} is newer than catalog ${template.version}`,
    });
    return base;
  }

  // ── 第一趟：分节层 ─────────────────────────────────────────────────────
  /** catalog section id → 文件里对应的那一节。 */
  const matchedSections = new Map<string, InstalledSectionShape>();
  for (const fileSec of installed.sections) {
    const res = resolveSectionIdentity(templateId, fileSec.title);
    if (isIdentityFailure(res)) {
      if (res.reason === 'ambiguous') {
        // 一个旧分节名被多个 catalog 分节认领 = 一次拆分。本轮不猜怎么拆。
        base.unsupportedChanges.push({
          kind: 'split_section',
          status: 'requires_manual_or_future_migration',
          detail: `section "${fileSec.title}" is claimed by ${res.detail || 'multiple sections'}`,
        });
      } else {
        base.unknownInFile.sections.push(fileSec.title);
      }
      continue;
    }
    if (matchedSections.has(res.identity.sectionId)) {
      // 两个文件分节落到同一个 catalog 分节 = 一次合并。合并需要决定「两边的
      // 同名字段怎么并、顺序按谁」，没有 metadata 就是猜，本轮拒绝。
      base.unsupportedChanges.push({
        kind: 'merge_section',
        status: 'requires_manual_or_future_migration',
        detail: `sections "${matchedSections.get(res.identity.sectionId)!.title}" and "${fileSec.title}" both resolve to "${res.identity.sectionId}"`,
      });
      continue;
    }
    matchedSections.set(res.identity.sectionId, fileSec);
    if (res.matchedBy === 'previous_name') {
      base.renamedSections.push({ sectionId: res.identity.sectionId, from: fileSec.title, to: res.identity.title });
    }
  }

  /** 文件分节标题 → 它命中的 catalog section id（第二趟判断 move 要用）。 */
  const fileSectionToCatalogId = new Map<string, string>();
  for (const [sectionId, fileSec] of matchedSections) fileSectionToCatalogId.set(fileSec.title, sectionId);

  // ── 第二趟：字段层，全局一次 ───────────────────────────────────────────
  /** catalog field id → 它现在待在文件的哪里。 */
  const placements = new Map<string, {
    fromSectionId: string;
    fromSectionTitle: string;
    fromName: string;
    valueCount: number;
  }>();
  /** 文件分节标题 → 该节里 catalog 认不出的字段。 */
  const unknownBySection = new Map<string, Array<{ name: string; valueCount: number }>>();

  for (const [fromSectionId, fileSec] of matchedSections) {
    for (const fileField of fileSec.fields) {
      // 1) 先在本分节内找在役字段（字段名只在其所属分节内唯一，这是主判据）
      const scoped = resolveFieldIdentity(templateId, fileSec.title, fileField.name);
      let identity: FieldIdentity | null = null;
      if (!isIdentityFailure(scoped)) {
        identity = scoped.identity;
      } else if (scoped.reason === 'ambiguous') {
        base.unsupportedChanges.push({
          kind: 'split_field',
          status: 'requires_manual_or_future_migration',
          detail: `field "${fileSec.title} · ${fileField.name}" is claimed by ${scoped.detail || 'multiple fields'}`,
        });
        continue;
      } else {
        // 2) 本节找不到 → 是不是被移到了别的分节（靠 field_id 认，不靠名字猜）
        const anywhere = findFieldIdentityAnywhere(templateId, fileField.name);
        if (!isIdentityFailure(anywhere)) {
          identity = anywhere.identity;
        } else if (anywhere.reason === 'ambiguous') {
          // 跨分节同名字段是合法的，所以这里的歧义定不了归属 —— 不猜。
          base.conflicts.push({
            kind: 'ambiguous_identity',
            detail: `field "${fileSec.title} · ${fileField.name}" matches several fields: ${anywhere.detail || ''}`,
          });
          continue;
        }
      }

      if (identity) {
        const seen = placements.get(identity.fieldId);
        if (seen) {
          // 两个文件字段落到同一个 catalog 字段 = 一次合并。值怎么并、留哪个
          // 顺序，都要产品决定，不猜。
          base.unsupportedChanges.push({
            kind: 'merge_field',
            status: 'requires_manual_or_future_migration',
            detail: `fields "${seen.fromSectionTitle} · ${seen.fromName}" and "${fileSec.title} · ${fileField.name}" both resolve to "${identity.fieldId}"`,
          });
          continue;
        }
        placements.set(identity.fieldId, {
          fromSectionId,
          fromSectionTitle: fileSec.title,
          fromName: fileField.name,
          valueCount: fileField.valueCount,
        });
        continue;
      }

      // 3) 不是在役字段 → 看 catalog 有没有明确声明它已退役
      const retired = resolveRetiredFieldIdentity(templateId, fileSec.title, fileField.name);
      if (!isIdentityFailure(retired)) {
        base.retiredFields.push({
          sectionId: fromSectionId,
          sectionTitle: fileSec.title,
          fieldId: retired.identity.fieldId,
          name: fileField.name,
          valueCount: fileField.valueCount,
          ...(retired.identity.retiredIn ? { retiredIn: retired.identity.retiredIn } : {}),
        });
        continue;
      }

      // 4) 既非在役也没声明退役 → 用户自建（或作者忘了声明），原样留着，不猜
      const arr = unknownBySection.get(fileSec.title) || [];
      arr.push({ name: fileField.name, valueCount: fileField.valueCount });
      unknownBySection.set(fileSec.title, arr);
      base.unknownInFile.fields.push({
        sectionTitle: fileSec.title,
        name: fileField.name,
        valueCount: fileField.valueCount,
      });
    }
  }

  // ── 第三趟：按 catalog 结算缺什么、改了什么、搬到哪 ─────────────────────
  for (let i = 0; i < template.preset_groups.length; i++) {
    const catSec = template.preset_groups[i];
    const fileSec = matchedSections.get(catSec.id);

    if (!fileSec) {
      base.additions.sections.push({
        sectionId: catSec.id,
        title: catSec.title,
        catalogIndex: i,
        fields: catSec.fields.map((f) => ({ fieldId: f.id, name: f.name })),
      });
      base.target.push({
        sectionId: catSec.id,
        title: catSec.title,
        fields: catSec.fields.map((f) => ({ fieldId: f.id, name: f.name })),
      });
      continue;
    }

    const targetSection: MigrationTargetSection = {
      sectionId: catSec.id,
      title: catSec.title,
      fromTitle: fileSec.title,
      fields: [],
    };
    base.target.push(targetSection);

    const missing: AddedField[] = [];
    for (const catField of catSec.fields) {
      const at = placements.get(catField.id);
      if (!at) {
        missing.push({
          sectionId: catSec.id,
          sectionTitle: catSec.title,
          fieldId: catField.id,
          name: catField.name,
        });
        targetSection.fields.push({ fieldId: catField.id, name: catField.name });
        continue;
      }
      targetSection.fields.push({
        fieldId: catField.id,
        name: catField.name,
        from: { sectionTitle: at.fromSectionTitle, name: at.fromName },
      });
      if (at.fromSectionId !== catSec.id) {
        base.movedFields.push({
          fieldId: catField.id,
          name: at.fromName,
          fromSectionId: at.fromSectionId,
          fromSectionTitle: at.fromSectionTitle,
          toSectionId: catSec.id,
          toSectionTitle: catSec.title,
        });
      }
      if (at.fromName !== catField.name) {
        base.renamedFields.push({
          sectionId: catSec.id,
          sectionTitle: catSec.title,
          fieldId: catField.id,
          from: at.fromName,
          to: catField.name,
        });
      }
    }

    // 同一分节里既有「认不出的名字」又有「缺失的坑」→ 疑似未声明的字段改名。
    // 如实记下来，但**不阻断**（理由见 suspectedFieldRenames 的注释）。
    const unknownHere = unknownBySection.get(fileSec.title) || [];
    if (unknownHere.length && missing.length) {
      base.suspectedFieldRenames.push({
        sectionTitle: fileSec.title,
        unknown: unknownHere.map((u) => u.name),
        missing: missing.map((m) => m.name),
      });
    }
    base.additions.fields.push(...missing);
  }

  // 分节层的同类嫌疑：文件里有认不出的节，catalog 又有节缺失。字段层放行、
  // 分节层拦住的理由见 possible_undeclared_rename 的注释。
  if (base.unknownInFile.sections.length && base.additions.sections.length) {
    base.conflicts.push({
      kind: 'possible_undeclared_rename',
      detail: `unknown sections [${base.unknownInFile.sections.join(', ')}] alongside missing sections [${base.additions.sections.map((s) => s.title).join(', ')}]`,
    });
  }

  base.needsMigration = Boolean(
    base.additions.sections.length
      || base.additions.fields.length
      || base.renamedSections.length
      || base.renamedFields.length
      || base.movedFields.length
      || base.unsupportedChanges.length
      || base.conflicts.length
      || compareTemplateVersion(installed.version, template.version) !== 0
      // 台账缓存与文件权威分叉也算「有事要做」——否则「文件已写、台账未更新」
      // 的崩溃窗口永远自愈不了：结构和版本都已到位，只有缓存落后。
      || Boolean(ledgerVersion && ledgerVersion !== installed.version),
  );

  return base;
}

// ── Migration Plan ─────────────────────────────────────────────────────────

export interface RoleTemplateMigrationPlan {
  templateId: string;
  fromVersion: string;
  toVersion: string;
  ledgerVersion?: string;
  additions: { sections: AddedSection[]; fields: AddedField[] };
  renamedSections: RoleTemplateMigrationDetection['renamedSections'];
  renamedFields: RoleTemplateMigrationDetection['renamedFields'];
  movedFields: RoleTemplateMigrationDetection['movedFields'];
  retiredFields: RoleTemplateMigrationDetection['retiredFields'];
  unsupportedChanges: UnsupportedChange[];
  conflicts: MigrationConflict[];
  /** 执行骨架；apply 只消费它，不再回头查 catalog。 */
  target: MigrationTargetSection[];
  /**
   * 唯一的执行闸门：无冲突、无不支持的变化（合并/拆分），且确有可做的事。
   * 为 false 时**拒绝升级版本号**，实例如实停在旧版本，而不是留下一个
   * 半迁移 schema。
   */
  canAutoApply: boolean;
  /**
   * 结构已经和 catalog 一致，只差版本号。两种来源：catalog 只改了文案；
   * 或者上次迁移「文件已写、台账未更新」中途崩溃（见 apply 的自愈说明）。
   */
  versionOnly: boolean;
}

/** detection → plan。纯函数：这一步本身就是 dry-run，不需要额外开关。 */
export function planRoleTemplateMigration(
  detection: RoleTemplateMigrationDetection,
): RoleTemplateMigrationPlan {
  const hasStructuralWork = Boolean(
    detection.additions.sections.length
      || detection.additions.fields.length
      || detection.renamedSections.length
      || detection.renamedFields.length
      || detection.movedFields.length,
  );
  const clean = detection.conflicts.length === 0 && detection.unsupportedChanges.length === 0;
  // retiredFields 不算「有结构活要干」：它不动文件，只是把语义从 active 换成
  // retired。所以「只有退役」的升级仍然是 versionOnly，一次写版本行就够。
  const versionOnly = clean && !hasStructuralWork && detection.needsMigration;

  return {
    templateId: detection.templateId,
    fromVersion: detection.fromVersion,
    toVersion: detection.toVersion,
    ...(detection.ledgerVersion ? { ledgerVersion: detection.ledgerVersion } : {}),
    additions: detection.additions,
    renamedSections: detection.renamedSections,
    renamedFields: detection.renamedFields,
    movedFields: detection.movedFields,
    retiredFields: detection.retiredFields,
    unsupportedChanges: detection.unsupportedChanges,
    conflicts: detection.conflicts,
    target: detection.target,
    canAutoApply: clean && detection.needsMigration,
    versionOnly,
  };
}

// ── Apply（只执行纯新增）───────────────────────────────────────────────────

export interface ApplyMigrationResult {
  ok: boolean;
  templateId: string;
  /**
   * `migrated`        文件被重写（补坑 / 只更新版本行）+ 台账同步；
   * `ledger_repaired` 文件本来就已经是目标版本与目标结构，只补台账缓存
   *                   （上一次迁移「文件已写、台账未更新」中途崩溃的自愈路径）；
   * `noop`            无事可做；
   * `refused`         识别到本轮不支持的变化或冲突 —— **不升级版本号**；
   * `failed`          执行中出错 —— 文件与台账都保持迁移前状态。
   */
  outcome: 'migrated' | 'ledger_repaired' | 'noop' | 'refused' | 'failed';
  fromVersion?: string;
  toVersion?: string;
  addedSections?: number;
  addedFields?: number;
  renamedSections?: number;
  renamedFields?: number;
  movedFields?: number;
  retiredFields?: number;
  refusal?: { unsupportedChanges: UnsupportedChange[]; conflicts: MigrationConflict[] };
  backupDir?: string;
  error?: string;
}

/** 模板文件内容 → detection 需要的结构投影。 */
export function toInstalledShape(content: TemplateFileContent): InstalledTemplateShape {
  return {
    version: content.version,
    sections: (content.sections || []).map((s) => ({
      title: s.title,
      fields: Object.keys(s.fields || {}).map((name) => ({
        name,
        valueCount: (s.fields[name] || []).length,
      })),
    })),
  };
}

/** `分节 \u0000 字段` 复合 key。分节名与字段名都可能含空格，用 NUL 才不会撞。 */
const slotKey = (sectionTitle: string, fieldName: string) => `${sectionTitle}\u0000${fieldName}`;
const label = (key: string) => key.replace('\u0000', ' · ');

/**
 * 按 plan 的执行骨架重建整份内容。**只搬不改**：值数组是整块引用过去的，
 * 一条都不新增、不删除、不重写；变的只有它挂在哪个分节标题、哪个字段名下。
 *
 * 重建而不是就地增删改，是因为 add / rename / move 混在一起时，就地操作的
 * 中间态会互相踩：先改名会撞上还没搬走的同名字段，先搬走又会让改名找不到源。
 * 重建没有中间态 —— 目标结构是一次算出来的，旧内容只被读取。
 */
function buildMigratedContent(
  before: TemplateFileContent,
  plan: RoleTemplateMigrationPlan,
): { content?: TemplateFileContent; error?: string } {
  const fileSecByTitle = new Map(before.sections.map((s) => [s.title, s] as const));

  // 先把所有「被骨架认领的来源」标记完，再开始产出。分两趟是必须的：
  // 字段可能从靠后的分节搬到靠前的分节，一趟式会在处理来源分节时把它当成
  // 「没人要的遗留字段」原地留下，于是搬走一份、又留下一份。
  const claimed = new Set<string>();
  for (const t of plan.target) {
    for (const f of t.fields) {
      if (f.from) claimed.add(slotKey(f.from.sectionTitle, f.from.name));
    }
  }

  const sections: TemplateSection[] = [];
  const emittedTitles = new Set<string>();

  const emitSection = (title: string, fields: Record<string, FieldValue[]>, flowEntries: string[]): string | null => {
    if (emittedTitles.has(title)) return `duplicate section title after migration: ${title}`;
    emittedTitles.add(title);
    sections.push({ title, fields, flowEntries });
    return null;
  };

  for (const t of plan.target) {
    const src = t.fromTitle ? fileSecByTitle.get(t.fromTitle) : undefined;
    if (t.fromTitle && !src) return { error: `source section missing: ${t.fromTitle}` };

    const fields: Record<string, FieldValue[]> = {};
    for (const f of t.fields) {
      if (Object.prototype.hasOwnProperty.call(fields, f.name)) {
        return { error: `duplicate field name in section "${t.title}": ${f.name}` };
      }
      if (!f.from) {
        fields[f.name] = []; // 新补的空坑
        continue;
      }
      const fromSec = fileSecByTitle.get(f.from.sectionTitle);
      const values = fromSec?.fields[f.from.name];
      if (!values) return { error: `source field missing: ${label(slotKey(f.from.sectionTitle, f.from.name))}` };
      fields[f.name] = values; // 整块搬，不复制不修改
    }

    // 该分节里 catalog 没认领的字段（retired + custom）按原顺序跟在后面。
    // 它们装着用户数据，退役/自建都不是删除的理由。
    if (src) {
      for (const name of Object.keys(src.fields)) {
        if (claimed.has(slotKey(src.title, name))) continue;
        if (Object.prototype.hasOwnProperty.call(fields, name)) {
          return { error: `field name collision in section "${t.title}": ${name}` };
        }
        fields[name] = src.fields[name];
      }
    }

    const err = emitSection(t.title, fields, src ? src.flowEntries : []);
    if (err) return { error: err };
  }

  // catalog 认不出的分节原样保留（用户数据），排在 catalog 分节之后。
  const targetSources = new Set(plan.target.map((t) => t.fromTitle).filter(Boolean) as string[]);
  for (const s of before.sections) {
    if (targetSources.has(s.title)) continue;
    const fields: Record<string, FieldValue[]> = {};
    for (const name of Object.keys(s.fields)) {
      if (claimed.has(slotKey(s.title, name))) continue; // 已被搬到某个 catalog 分节
      fields[name] = s.fields[name];
    }
    const err = emitSection(s.title, fields, s.flowEntries);
    if (err) return { error: err };
  }

  return {
    content: {
      title: before.title,
      template_id: before.template_id,
      version: plan.toVersion,
      installed_at: before.installed_at,
      sections,
    },
  };
}

/** 全文件的值清单（含来源与项目标记），排序后可直接做多重集比较。 */
function valueInventory(content: TemplateFileContent): string[] {
  const out: string[] = [];
  for (const sec of content.sections || []) {
    for (const name of Object.keys(sec.fields || {})) {
      for (const fv of sec.fields[name] || []) {
        out.push(`${fv.value}\u0000${fv.source}\u0000${fv.project ?? ''}`);
      }
    }
  }
  return out.sort();
}

/** 全文件的流水条目清单，同样用于多重集比较。 */
function flowInventory(content: TemplateFileContent): string[] {
  return (content.sections || []).flatMap((s) => s.flowEntries || []).sort();
}

/**
 * 后置校验。任何一条不过 → 不写盘、不升级版本。
 *
 * 骨干是一条极强又极简的不变式：**迁移从不新增、删除或改写任何一条值**，
 * 所以迁移前后全文件的值多重集必须**完全相等**（不是「不减少」）。
 * add 只加空坑、rename 只改名、move 只换分节、retire 什么都不动 —— 任何一条
 * 值内容或条数发生变化，都说明搬运出了错。
 */
function validateMigrated(
  before: TemplateFileContent,
  after: TemplateFileContent,
  plan: RoleTemplateMigrationPlan,
): string | null {
  const bv = valueInventory(before);
  const av = valueInventory(after);
  if (bv.length !== av.length) return `value count changed: ${bv.length} to ${av.length}`;
  for (let i = 0; i < bv.length; i++) {
    if (bv[i] !== av[i]) return `value set changed around "${label(bv[i])}"`;
  }

  const bf = flowInventory(before);
  const af = flowInventory(after);
  if (bf.length !== af.length) return `flow entry count changed: ${bf.length} to ${af.length}`;
  for (let i = 0; i < bf.length; i++) {
    if (bf[i] !== af[i]) return 'flow entries changed';
  }

  // 逐坑核对：同一个 field_id 迁移前后的值序列必须逐条相同（含 source/project）。
  // 多重集相等只保证「值没丢」，这一条保证「值没串门」。
  const afterSecByTitle = new Map(after.sections.map((s) => [s.title, s] as const));
  const beforeSecByTitle = new Map(before.sections.map((s) => [s.title, s] as const));
  for (const t of plan.target) {
    const dst = afterSecByTitle.get(t.title);
    if (!dst) return `target section missing after migration: ${t.title}`;
    for (const f of t.fields) {
      const got = dst.fields[f.name];
      if (!got) return `target field missing after migration: ${t.title} · ${f.name}`;
      if (!f.from) {
        if (got.length) return `newly added slot is not empty: ${t.title} · ${f.name}`;
        continue;
      }
      const src = beforeSecByTitle.get(f.from.sectionTitle)?.fields[f.from.name] || [];
      if (got.length !== src.length) {
        return `field ${f.fieldId} value count changed: ${src.length} to ${got.length}`;
      }
      for (let i = 0; i < src.length; i++) {
        if (got[i].value !== src[i].value
          || got[i].source !== src[i].source
          || (got[i].project ?? undefined) !== (src[i].project ?? undefined)) {
          return `field ${f.fieldId} value or metadata changed at index ${i}`;
        }
      }
    }
  }

  // 退役字段的值必须一条不动（退役只改语义，不动数据）。
  for (const r of plan.retiredFields) {
    const target = plan.target.find((t) => t.sectionId === r.sectionId);
    const dst = afterSecByTitle.get(target ? target.title : r.sectionTitle);
    const got = dst?.fields[r.name];
    if (!got) return `retired field disappeared: ${r.sectionTitle} · ${r.name}`;
    if (got.length !== r.valueCount) {
      return `retired field ${r.fieldId} value count changed: ${r.valueCount} to ${got.length}`;
    }
  }

  if (after.version !== plan.toVersion) return `serialized version mismatch: ${after.version}`;
  if (!isValidTemplateVersion(plan.toVersion)) return `target version is not a writable semver: ${plan.toVersion}`;
  return null;
}

/**
 * 不动点校验：拿迁移结果再跑一遍 detect，必须已经无事可做。
 *
 * 这一条同时证明三件事：catalog 声明的每个坑都落到了实例里；没有任何
 * field_id 出现两次（否则会报 merge）；再跑一次迁移是 noop（幂等）。
 * 比逐条重述 plan 干了什么可靠 —— 它检查的是结果本身。
 */
function validateFixedPoint(templateId: string, after: TemplateFileContent): string | null {
  const again = detectRoleTemplateMigration(templateId, toInstalledShape(after));
  const leftovers = [
    ...again.additions.sections.map((x) => `add section ${x.title}`),
    ...again.additions.fields.map((x) => `add field ${x.sectionTitle} · ${x.name}`),
    ...again.renamedSections.map((x) => `rename section ${x.from}`),
    ...again.renamedFields.map((x) => `rename field ${x.from}`),
    ...again.movedFields.map((x) => `move field ${x.name}`),
    ...again.unsupportedChanges.map((x) => x.kind),
    ...again.conflicts.map((x) => x.kind),
  ];
  return leftovers.length ? `migration is not a fixed point: ${leftovers.join(', ')}` : null;
}

/**
 * 执行一次 schema migration。**整份文件只有一次 `writeTextAtomicSync`** ——
 * 所有变更先在内存里的 `TemplateFileContent` 上做完、校验完，最后一次性换上去，
 * 所以磁盘上只存在「迁移前」和「迁移后」两种状态，没有半迁移文件。
 *
 * 顺序：锁 → 锁内重读并重新 detect → 备份 → 内存 apply → validate →
 * 原子写文件 → 更新台账 → 通知索引 → 清理旧备份。
 *
 * 文件写成功、台账没来得及更新就崩溃：下一次 detect 读的是**文件**版本，
 * 会发现结构与版本都已到位，于是走 `ledger_repaired` 只补台账，不重复迁移。
 * 这就是「文件优先于台账」的红利 —— 自愈不需要额外的修复代码。
 */
export async function applyRoleTemplateMigration(
  uid: string,
  templateId: string,
): Promise<ApplyMigrationResult> {
  if (!safeId(uid)) return { ok: false, templateId, outcome: 'failed', error: 'invalid uid' };

  const abs = templateFileAbsPath(uid, templateId);
  return fileEditLock(abs).runExclusive(async (): Promise<ApplyMigrationResult> => {
    // 锁内重读：锁外算出的任何 plan 都只是预判，期间可能有手填/自动写入落过盘。
    const text = readTemplateFileText(uid, templateId);
    if (!text) return { ok: false, templateId, outcome: 'failed', error: 'template file not found' };

    const row = readGroups(uid).find((g) => g.template_id === templateId);
    if (!row) return { ok: false, templateId, outcome: 'failed', error: 'template is not installed' };

    const before = parseTemplateContent(text);
    const detection = detectRoleTemplateMigration(templateId, toInstalledShape(before), row.template_version);
    const plan = planRoleTemplateMigration(detection);

    if (!detection.needsMigration) {
      return { ok: true, templateId, outcome: 'noop', fromVersion: plan.fromVersion, toVersion: plan.toVersion };
    }
    if (!plan.canAutoApply) {
      log.info('role template migration refused; instance stays on its real version', {
        uid,
        templateId,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        unsupported: plan.unsupportedChanges.map((c) => c.kind),
        conflicts: plan.conflicts.map((c) => c.kind),
      });
      return {
        ok: false,
        templateId,
        outcome: 'refused',
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        refusal: { unsupportedChanges: plan.unsupportedChanges, conflicts: plan.conflicts },
      };
    }

    if (!getRoleTemplate(templateId)) {
      return { ok: false, templateId, outcome: 'failed', error: 'template not found' };
    }

    // 不阻断，但必须留痕：这是唯一能事后发现「作者改名忘了声明 previous_names」
    // 的地方。只记分节名与计数，不记字段名（用户自建字段名属于用户内容）。
    if (detection.suspectedFieldRenames.length) {
      log.warn('role template migration: unrecognised field names alongside missing slots', {
        uid,
        templateId,
        sections: detection.suspectedFieldRenames.map((s) => ({
          section: s.sectionTitle,
          unknown: s.unknown.length,
          missing: s.missing.length,
        })),
      });
    }

    /** 台账缓存对齐到文件的真实版本。 */
    const syncLedger = (version: string) => {
      const groups = readGroups(uid);
      const idx = groups.findIndex((g) => g.group_id === row.group_id);
      if (idx === -1) return;
      groups[idx] = { ...groups[idx], template_version: version, updated_at: nowIso() };
      writeGroups(uid, groups);
    };

    // 文件本来就已经是目标版本 + 目标结构 → 只有台账这份缓存落后了。
    if (plan.versionOnly && before.version === plan.toVersion) {
      syncLedger(plan.toVersion);
      log.info('role template ledger version repaired from file', {
        uid, templateId, ledgerWas: row.template_version, version: plan.toVersion,
      });
      return {
        ok: true,
        templateId,
        outcome: 'ledger_repaired',
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
      };
    }

    let backupDir: string | undefined;
    try {
      backupDir = backupTemplateFileForMigration(uid, templateId) || undefined;

      const built = buildMigratedContent(before, plan);
      if (built.error || !built.content) {
        log.warn('role template migration could not be built; nothing written', { uid, templateId, problem: built.error });
        return { ok: false, templateId, outcome: 'failed', error: built.error || 'build failed', backupDir };
      }
      const after = built.content;

      const problem = validateMigrated(before, after, plan) || validateFixedPoint(templateId, after);
      if (problem) {
        log.warn('role template migration failed validation; nothing written', { uid, templateId, problem });
        return { ok: false, templateId, outcome: 'failed', error: problem, backupDir };
      }

      const next = serializeTemplateContent(after);
      const bytes = Buffer.byteLength(next, 'utf8');
      if (bytes > MAX_FILE_BYTES) {
        return { ok: false, templateId, outcome: 'failed', error: 'migrated file exceeds size limit', backupDir };
      }
      // round-trip：写下去的字节必须还能被同一个 parser 读回同样的东西，
      // 否则「内存里对了」等于没对。
      const roundTrip = parseTemplateContent(next);
      const rtProblem = validateMigrated(before, roundTrip, plan) || validateFixedPoint(templateId, roundTrip);
      if (rtProblem || roundTrip.template_id !== templateId) {
        return {
          ok: false,
          templateId,
          outcome: 'failed',
          error: `round-trip check failed: ${rtProblem || 'template_id mismatch'}`,
          backupDir,
        };
      }

      // ── 唯一一次写文件 ──
      writeTextAtomicSync(abs, next);
      // ── 文件落盘之后才轮到台账（缓存跟着权威走）──
      syncLedger(plan.toVersion);
      notifyGroupUpserted(uid, `.personal_ontology_groups/${templateId}.md`);
      pruneMigrationBackups(uid, templateId);

      const counts = {
        addedSections: plan.additions.sections.length,
        addedFields: plan.additions.fields.length,
        renamedSections: plan.renamedSections.length,
        renamedFields: plan.renamedFields.length,
        movedFields: plan.movedFields.length,
        retiredFields: plan.retiredFields.length,
      };
      log.info('role template schema migrated', {
        uid, templateId, fromVersion: plan.fromVersion, toVersion: plan.toVersion, ...counts,
      });
      return { ok: true, templateId, outcome: 'migrated', fromVersion: plan.fromVersion, toVersion: plan.toVersion, ...counts, backupDir };
    } catch (err) {
      log.warn('role template migration threw; file and ledger left untouched', {
        uid, templateId, error: (err as Error).message,
      });
      return { ok: false, templateId, outcome: 'failed', error: (err as Error).message, backupDir };
    }
  });
}

/**
 * 对该用户所有已安装模板跑一遍 detect then apply。
 * 单个模板失败不影响其它模板：schema 迁移是逐模板独立的事务。
 */
export async function reconcileInstalledRoleTemplates(uid: string): Promise<ApplyMigrationResult[]> {
  if (!safeId(uid)) return [];
  const out: ApplyMigrationResult[] = [];
  let templateIds: string[];
  try {
    templateIds = readGroups(uid).filter((g) => g.template_id).map((g) => g.template_id as string);
  } catch (err) {
    log.warn('role template reconcile: ledger unreadable', { uid, error: (err as Error).message });
    return [];
  }
  for (const templateId of templateIds) {
    try {
      out.push(await applyRoleTemplateMigration(uid, templateId));
    } catch (err) {
      out.push({ ok: false, templateId, outcome: 'failed', error: (err as Error).message });
    }
  }
  return out;
}

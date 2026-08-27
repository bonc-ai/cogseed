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
  /** 文件里该分节的标题 —— 可自动执行时它必然等于 catalog 当前 title。 */
  sectionTitle: string;
  fieldId: string;
  name: string;
  /** catalog 里排在它前面的那个字段的当前名；apply 据此就地插入而不是追加。 */
  afterName?: string;
}

/**
 * 本轮识别得出、但**不执行**的变化。带 `status` 是为了让调用方一眼看出
 * 「系统知道发生了什么，只是这一版不动手」，而不是被当成 add/delete 混过去。
 */
export interface UnsupportedChange {
  kind: 'rename_section' | 'rename_field' | 'move_field';
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
     * 同一作用域内同时存在「文件里认不出的名字」和「catalog 里缺失的坑」：
     * 这可能是一次**未声明 previous_names 的改名**。无法与「用户自建字段 +
     * catalog 新增字段」区分，所以按最保守处理——拒绝，不硬加空坑。
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
  movedFields: Array<{ fieldId: string; name: string; fromSection: string; toSectionId: string; toSectionTitle: string }>;
  /**
   * 文件里存在、但 catalog 当前认不出的分节/字段。**信息项，不阻断**：
   * 用户自建字段是一等功能（升格建坑），把它当阻断条件会让所有用过该功能的
   * 用户永远迁不动。等 `retired_fields` 落地后，这里才能进一步区分
   * 「产品下架的旧字段」和「用户自建字段」。
   */
  unknownInFile: { sections: string[]; fields: Array<{ sectionTitle: string; name: string; valueCount: number }> };
  conflicts: MigrationConflict[];
}

/**
 * 比对「实例文件结构」与「catalog 当前 schema」，输出结构化结果。**只读不写。**
 *
 * catalog 不从参数进 —— 它是 schema authority，让调用方传一份进来等于允许
 * 拿一个假 catalog 去驱动真实文件的迁移。版本口径仍然显式出现在结果的
 * `toVersion` 里。
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
    unknownInFile: { sections: [], fields: [] },
    conflicts: [],
  };

  const template = getRoleTemplate(templateId);
  if (!template) {
    base.conflicts.push({ kind: 'unknown_template', detail: templateId });
    return base;
  }
  base.toVersion = template.version;

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

  // ── 分节层：文件分节 → catalog identity ────────────────────────────────
  /** catalog section id → 文件里对应的那一节。 */
  const matchedSections = new Map<string, InstalledSectionShape>();
  for (const fileSec of installed.sections) {
    const res = resolveSectionIdentity(templateId, fileSec.title);
    if (isIdentityFailure(res)) {
      if (res.reason === 'ambiguous') {
        base.conflicts.push({ kind: 'ambiguous_identity', detail: `section "${fileSec.title}": ${res.detail || ''}` });
      } else {
        base.unknownInFile.sections.push(fileSec.title);
      }
      continue;
    }
    // 同一个 catalog 分节被两个文件分节认领（用户手工建了个重名节）→ 不猜。
    if (matchedSections.has(res.identity.sectionId)) {
      base.conflicts.push({
        kind: 'ambiguous_identity',
        detail: `two file sections resolve to "${res.identity.sectionId}"`,
      });
      continue;
    }
    matchedSections.set(res.identity.sectionId, fileSec);
    if (res.matchedBy === 'previous_name') {
      base.renamedSections.push({ sectionId: res.identity.sectionId, from: fileSec.title, to: res.identity.title });
    }
  }

  // ── 字段层 ─────────────────────────────────────────────────────────────
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
      continue;
    }

    /** catalog field id → 文件里对应字段名。 */
    const matchedFields = new Map<string, string>();
    const unknownHere: Array<{ name: string; valueCount: number }> = [];

    for (const fileField of fileSec.fields) {
      const res = resolveFieldIdentity(templateId, fileSec.title, fileField.name);
      if (isIdentityFailure(res)) {
        if (res.reason === 'ambiguous') {
          base.conflicts.push({
            kind: 'ambiguous_identity',
            detail: `field "${fileSec.title} · ${fileField.name}": ${res.detail || ''}`,
          });
          continue;
        }
        // 本节里认不出 → 看看它是不是被移到了别的分节（move 本轮不执行，
        // 但必须认出来，不能当成 delete + add）。
        const anywhere = findFieldIdentityAnywhere(templateId, fileField.name);
        if (!isIdentityFailure(anywhere) && anywhere.identity.sectionId !== catSec.id) {
          base.movedFields.push({
            fieldId: anywhere.identity.fieldId,
            name: fileField.name,
            fromSection: fileSec.title,
            toSectionId: anywhere.identity.sectionId,
            toSectionTitle: anywhere.identity.sectionTitle,
          });
          continue;
        }
        unknownHere.push({ name: fileField.name, valueCount: fileField.valueCount });
        continue;
      }
      if (matchedFields.has(res.identity.fieldId)) {
        base.conflicts.push({
          kind: 'ambiguous_identity',
          detail: `two file fields in "${fileSec.title}" resolve to "${res.identity.fieldId}"`,
        });
        continue;
      }
      matchedFields.set(res.identity.fieldId, fileField.name);
      if (res.matchedBy === 'previous_name') {
        base.renamedFields.push({
          sectionId: catSec.id,
          sectionTitle: fileSec.title,
          fieldId: res.identity.fieldId,
          from: fileField.name,
          to: res.identity.name,
        });
      }
    }

    const missing: AddedField[] = [];
    for (let j = 0; j < catSec.fields.length; j++) {
      const catField = catSec.fields[j];
      if (matchedFields.has(catField.id)) continue;
      // 插到「catalog 里排在它前面、且文件里已经存在」的那个字段之后。
      let afterName: string | undefined;
      for (let k = j - 1; k >= 0; k--) {
        const prev = matchedFields.get(catSec.fields[k].id);
        if (prev) { afterName = prev; break; }
      }
      missing.push({
        sectionId: catSec.id,
        sectionTitle: fileSec.title,
        fieldId: catField.id,
        name: catField.name,
        ...(afterName ? { afterName } : {}),
      });
    }

    // 同一分节里既有「认不出的名字」又有「缺失的坑」→ 可能是未声明的改名。
    if (unknownHere.length && missing.length) {
      base.conflicts.push({
        kind: 'possible_undeclared_rename',
        detail: `section "${fileSec.title}": unknown [${unknownHere.map((u) => u.name).join(', ')}] alongside missing [${missing.map((m) => m.name).join(', ')}]`,
      });
    }
    base.additions.fields.push(...missing);
    for (const u of unknownHere) {
      base.unknownInFile.fields.push({ sectionTitle: fileSec.title, name: u.name, valueCount: u.valueCount });
    }
  }

  // 分节层的同类嫌疑：文件里有认不出的节，catalog 又有节缺失。
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
      || base.conflicts.length
      || compareTemplateVersion(installed.version, template.version) !== 0,
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
  unsupportedChanges: UnsupportedChange[];
  conflicts: MigrationConflict[];
  /**
   * 唯一的执行闸门：无冲突、无本轮不支持的变化，且确有可做的事。
   * 有任何一条 rename / move 被识别出来 → false，本轮**拒绝升级版本号**，
   * 实例如实停在旧版本，而不是留下一个半迁移 schema。
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
  const unsupportedChanges: UnsupportedChange[] = [
    ...detection.renamedSections.map((r) => ({
      kind: 'rename_section' as const,
      status: 'requires_manual_or_future_migration' as const,
      detail: `section "${r.from}" → "${r.to}" (${r.sectionId})`,
    })),
    ...detection.renamedFields.map((r) => ({
      kind: 'rename_field' as const,
      status: 'requires_manual_or_future_migration' as const,
      detail: `field "${r.sectionTitle} · ${r.from}" → "${r.to}" (${r.fieldId})`,
    })),
    ...detection.movedFields.map((m) => ({
      kind: 'move_field' as const,
      status: 'requires_manual_or_future_migration' as const,
      detail: `field "${m.name}" moves from "${m.fromSection}" to "${m.toSectionTitle}" (${m.fieldId})`,
    })),
  ];

  const hasAdditions = Boolean(detection.additions.sections.length || detection.additions.fields.length);
  const clean = detection.conflicts.length === 0 && unsupportedChanges.length === 0;
  const versionOnly = clean && !hasAdditions && detection.needsMigration;

  return {
    templateId: detection.templateId,
    fromVersion: detection.fromVersion,
    toVersion: detection.toVersion,
    ...(detection.ledgerVersion ? { ledgerVersion: detection.ledgerVersion } : {}),
    additions: detection.additions,
    unsupportedChanges,
    conflicts: detection.conflicts,
    canAutoApply: clean && detection.needsMigration,
    versionOnly,
  };
}

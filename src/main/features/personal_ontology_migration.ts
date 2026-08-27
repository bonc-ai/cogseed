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
  movedFields: Array<{ fieldId: string; name: string; fromSection: string; toSectionId: string; toSectionTitle: string }>;
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
    suspectedFieldRenames: [],
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

    // 同一分节里既有「认不出的名字」又有「缺失的坑」→ 疑似未声明的字段改名。
    // 如实记下来，但**不阻断**（理由见 suspectedFieldRenames 的注释）。
    if (unknownHere.length && missing.length) {
      base.suspectedFieldRenames.push({
        sectionTitle: fileSec.title,
        unknown: unknownHere.map((u) => u.name),
        missing: missing.map((m) => m.name),
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

/** 在内存里施加 additions。**只加不改**：已有字段的值数组连引用都不碰。 */
function applyAdditions(content: TemplateFileContent, plan: RoleTemplateMigrationPlan): void {
  // 1) 补字段：按 afterName 就地插入，保持 catalog 的字段顺序。
  //    JS 对象保留字符串 key 的插入顺序，所以重建 fields 即重排显示顺序。
  const bySection = new Map<string, AddedField[]>();
  for (const add of plan.additions.fields) {
    const arr = bySection.get(add.sectionTitle) || [];
    arr.push(add);
    bySection.set(add.sectionTitle, arr);
  }
  for (const [sectionTitle, adds] of bySection) {
    const sec = content.sections.find((s) => s.title === sectionTitle);
    if (!sec) continue; // validate 会兜住；这里不静默造节
    const rebuilt: Record<string, FieldValue[]> = {};
    // catalog 里排在所有已存在字段之前的新坑，插到最前。
    for (const add of adds.filter((a) => !a.afterName)) rebuilt[add.name] = [];
    for (const name of Object.keys(sec.fields)) {
      rebuilt[name] = sec.fields[name];
      for (const add of adds.filter((a) => a.afterName === name)) rebuilt[add.name] = [];
    }
    // 落位不了的（afterName 指向的字段本身也是新加的）→ 追加到末尾：
    // 宁可顺序不完美，也不能丢坑。
    for (const add of adds) {
      if (!Object.prototype.hasOwnProperty.call(rebuilt, add.name)) rebuilt[add.name] = [];
    }
    sec.fields = rebuilt;
  }

  // 2) 补分节：按 catalog 下标插回原位（下标升序处理，插入后位置才对得上）。
  for (const add of [...plan.additions.sections].sort((a, b) => a.catalogIndex - b.catalogIndex)) {
    const section: TemplateSection = {
      title: add.title,
      fields: Object.fromEntries(add.fields.map((f) => [f.name, [] as FieldValue[]])),
      flowEntries: [],
    };
    const at = Math.min(add.catalogIndex, content.sections.length);
    content.sections.splice(at, 0, section);
  }
}

/** 迁移前后的可比快照：`分节\u0000字段` → 值条数，分节 → 流水条数。 */
function snapshot(content: TemplateFileContent): {
  fields: Map<string, number>;
  flow: Map<string, number>;
  totalValues: number;
} {
  const fields = new Map<string, number>();
  const flow = new Map<string, number>();
  let totalValues = 0;
  for (const sec of content.sections || []) {
    flow.set(sec.title, sec.flowEntries.length);
    for (const name of Object.keys(sec.fields || {})) {
      const n = (sec.fields[name] || []).length;
      // 用 NUL 连接：分节名与字段名都可能含空格，拿空格当分隔会让两个不同的
      // (分节, 字段) 撞成同一个 key，快照比对就会漏掉真实差异。
      fields.set(`${sec.title}\u0000${name}`, n);
      totalValues += n;
    }
  }
  return { fields, flow, totalValues };
}

const label = (key: string) => key.replace('\u0000', ' · ');

/**
 * 后置校验。任何一条不过 → 不写盘、不升级版本。这里是「只加不改」这条承诺的
 * 唯一执行者：它比较的是**迁移前后的实际内容**，而不是复述 plan 说了什么。
 */
function validateMigrated(
  before: TemplateFileContent,
  after: TemplateFileContent,
  plan: RoleTemplateMigrationPlan,
  template: RoleTemplate,
): string | null {
  const b = snapshot(before);
  const a = snapshot(after);

  if (a.totalValues < b.totalValues) return `value count shrank: ${b.totalValues} to ${a.totalValues}`;

  for (const [key, count] of b.fields) {
    if (!a.fields.has(key)) return `field disappeared: ${label(key)}`;
    if (a.fields.get(key) !== count) {
      return `field value count changed: ${label(key)} ${count} to ${a.fields.get(key)}`;
    }
  }
  for (const [title, count] of b.flow) {
    if (a.flow.get(title) !== count) return `flow entries changed in section "${title}"`;
  }

  // catalog 当前声明的每个坑都必须在文件里 —— 这才是「补坑」的验收标准。
  for (const catSec of template.preset_groups) {
    const sec = after.sections.find((s) => s.title === catSec.title);
    if (!sec) return `catalog section missing after migration: ${catSec.title}`;
    for (const f of catSec.fields) {
      if (!Object.prototype.hasOwnProperty.call(sec.fields, f.name)) {
        return `catalog field missing after migration: ${catSec.title} · ${f.name}`;
      }
    }
  }

  const expectedNew = plan.additions.fields.length
    + plan.additions.sections.reduce((n, s) => n + s.fields.length, 0);
  if (a.fields.size !== b.fields.size + expectedNew) {
    return `unexpected field count: ${b.fields.size} + ${expectedNew} != ${a.fields.size}`;
  }

  if (after.version !== plan.toVersion) return `serialized version mismatch: ${after.version}`;
  if (!isValidTemplateVersion(plan.toVersion)) return `target version is not a writable semver: ${plan.toVersion}`;
  return null;
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

    const template = getRoleTemplate(templateId);
    if (!template) return { ok: false, templateId, outcome: 'failed', error: 'template not found' };

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

      const after = parseTemplateContent(text); // 独立的第二份，before 保持原样供比对
      applyAdditions(after, plan);
      after.version = plan.toVersion;

      const problem = validateMigrated(before, after, plan, template);
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
      const rtProblem = validateMigrated(before, roundTrip, plan, template);
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

      log.info('role template schema migrated', {
        uid,
        templateId,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        addedSections: plan.additions.sections.length,
        addedFields: plan.additions.fields.length,
      });
      return {
        ok: true,
        templateId,
        outcome: 'migrated',
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        addedSections: plan.additions.sections.length,
        addedFields: plan.additions.fields.length,
        backupDir,
      };
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

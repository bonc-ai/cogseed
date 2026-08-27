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

/**
 * Meeting ontology tools shared by both Agent execution paths.
 *
 * The same Agent may run a turn in the CogSeed Runtime worker (host tool
 * adapter) or in-process through core-agent (follow-up replies routed by the
 * Group Chat bus), so both tool surfaces delegate here and keep one behaviour.
 *
 * Peripheral to `features/ontology_graph.ts`: this module only calls that
 * module's exported API and never reads or writes its file directly, so the
 * graph keeps its single validation/lock/write choke point.
 *
 *   - `ontology_graph_read` — bounded read: a keyword/category page, or one
 *     entity with its one-hop neighbours. Lets Agents see the skeleton the
 *     user maintains by hand (people, projects, meeting series).
 *   - `ontology_projection_apply` — deterministic projection of one confirmed
 *     meeting record (`meeting_record.v1` JSON the meeting agent writes in its
 *     workspace). The model never hands entities to the graph: the tool reads
 *     the file and maps it field by field.
 *
 * Write boundaries (prototype, not yet adopted by the graph owner):
 *   - creates/updates/archives only entities in the meeting-owned categories,
 *     recognised by domain + parent + name + a `记录标识` field; never deletes;
 *   - people, projects and series are linked through entity ids the record
 *     names, and only when those ids resolve into the expected category family;
 *   - new people/series/projects are created only from `new_entities` entries the
 *     user confirmed in the minutes form (`confirmed: true`); a same-named active
 *     entity in the target family is reused instead, so re-runs never duplicate.
 *     These are the only writes outside the meeting-owned categories (团队成员,
 *     会议系列 and the built-in 项目), and they never update existing entities;
 *   - idempotent through `记录标识` (`meeting:<ref>` / `meeting:<ref>#<itemId>`),
 *     so re-applying a record — or a revised minutes version — updates in place.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { isPathAllowed } from '../util/path-sandbox';
import { MEETING_RECORD_SCHEMA, MEETING_RECORD_TEMPLATE } from './meeting-record-contract';
import {
  createOntologyCategory,
  createOntologyEntity,
  createOntologyRelation,
  readOntologyGraph,
  updateOntologyEntity,
  ONTOLOGY_DOMAINS,
  type OntologyCategory,
  type OntologyDomain,
  type OntologyEndpoint,
  type OntologyEntity,
  type OntologyGraphSnapshot,
} from './ontology_graph';

const log = createLogger('meeting-ontology-projection');

export type MeetingOntologyToolName = 'ontology_graph_read' | 'ontology_projection_apply';

export interface MeetingOntologyToolResult { content: string; isError?: boolean }

/** Caller-resolved scope: roots the record file may be read from. */
export interface MeetingOntologyToolScope {
  userId: string;
  roots: readonly string[];
  workingDir?: string;
}

export { MEETING_RECORD_SCHEMA, MEETING_RECORD_TEMPLATE };
export const RECORD_KEY_FIELD = '记录标识';

const PAGE_SIZE = 20;
const MAX_PAGE_RELATIONS = 60;
const MAX_NEIGHBOUR_RELATIONS = 80;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORD_ITEMS = 200;
const MAX_SOURCE_REFS = 20;

/** Fixed relation vocabulary. Kept in Chinese because the graph UI shows it verbatim. */
export const MEETING_PREDICATES = Object.freeze({
  decides: '作出决议',
  raises: '提出问题',
  produces: '产生行动项',
  derivedFrom: '派生自',
  assignedTo: '指派给',
  participatesIn: '参与',
  partOfProject: '属于项目',
  partOfSeries: '属于系列',
  resolves: '解决了',
});

type CategoryKey = 'meeting' | 'decision' | 'question' | 'action' | 'series' | 'member';

interface CategorySpec {
  key: CategoryKey;
  domain: OntologyDomain;
  parentId?: string;
  name: string;
  description: string;
  fields: readonly string[];
  /** Owned = the projection writes entities here and requires the record-key field. */
  owned: boolean;
}

const OWNED_HINT = '由会议智能体按确认后的纪要维护；记录标识字段请勿修改。';

export const MEETING_CATEGORY_SPECS: readonly CategorySpec[] = Object.freeze([
  { key: 'meeting', domain: 'affairs', parentId: 'builtin_affairs_event', name: '会议记录', description: `一场已确认纪要的会议。${OWNED_HINT}`, fields: [RECORD_KEY_FIELD, '会议日期', '腾讯会议号', '纪要版本', '纪要文件', '参会人原文'], owned: true },
  { key: 'decision', domain: 'affairs', parentId: 'builtin_affairs_decision', name: '会议决议', description: `会议中明确作出的结论。${OWNED_HINT}`, fields: [RECORD_KEY_FIELD, '所属会议', '原文出处'], owned: true },
  { key: 'question', domain: 'affairs', name: '会议未决问题', description: `会议提出但尚无结论的问题。${OWNED_HINT}`, fields: [RECORD_KEY_FIELD, '状态', '所属会议', '原文出处'], owned: true },
  { key: 'action', domain: 'affairs', parentId: 'builtin_affairs_task', name: '会议行动项', description: `会议明确提出的后续安排。${OWNED_HINT}`, fields: [RECORD_KEY_FIELD, '负责人原文', '截止原文', '状态', '外部任务号', '所属会议', '原文出处'], owned: true },
  { key: 'series', domain: 'affairs', parentId: 'builtin_affairs_event', name: '会议系列', description: '周期性或同一主题的系列会议，由用户维护。', fields: ['别名'], owned: false },
  { key: 'member', domain: 'resources', parentId: 'builtin_resource_person', name: '团队成员', description: '与会议相关的成员，由用户维护别名与外部账号，用于对齐转写中的称呼。', fields: ['别名', '腾讯会议账号', 'MeshSeed成员'], owned: false },
]);

const PERSON_ROOT = 'builtin_resource_person';
const PROJECT_ROOT = 'builtin_affairs_project';

function error(code: string, message: string): MeetingOntologyToolResult {
  return { content: `[${code}] ${message}`, isError: true };
}

function excerpt(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// ── shared graph helpers ────────────────────────────────────────────────────

function categoryMap(graph: OntologyGraphSnapshot): Map<string, OntologyCategory> {
  return new Map(graph.categories.map((category) => [category.id, category]));
}

function categoryPath(categoryId: string, categories: Map<string, OntologyCategory>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = categories.get(categoryId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? categories.get(current.parentId) : undefined;
  }
  return names;
}

function inFamily(categoryId: string, rootId: string, categories: Map<string, OntologyCategory>): boolean {
  const seen = new Set<string>();
  let current = categories.get(categoryId);
  while (current && !seen.has(current.id)) {
    if (current.id === rootId) return true;
    seen.add(current.id);
    current = current.parentId ? categories.get(current.parentId) : undefined;
  }
  return false;
}

function namedProperties(entity: OntologyEntity, category: OntologyCategory | undefined, limit: number): Record<string, string> {
  const names = new Map((category?.fields ?? []).map((field) => [field.id, field.name]));
  const out: Record<string, string> = {};
  for (const [fieldId, value] of Object.entries(entity.properties)) {
    out[names.get(fieldId) ?? fieldId] = excerpt(value, limit);
  }
  return out;
}

// ── ontology_graph_read ─────────────────────────────────────────────────────

const DOMAIN_SET = new Set<string>(ONTOLOGY_DOMAINS);

function entityView(entity: OntologyEntity, categories: Map<string, OntologyCategory>) {
  return {
    id: entity.id,
    name: entity.name,
    category: categoryPath(entity.categoryId, categories).join(' > '),
    domain: entity.domain,
    status: entity.status,
    ...(entity.description ? { description: excerpt(entity.description, 300) } : {}),
    properties: namedProperties(entity, categories.get(entity.categoryId), 200),
  };
}

function endpointView(endpoint: OntologyEndpoint, entities: Map<string, OntologyEntity>) {
  if (endpoint.kind === 'self') return { kind: 'self', name: '我' };
  return { kind: 'entity', id: endpoint.id, name: entities.get(endpoint.id)?.name ?? '(unavailable)' };
}

function touches(endpoint: OntologyEndpoint, ids: ReadonlySet<string>): boolean {
  return endpoint.kind === 'entity' && ids.has(endpoint.id);
}

function readBoundedText(value: unknown, label: string, max: number): string | MeetingOntologyToolResult {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > max) return error('E_ONTOLOGY_INPUT', `${label} must be a string of at most ${max} characters`);
  return value.trim();
}

export async function readOntologyGraphView(userId: string, input: Record<string, unknown>): Promise<MeetingOntologyToolResult> {
  const query = readBoundedText(input.query, 'query', 200);
  if (typeof query !== 'string') return query;
  const categoryFilter = readBoundedText(input.category, 'category', 80);
  if (typeof categoryFilter !== 'string') return categoryFilter;
  const entityId = readBoundedText(input.entity_id, 'entity_id', 64);
  if (typeof entityId !== 'string') return entityId;
  if (input.domain !== undefined && (typeof input.domain !== 'string' || !DOMAIN_SET.has(input.domain))) {
    return error('E_ONTOLOGY_INPUT', 'domain must be affairs, resources or concepts');
  }
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10_000) {
    return error('E_ONTOLOGY_INPUT', 'offset must be an integer between 0 and 10000');
  }
  const includeArchived = input.include_archived === true;

  const graph = await readOntologyGraph(userId);
  const categories = categoryMap(graph);
  const entities = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const relationView = (relation: OntologyGraphSnapshot['relations'][number]) => ({
    id: relation.id,
    subject: endpointView(relation.subject, entities),
    predicate: relation.predicate,
    object: endpointView(relation.object, entities),
    ...(relation.note ? { note: excerpt(relation.note, 200) } : {}),
  });

  if (entityId) {
    const entity = entities.get(entityId);
    if (!entity) return error('E_ONTOLOGY_NOT_FOUND', 'entity not found');
    const ids = new Set([entityId]);
    const relations = graph.relations
      .filter((relation) => touches(relation.subject, ids) || touches(relation.object, ids))
      .slice(0, MAX_NEIGHBOUR_RELATIONS);
    const neighbourIds = new Set<string>();
    for (const relation of relations) {
      for (const endpoint of [relation.subject, relation.object]) {
        if (endpoint.kind === 'entity' && endpoint.id !== entityId) neighbourIds.add(endpoint.id);
      }
    }
    return {
      content: JSON.stringify({
        entity: entityView(entity, categories),
        neighbours: [...neighbourIds].map((id) => entities.get(id)).filter((item): item is OntologyEntity => !!item)
          .map((item) => entityView(item, categories)),
        relations: relations.map(relationView),
      }),
    };
  }

  const needle = query.toLocaleLowerCase();
  const categoryNeedle = categoryFilter.toLocaleLowerCase();
  const matched = graph.entities.filter((entity) => {
    if (!includeArchived && entity.status !== 'active') return false;
    if (input.domain && entity.domain !== input.domain) return false;
    const pathNames = categoryPath(entity.categoryId, categories);
    if (categoryNeedle && !pathNames.some((name) => name.toLocaleLowerCase() === categoryNeedle)) return false;
    if (!needle) return true;
    const haystack = [entity.name, entity.description, ...Object.values(entity.properties), ...pathNames]
      .join('\n').toLocaleLowerCase();
    return haystack.includes(needle);
  });
  const page = matched.slice(offset, offset + PAGE_SIZE);
  const pageIds = new Set(page.map((entity) => entity.id));
  const relations = graph.relations
    .filter((relation) => touches(relation.subject, pageIds) || touches(relation.object, pageIds))
    .slice(0, MAX_PAGE_RELATIONS);
  return {
    content: JSON.stringify({
      total: matched.length,
      offset,
      ...(offset + PAGE_SIZE < matched.length ? { next_offset: offset + PAGE_SIZE } : {}),
      entities: page.map((entity) => entityView(entity, categories)),
      relations: relations.map(relationView),
    }),
  };
}

// ── meeting_record.v1 validation ────────────────────────────────────────────

export interface MeetingRecordItemBase { id: string; text: string; sourceRefs: string[] }
export interface MeetingRecord {
  meeting: {
    ref: string;
    title: string;
    date?: string;
    tencentMeetingId?: string;
    minutesVersion: string;
    minutesFile?: string;
    seriesEntityId?: string;
    projectEntityId?: string;
    seriesNewEntity?: string;
    projectNewEntity?: string;
  };
  participants: Array<{ name: string; entityId?: string; newEntity?: string }>;
  newEntities: MeetingNewEntity[];
  decisions: MeetingRecordItemBase[];
  openQuestions: Array<MeetingRecordItemBase & { status: 'open' | 'resolved' }>;
  actionItems: Array<MeetingRecordItemBase & {
    ownerText?: string;
    ownerEntityId?: string;
    ownerNewEntity?: string;
    deadlineText?: string;
    status: 'clue' | 'candidate' | 'created';
    externalTaskKey?: string;
    derivedFrom: string[];
  }>;
  resolves: Array<{ priorMeetingRef: string; priorItemId: string; by: string }>;
}

export type MeetingNewEntityKind = 'member' | 'series' | 'project';

/** A person/series/project the minutes proposed and the user may confirm. */
export interface MeetingNewEntity {
  key: string;
  kind: MeetingNewEntityKind;
  name: string;
  aliases: string[];
  tencentAccount?: string;
  meshseedMember?: string;
  confirmed: boolean;
}

class RecordError extends Error {
  constructor(message: string, readonly code = 'E_ONTOLOGY_RECORD_INVALID') { super(message); }
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const ENTITY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function obj(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RecordError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function str(value: unknown, label: string, max: number, required = true): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RecordError(`${label} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new RecordError(`${label} must be a string`);
  const text = value.trim();
  if (!text) {
    if (required) throw new RecordError(`${label} is required`);
    return undefined;
  }
  if (text.length > max) throw new RecordError(`${label} exceeds ${max} characters`);
  return text;
}

function entityIdOf(value: unknown, label: string): string | undefined {
  const id = str(value, label, 64, false);
  if (id !== undefined && !ENTITY_ID_RE.test(id)) throw new RecordError(`${label} is not a valid entity id`);
  return id;
}

function arr(value: unknown, label: string, max = MAX_RECORD_ITEMS): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RecordError(`${label} must be an array`);
  if (value.length > max) throw new RecordError(`${label} has more than ${max} entries`);
  return value;
}

function sourceRefs(value: unknown, label: string): string[] {
  return arr(value, label, MAX_SOURCE_REFS).map((item, index) => str(item, `${label}[${index}]`, 200)!);
}

function items<T>(value: unknown, label: string, prefix: string, map: (raw: Record<string, unknown>, base: MeetingRecordItemBase, at: string) => T): T[] {
  const seen = new Set<string>();
  const pattern = new RegExp(`^${prefix}\\d{1,4}$`);
  return arr(value, label).map((item, index) => {
    const at = `${label}[${index}]`;
    const raw = obj(item, at);
    const id = str(raw.id, `${at}.id`, 8)!;
    if (!pattern.test(id)) throw new RecordError(`${at}.id must look like ${prefix}1`);
    if (seen.has(id)) throw new RecordError(`${at}.id is duplicated`);
    seen.add(id);
    const base = { id, text: str(raw.text, `${at}.text`, 2_000)!, sourceRefs: sourceRefs(raw.source_refs, `${at}.source_refs`) };
    return map(raw, base, at);
  });
}

export function parseMeetingRecord(value: unknown): MeetingRecord {
  const raw = obj(value, 'record');
  if (raw.schema !== MEETING_RECORD_SCHEMA) throw new RecordError(`schema must be "${MEETING_RECORD_SCHEMA}"`);
  const meeting = obj(raw.meeting, 'meeting');
  if (meeting.confirmed !== true) throw new RecordError('meeting.confirmed must be true: only confirmed minutes can be projected');
  const ref = str(meeting.ref, 'meeting.ref', 120)!;
  if (!REF_RE.test(ref)) throw new RecordError('meeting.ref may only contain letters, digits, ".", "_", ":" and "-"');

  const newEntities = arr(raw.new_entities, 'new_entities', 50).map((item, index) => {
    const at = `new_entities[${index}]`;
    const entry = obj(item, at);
    const key = str(entry.key, `${at}.key`, 8)!;
    if (!/^N\d{1,3}$/.test(key)) throw new RecordError(`${at}.key must look like N1`);
    const kind = entry.kind;
    if (kind !== 'member' && kind !== 'series' && kind !== 'project') throw new RecordError(`${at}.kind must be member, series or project`);
    const aliases = arr(entry.aliases, `${at}.aliases`, 10).map((alias, aliasIndex) => str(alias, `${at}.aliases[${aliasIndex}]`, 40)!);
    const tencentAccount = str(entry.tencent_account, `${at}.tencent_account`, 120, false);
    const meshseedMember = str(entry.meshseed_member, `${at}.meshseed_member`, 120, false);
    return {
      key,
      kind: kind as MeetingNewEntityKind,
      name: str(entry.name, `${at}.name`, 80)!,
      aliases,
      confirmed: entry.confirmed === true,
      ...(tencentAccount ? { tencentAccount } : {}),
      ...(meshseedMember ? { meshseedMember } : {}),
    };
  });
  const newEntityKinds = new Map<string, MeetingNewEntityKind>();
  for (const entity of newEntities) {
    if (newEntityKinds.has(entity.key)) throw new RecordError(`new_entities key ${entity.key} is duplicated`);
    newEntityKinds.set(entity.key, entity.kind);
  }
  const newEntityRef = (value: unknown, label: string, kind: MeetingNewEntityKind): string | undefined => {
    const key = str(value, label, 8, false);
    if (key === undefined) return undefined;
    if (newEntityKinds.get(key) !== kind) throw new RecordError(`${label} must reference a ${kind} entry in new_entities`);
    return key;
  };

  const decisions = items(raw.decisions, 'decisions', 'D', (_raw, base) => base);
  const decisionIds = new Set(decisions.map((item) => item.id));
  const openQuestions = items(raw.open_questions, 'open_questions', 'Q', (rawItem, base, at) => {
    const status = rawItem.status === undefined ? 'open' : rawItem.status;
    if (status !== 'open' && status !== 'resolved') throw new RecordError(`${at}.status must be open or resolved`);
    return { ...base, status: status as 'open' | 'resolved' };
  });
  const actionItems = items(raw.action_items, 'action_items', 'A', (rawItem, base, at) => {
    const status = rawItem.status === undefined ? 'clue' : rawItem.status;
    if (status !== 'clue' && status !== 'candidate' && status !== 'created') throw new RecordError(`${at}.status must be clue, candidate or created`);
    const derivedFrom = arr(rawItem.derived_from, `${at}.derived_from`, 20).map((id, index) => {
      const text = str(id, `${at}.derived_from[${index}]`, 8)!;
      if (!decisionIds.has(text)) throw new RecordError(`${at}.derived_from references unknown decision ${text}`);
      return text;
    });
    const ownerText = str(rawItem.owner_text, `${at}.owner_text`, 120, false);
    const ownerEntityId = entityIdOf(rawItem.owner_entity_id, `${at}.owner_entity_id`);
    const ownerNewEntity = newEntityRef(rawItem.owner_new_entity, `${at}.owner_new_entity`, 'member');
    const deadlineText = str(rawItem.deadline_text, `${at}.deadline_text`, 120, false);
    const externalTaskKey = str(rawItem.external_task_key, `${at}.external_task_key`, 120, false);
    return {
      ...base,
      status: status as 'clue' | 'candidate' | 'created',
      derivedFrom,
      ...(ownerText ? { ownerText } : {}),
      ...(ownerEntityId ? { ownerEntityId } : {}),
      ...(ownerNewEntity ? { ownerNewEntity } : {}),
      ...(deadlineText ? { deadlineText } : {}),
      ...(externalTaskKey ? { externalTaskKey } : {}),
    };
  });
  const resolves = arr(raw.resolves, 'resolves', 50).map((item, index) => {
    const at = `resolves[${index}]`;
    const entry = obj(item, at);
    const priorMeetingRef = str(entry.prior_meeting_ref, `${at}.prior_meeting_ref`, 120)!;
    if (!REF_RE.test(priorMeetingRef)) throw new RecordError(`${at}.prior_meeting_ref is invalid`);
    const priorItemId = str(entry.prior_item_id, `${at}.prior_item_id`, 8)!;
    if (!/^Q\d{1,4}$/.test(priorItemId)) throw new RecordError(`${at}.prior_item_id must look like Q1`);
    const by = str(entry.by, `${at}.by`, 8)!;
    if (!decisionIds.has(by)) throw new RecordError(`${at}.by references unknown decision ${by}`);
    return { priorMeetingRef, priorItemId, by };
  });
  const participants = arr(raw.participants, 'participants', 100).map((item, index) => {
    const entry = obj(item, `participants[${index}]`);
    const entityId = entityIdOf(entry.entity_id, `participants[${index}].entity_id`);
    const newEntity = newEntityRef(entry.new_entity, `participants[${index}].new_entity`, 'member');
    return { name: str(entry.name, `participants[${index}].name`, 80)!, ...(entityId ? { entityId } : {}), ...(newEntity ? { newEntity } : {}) };
  });

  const optional = (key: string, label: string, max: number) => str(meeting[key], label, max, false);
  const date = optional('date', 'meeting.date', 40);
  const tencentMeetingId = optional('tencent_meeting_id', 'meeting.tencent_meeting_id', 120);
  const minutesFile = optional('minutes_file', 'meeting.minutes_file', 500);
  const seriesEntityId = entityIdOf(meeting.series_entity_id, 'meeting.series_entity_id');
  const projectEntityId = entityIdOf(meeting.project_entity_id, 'meeting.project_entity_id');
  const seriesNewEntity = newEntityRef(meeting.series_new_entity, 'meeting.series_new_entity', 'series');
  const projectNewEntity = newEntityRef(meeting.project_new_entity, 'meeting.project_new_entity', 'project');
  return {
    meeting: {
      ref,
      title: str(meeting.title, 'meeting.title', 200)!,
      minutesVersion: str(meeting.minutes_version, 'meeting.minutes_version', 20)!,
      ...(date ? { date } : {}),
      ...(tencentMeetingId ? { tencentMeetingId } : {}),
      ...(minutesFile ? { minutesFile } : {}),
      ...(seriesEntityId ? { seriesEntityId } : {}),
      ...(projectEntityId ? { projectEntityId } : {}),
      ...(seriesNewEntity ? { seriesNewEntity } : {}),
      ...(projectNewEntity ? { projectNewEntity } : {}),
    },
    participants,
    newEntities,
    decisions,
    openQuestions,
    actionItems,
    resolves,
  };
}

// ── ontology_projection_apply ───────────────────────────────────────────────

interface ResolvedCategory { spec: CategorySpec; category: OntologyCategory; fieldIds: Map<string, string> }

function sameSlot(category: OntologyCategory, spec: CategorySpec): boolean {
  return category.domain === spec.domain
    && (category.parentId || '') === (spec.parentId || '')
    && category.name.toLocaleLowerCase() === spec.name.toLocaleLowerCase();
}

async function ensureCategories(userId: string, graph: OntologyGraphSnapshot): Promise<Map<CategoryKey, ResolvedCategory>> {
  const resolved = new Map<CategoryKey, ResolvedCategory>();
  for (const spec of MEETING_CATEGORY_SPECS) {
    let category = graph.categories.find((item) => sameSlot(item, spec));
    if (!category) {
      category = await createOntologyCategory(userId, {
        domain: spec.domain,
        name: spec.name,
        description: spec.description,
        ...(spec.parentId ? { parentId: spec.parentId } : {}),
        fields: [...spec.fields],
      });
    }
    const fieldIds = new Map(category.fields.map((field) => [field.name, field.id]));
    if (spec.owned && !fieldIds.has(RECORD_KEY_FIELD)) {
      throw new RecordError(`category "${spec.name}" already exists without the ${RECORD_KEY_FIELD} field; rename it or add the field before projecting`, 'E_ONTOLOGY_CATEGORY_CONFLICT');
    }
    resolved.set(spec.key, { spec, category, fieldIds });
  }
  return resolved;
}

function propertiesFor(target: ResolvedCategory, values: Record<string, string | undefined>, base: Record<string, string> = {}): Record<string, string> {
  const next = { ...base };
  for (const [name, value] of Object.entries(values)) {
    const fieldId = target.fieldIds.get(name);
    if (!fieldId) continue; // user removed the field: skip rather than rewrite their category
    const text = (value ?? '').trim();
    if (text) next[fieldId] = clip(text, 4_000);
    else delete next[fieldId];
  }
  return next;
}

function describeItem(text: string, refs: readonly string[]): string {
  return clip(refs.length ? `${text}\n\n出处：${refs.join('；')}` : text, 4_000);
}

function sameProperties(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? '') !== (b[key] ?? '')) return false;
  return true;
}

const MAX_WARNINGS = 50;
/** A usable source ref is "<source> · <segment>" whose segment carries a number
 *  (p12, U0003, 段落 7). Generic labels such as "转写片段" cannot be traced back. */
const SEGMENT_REF_RE = /^.+?\s·\s*[^·]*\d/;

/** Soft provenance/linkage checks. They never block a confirmed projection —
 *  the user already confirmed the content — but tell the Agent what to flag. */
export function meetingRecordWarnings(record: MeetingRecord): string[] {
  const warnings: string[] = [];
  const items: Array<{ id: string; sourceRefs: string[] }> = [...record.decisions, ...record.openQuestions, ...record.actionItems];
  for (const item of items) {
    if (!item.sourceRefs.length) warnings.push(`${item.id}: no source reference`);
    else if (item.sourceRefs.some((ref) => !SEGMENT_REF_RE.test(ref))) warnings.push(`${item.id}: source reference lacks a segment id`);
  }
  if (record.decisions.length) {
    for (const action of record.actionItems) {
      if (!action.derivedFrom.length) warnings.push(`${action.id}: not linked to any decision (derived_from is empty)`);
    }
  }
  if (record.meeting.minutesFile && !path.isAbsolute(record.meeting.minutesFile)) {
    warnings.push('meeting.minutes_file is not an absolute path');
  }
  return warnings.length > MAX_WARNINGS ? [...warnings.slice(0, MAX_WARNINGS), `…${warnings.length - MAX_WARNINGS} more`] : warnings;
}

interface ProjectionCounters {
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  relationsCreated: number;
  relationsExisting: number;
  skeletonCreated: number;
  skeletonReused: number;
  skipped: Array<{ item: string; reason: string }>;
}

export async function applyMeetingProjection(userId: string, record: MeetingRecord): Promise<Record<string, unknown>> {
  let graph = await readOntologyGraph(userId);
  const cats = await ensureCategories(userId, graph);
  graph = await readOntologyGraph(userId);
  const counters: ProjectionCounters = { created: 0, updated: 0, unchanged: 0, archived: 0, relationsCreated: 0, relationsExisting: 0, skeletonCreated: 0, skeletonReused: 0, skipped: [] };
  const meetingKey = `meeting:${record.meeting.ref}`;
  const keyOf = (itemId: string) => `${meetingKey}#${itemId}`;

  const byKey = new Map<string, OntologyEntity>();
  for (const target of cats.values()) {
    if (!target.spec.owned) continue;
    const keyField = target.fieldIds.get(RECORD_KEY_FIELD)!;
    for (const entity of graph.entities) {
      if (entity.categoryId !== target.category.id) continue;
      const key = entity.properties[keyField];
      if (key) byKey.set(`${target.spec.key}\0${key}`, entity);
    }
  }

  async function upsert(kind: CategoryKey, key: string, name: string, description: string, values: Record<string, string | undefined>): Promise<OntologyEntity> {
    const target = cats.get(kind)!;
    const existing = byKey.get(`${kind}\0${key}`);
    const properties = propertiesFor(target, { ...values, [RECORD_KEY_FIELD]: key }, existing?.properties);
    const entityName = clip(name.replace(/\s+/g, ' ').trim() || key, 120);
    if (!existing) {
      const created = await createOntologyEntity(userId, { categoryId: target.category.id, name: entityName, description, properties });
      byKey.set(`${kind}\0${key}`, created);
      counters.created += 1;
      return created;
    }
    if (existing.name === entityName && existing.description === description
      && existing.status === 'active' && sameProperties(existing.properties, properties)) {
      counters.unchanged += 1;
      return existing;
    }
    const updated = await updateOntologyEntity(userId, { entityId: existing.id, name: entityName, description, properties, status: 'active' });
    byKey.set(`${kind}\0${key}`, updated);
    counters.updated += 1;
    return updated;
  }

  const { meeting } = record;
  // A reused ref (e.g. a personal meeting room number) would silently merge two
  // meetings and archive the first one's items. Refuse when the stored date differs.
  const meetingTarget = cats.get('meeting')!;
  const dateField = meetingTarget.fieldIds.get('会议日期');
  const storedMeeting = byKey.get(`meeting\0${meetingKey}`);
  const storedDate = dateField ? storedMeeting?.properties[dateField] : undefined;
  if (storedDate && meeting.date && storedDate !== meeting.date) {
    throw new RecordError(`meeting.ref ${meeting.ref} already belongs to the meeting on ${storedDate}; use a per-occurrence ref such as <meeting-id>-<YYYYMMDD>`, 'E_ONTOLOGY_MEETING_REF_CONFLICT');
  }
  const meetingEntity = await upsert('meeting', meetingKey, meeting.title, clip(`会议纪要 ${meeting.minutesVersion}（已确认）`, 4_000), {
    会议日期: meeting.date,
    腾讯会议号: meeting.tencentMeetingId,
    纪要版本: meeting.minutesVersion,
    纪要文件: meeting.minutesFile,
    参会人原文: record.participants.map((participant) => participant.name).join('、'),
  });

  const decisionEntities = new Map<string, OntologyEntity>();
  for (const item of record.decisions) {
    decisionEntities.set(item.id, await upsert('decision', keyOf(item.id), item.text, describeItem(item.text, item.sourceRefs), {
      所属会议: meeting.title,
      原文出处: item.sourceRefs.join('；'),
    }));
  }
  const questionEntities = new Map<string, OntologyEntity>();
  for (const item of record.openQuestions) {
    questionEntities.set(item.id, await upsert('question', keyOf(item.id), item.text, describeItem(item.text, item.sourceRefs), {
      状态: item.status === 'resolved' ? '已解决' : '未解决',
      所属会议: meeting.title,
      原文出处: item.sourceRefs.join('；'),
    }));
  }
  const actionEntities = new Map<string, OntologyEntity>();
  const actionStatus = { clue: '会议线索', candidate: '候选任务', created: '已创建' } as const;
  for (const item of record.actionItems) {
    actionEntities.set(item.id, await upsert('action', keyOf(item.id), item.text, describeItem(item.text, item.sourceRefs), {
      负责人原文: item.ownerText,
      截止原文: item.deadlineText,
      状态: actionStatus[item.status],
      外部任务号: item.externalTaskKey,
      所属会议: meeting.title,
      原文出处: item.sourceRefs.join('；'),
    }));
  }

  // Items that a previous projection of this meeting wrote but the current
  // confirmed version no longer has: archive, never delete.
  const current = new Set([
    ...record.decisions.map((item) => `decision\0${keyOf(item.id)}`),
    ...record.openQuestions.map((item) => `question\0${keyOf(item.id)}`),
    ...record.actionItems.map((item) => `action\0${keyOf(item.id)}`),
  ]);
  for (const [compound, entity] of byKey) {
    const key = compound.slice(compound.indexOf('\0') + 1);
    if (!key.startsWith(`${meetingKey}#`) || current.has(compound) || entity.status !== 'active') continue;
    await updateOntologyEntity(userId, { entityId: entity.id, status: 'archived' });
    counters.archived += 1;
  }

  // Relations: resolve external ids once against a fresh snapshot.
  graph = await readOntologyGraph(userId);
  const categories = categoryMap(graph);
  const live = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const relationKeys = new Set(graph.relations.map((relation) => JSON.stringify([relation.subject, relation.predicate.toLocaleLowerCase(), relation.object])));
  const seriesRoot = cats.get('series')!.category.id;

  // Confirmed proposals → skeleton entities (reuse a same-named one in the family).
  const created = new Map<string, OntologyEntity>();
  const familyRoot: Record<MeetingNewEntityKind, string> = { member: PERSON_ROOT, series: seriesRoot, project: PROJECT_ROOT };
  const targetCategory: Record<MeetingNewEntityKind, string> = { member: cats.get('member')!.category.id, series: seriesRoot, project: PROJECT_ROOT };
  for (const proposal of record.newEntities) {
    if (!proposal.confirmed) continue;
    const wanted = proposal.name.toLocaleLowerCase();
    const existing = graph.entities.find((entity) => entity.status === 'active'
      && inFamily(entity.categoryId, familyRoot[proposal.kind], categories)
      && entity.name.toLocaleLowerCase() === wanted);
    if (existing) {
      created.set(proposal.key, existing);
      counters.skeletonReused += 1;
      continue;
    }
    const target = proposal.kind === 'member' ? cats.get('member')! : proposal.kind === 'series' ? cats.get('series')! : null;
    const properties = target ? propertiesFor(target, {
      别名: proposal.aliases.join('、'),
      ...(proposal.kind === 'member' ? { 腾讯会议账号: proposal.tencentAccount, MeshSeed成员: proposal.meshseedMember } : {}),
    }) : {};
    const entity = await createOntologyEntity(userId, {
      categoryId: targetCategory[proposal.kind],
      name: clip(proposal.name, 120),
      description: `由会议「${clip(meeting.title, 60)}」确认后创建。`,
      properties,
    });
    live.set(entity.id, entity);
    created.set(proposal.key, entity);
    counters.skeletonCreated += 1;
  }
  const fromProposal = (key: string | undefined, item: string): OntologyEntity | null => {
    if (!key) return null;
    const entity = created.get(key);
    if (!entity) counters.skipped.push({ item, reason: `new entity ${key} was not confirmed` });
    return entity ?? null;
  };

  function linked(id: string | undefined, rootId: string, item: string, label: string): OntologyEntity | null {
    if (!id) return null;
    const entity = live.get(id);
    if (!entity || entity.status !== 'active') {
      counters.skipped.push({ item, reason: `${label} entity ${id} is missing or archived` });
      return null;
    }
    if (!inFamily(entity.categoryId, rootId, categories)) {
      counters.skipped.push({ item, reason: `${label} entity ${id} is not under ${categoryPath(rootId, categories).join(' > ')}` });
      return null;
    }
    return entity;
  }

  async function relate(subject: OntologyEntity, predicate: string, object: OntologyEntity): Promise<void> {
    const subjectEndpoint: OntologyEndpoint = { kind: 'entity', id: subject.id };
    const objectEndpoint: OntologyEndpoint = { kind: 'entity', id: object.id };
    const key = JSON.stringify([subjectEndpoint, predicate.toLocaleLowerCase(), objectEndpoint]);
    if (relationKeys.has(key)) {
      counters.relationsExisting += 1;
      return;
    }
    await createOntologyRelation(userId, { subject: subjectEndpoint, predicate, object: objectEndpoint });
    relationKeys.add(key);
    counters.relationsCreated += 1;
  }

  for (const entity of decisionEntities.values()) await relate(meetingEntity, MEETING_PREDICATES.decides, entity);
  for (const entity of questionEntities.values()) await relate(meetingEntity, MEETING_PREDICATES.raises, entity);
  for (const item of record.actionItems) {
    const action = actionEntities.get(item.id)!;
    await relate(meetingEntity, MEETING_PREDICATES.produces, action);
    for (const decisionId of item.derivedFrom) await relate(action, MEETING_PREDICATES.derivedFrom, decisionEntities.get(decisionId)!);
    const owner = linked(item.ownerEntityId, PERSON_ROOT, item.id, 'owner') ?? fromProposal(item.ownerNewEntity, item.id);
    if (owner) await relate(action, MEETING_PREDICATES.assignedTo, owner);
  }
  for (const participant of record.participants) {
    const person = linked(participant.entityId, PERSON_ROOT, `participant:${participant.name}`, 'participant')
      ?? fromProposal(participant.newEntity, `participant:${participant.name}`);
    if (person) await relate(person, MEETING_PREDICATES.participatesIn, meetingEntity);
  }
  const project = linked(meeting.projectEntityId, PROJECT_ROOT, 'meeting', 'project') ?? fromProposal(meeting.projectNewEntity, 'meeting');
  if (project) await relate(meetingEntity, MEETING_PREDICATES.partOfProject, project);
  const series = linked(meeting.seriesEntityId, seriesRoot, 'meeting', 'series') ?? fromProposal(meeting.seriesNewEntity, 'meeting');
  if (series) await relate(meetingEntity, MEETING_PREDICATES.partOfSeries, series);

  const questionTarget = cats.get('question')!;
  const questionKeyField = questionTarget.fieldIds.get(RECORD_KEY_FIELD)!;
  for (const entry of record.resolves) {
    const priorKey = `meeting:${entry.priorMeetingRef}#${entry.priorItemId}`;
    const prior = graph.entities.find((entity) => entity.categoryId === questionTarget.category.id
      && entity.properties[questionKeyField] === priorKey);
    if (!prior) {
      counters.skipped.push({ item: `resolves:${priorKey}`, reason: 'prior open question was never projected' });
      continue;
    }
    await relate(decisionEntities.get(entry.by)!, MEETING_PREDICATES.resolves, prior);
    const statusField = questionTarget.fieldIds.get('状态');
    if (statusField && prior.properties[statusField] !== '已解决') {
      await updateOntologyEntity(userId, { entityId: prior.id, properties: { ...prior.properties, [statusField]: '已解决' } });
      counters.updated += 1;
    }
  }

  return {
    status: 'applied',
    meeting_entity_id: meetingEntity.id,
    entities: { created: counters.created, updated: counters.updated, unchanged: counters.unchanged, archived: counters.archived },
    relations: { created: counters.relationsCreated, existing: counters.relationsExisting },
    skeleton: { created: counters.skeletonCreated, reused: counters.skeletonReused },
    skipped: counters.skipped,
    warnings: meetingRecordWarnings(record),
  };
}

async function readRecordFile(input: Record<string, unknown>, scope: MeetingOntologyToolScope): Promise<unknown | MeetingOntologyToolResult> {
  const raw = input.record_path;
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4_000) return error('E_ONTOLOGY_INPUT', 'record_path is required');
  const file = path.resolve(scope.workingDir ?? '.', raw.trim());
  if (path.extname(file).toLowerCase() !== '.json') return error('E_ONTOLOGY_INPUT', 'record_path must point to a .json meeting record');
  const roots = scope.roots.filter(Boolean);
  if (!roots.length || !isPathAllowed(file, roots)) return error('E_PATH_OUT_OF_SCOPE', 'record_path is outside the Runtime scope');
  let text: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return error('E_ONTOLOGY_INPUT', 'record_path is not a file');
    if (stat.size > MAX_RECORD_BYTES) return error('E_ONTOLOGY_INPUT', 'meeting record exceeds 1 MB');
    text = await fs.readFile(file, 'utf8');
  } catch {
    return error('E_ONTOLOGY_INPUT', 'meeting record could not be read');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return error('E_ONTOLOGY_RECORD_INVALID', 'meeting record is not valid JSON');
  }
}

function isResult(value: unknown): value is MeetingOntologyToolResult {
  return !!value && typeof value === 'object' && 'isError' in value && (value as MeetingOntologyToolResult).isError === true;
}

export async function runMeetingOntologyTool(
  name: MeetingOntologyToolName,
  input: Record<string, unknown>,
  scope: MeetingOntologyToolScope,
): Promise<MeetingOntologyToolResult> {
  try {
    if (name === 'ontology_graph_read') return await readOntologyGraphView(scope.userId, input || {});
    const parsed = await readRecordFile(input || {}, scope);
    if (isResult(parsed)) return parsed;
    const record = parseMeetingRecord(parsed);
    return { content: JSON.stringify(await applyMeetingProjection(scope.userId, record)) };
  } catch (cause) {
    if (cause instanceof RecordError) {
      return error(cause.code, cause.code === 'E_ONTOLOGY_RECORD_INVALID'
        ? `${cause.message}\nFix every field against this shape in one edit (keys N1/D1/Q1/A1, enums as listed, omit unknown optionals), then apply once:\n${MEETING_RECORD_TEMPLATE}`
        : cause.message);
    }
    log.warn('meeting ontology tool failed', { tool: name, error: cause instanceof Error ? cause.message : String(cause) });
    return error('E_ONTOLOGY_GRAPH', cause instanceof Error ? cause.message : String(cause));
  }
}

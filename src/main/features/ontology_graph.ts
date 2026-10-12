/**
 * User-authored ontology graph.
 *
 * The graph stores classifications, entities and relationships only. Personal
 * profile values and formal cognition assets remain in their existing stores;
 * this module accepts stable references to them but never copies their content.
 */
import * as fs from 'node:fs/promises';

import { userOntologyGraphFile } from '../paths';
import { genId12, nowIso, safeId, writeJson } from '../storage';
import { fileEditLock } from '../util/locks';
import { notifyCognitionWrite } from './recall/store-events';

export const ONTOLOGY_GRAPH_SCHEMA_VERSION = 1 as const;
export const ONTOLOGY_DOMAINS = ['affairs', 'resources', 'concepts'] as const;
export type OntologyDomain = (typeof ONTOLOGY_DOMAINS)[number];
export type OntologyFieldKind = 'text' | 'date' | 'number';

export interface OntologyField {
  id: string;
  name: string;
  kind: OntologyFieldKind;
  nameKey?: string;
}

export interface OntologyCategory {
  id: string;
  domain: OntologyDomain;
  name: string;
  description: string;
  parentId?: string;
  fields: OntologyField[];
  builtIn: boolean;
  nameKey?: string;
  descriptionKey?: string;
}

export interface OntologySourceRef {
  kind: 'asset' | 'candidate';
  id: string;
}

export interface OntologyEntity {
  id: string;
  domain: OntologyDomain;
  categoryId: string;
  name: string;
  description: string;
  properties: Record<string, string>;
  sourceRefs: OntologySourceRef[];
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export type OntologyEndpoint = { kind: 'self' } | { kind: 'entity'; id: string };

export interface OntologyRelation {
  id: string;
  subject: OntologyEndpoint;
  predicate: string;
  object: OntologyEndpoint;
  note: string;
  sourceRefs: OntologySourceRef[];
  createdAt: string;
  updatedAt: string;
}

export interface OntologyGraphSnapshot {
  schemaVersion: typeof ONTOLOGY_GRAPH_SCHEMA_VERSION;
  categories: OntologyCategory[];
  entities: OntologyEntity[];
  relations: OntologyRelation[];
}

interface OntologyGraphFile extends OntologyGraphSnapshot {
  ownerId: string;
}

const MAX_GRAPH_BYTES = 12 * 1024 * 1024;
const MAX_CATEGORIES = 1_000;
const MAX_ENTITIES = 10_000;
const MAX_RELATIONS = 50_000;
const MAX_FIELDS_PER_CATEGORY = 48;
const MAX_SOURCE_REFS = 64;
const MAX_ENTITY_PROPERTIES = 48;

const FIELD = (id: string, name: string, nameKey: string, kind: OntologyFieldKind = 'text'): OntologyField => ({
  id,
  name,
  nameKey,
  kind,
});

/** Stable built-in categories are virtual: they do not get copied into the
 *  user's file and therefore remain available to old graph files. */
export const BUILTIN_ONTOLOGY_CATEGORIES: readonly OntologyCategory[] = [
  { id: 'builtin_affairs_project', domain: 'affairs', name: '项目', nameKey: 'ontologyGraph.category_project', description: '有目标、参与者和持续周期的事项。', descriptionKey: 'ontologyGraph.category_project_hint', fields: [FIELD('status', '状态', 'ontologyGraph.field_status'), FIELD('goal', '目标', 'ontologyGraph.field_goal'), FIELD('period', '周期', 'ontologyGraph.field_period')], builtIn: true },
  { id: 'builtin_affairs_task', domain: 'affairs', name: '任务', nameKey: 'ontologyGraph.category_task', description: '可执行、有状态或截止时间的工作项。', descriptionKey: 'ontologyGraph.category_task_hint', fields: [FIELD('status', '状态', 'ontologyGraph.field_status'), FIELD('due_date', '截止日期', 'ontologyGraph.field_due_date', 'date'), FIELD('project', '所属项目', 'ontologyGraph.field_project')], builtIn: true },
  { id: 'builtin_affairs_event', domain: 'affairs', name: '事件', nameKey: 'ontologyGraph.category_event', description: '在特定时间发生的事情及其结果。', descriptionKey: 'ontologyGraph.category_event_hint', fields: [FIELD('event_date', '发生时间', 'ontologyGraph.field_event_date', 'date'), FIELD('participants', '参与者', 'ontologyGraph.field_participants'), FIELD('outcome', '结果', 'ontologyGraph.field_outcome')], builtIn: true },
  { id: 'builtin_affairs_goal', domain: 'affairs', name: '目标', nameKey: 'ontologyGraph.category_goal', description: '期望达成的结果和衡量方式。', descriptionKey: 'ontologyGraph.category_goal_hint', fields: [FIELD('status', '状态', 'ontologyGraph.field_status'), FIELD('target_date', '目标日期', 'ontologyGraph.field_target_date', 'date'), FIELD('measure', '衡量方式', 'ontologyGraph.field_measure')], builtIn: true },
  { id: 'builtin_affairs_decision', domain: 'affairs', name: '决策', nameKey: 'ontologyGraph.category_decision', description: '已经作出的选择及其依据和影响。', descriptionKey: 'ontologyGraph.category_decision_hint', fields: [FIELD('decision_date', '决策日期', 'ontologyGraph.field_decision_date', 'date'), FIELD('rationale', '依据', 'ontologyGraph.field_rationale'), FIELD('impact', '影响', 'ontologyGraph.field_impact')], builtIn: true },
  { id: 'builtin_resource_person', domain: 'resources', name: '人物', nameKey: 'ontologyGraph.category_person', description: '与个人或事项有关的人。', descriptionKey: 'ontologyGraph.category_person_hint', fields: [FIELD('role', '角色', 'ontologyGraph.field_role'), FIELD('organization', '组织', 'ontologyGraph.field_organization')], builtIn: true },
  { id: 'builtin_resource_organization', domain: 'resources', name: '组织', nameKey: 'ontologyGraph.category_organization', description: '团队、公司或其他组织。', descriptionKey: 'ontologyGraph.category_organization_hint', fields: [FIELD('purpose', '职责或方向', 'ontologyGraph.field_purpose'), FIELD('location', '地点', 'ontologyGraph.field_location')], builtIn: true },
  { id: 'builtin_resource_product', domain: 'resources', name: '产品', nameKey: 'ontologyGraph.category_product', description: '产品、系统或服务。', descriptionKey: 'ontologyGraph.category_product_hint', fields: [FIELD('version', '版本', 'ontologyGraph.field_version'), FIELD('owner', '负责人', 'ontologyGraph.field_owner')], builtIn: true },
  { id: 'builtin_resource_tool', domain: 'resources', name: '工具', nameKey: 'ontologyGraph.category_tool', description: '工具、平台或工作环境。', descriptionKey: 'ontologyGraph.category_tool_hint', fields: [FIELD('purpose', '用途', 'ontologyGraph.field_purpose'), FIELD('related_project', '关联项目', 'ontologyGraph.field_project')], builtIn: true },
  { id: 'builtin_resource_document', domain: 'resources', name: '文档', nameKey: 'ontologyGraph.category_document', description: '规范、方案、资料或交付物。', descriptionKey: 'ontologyGraph.category_document_hint', fields: [FIELD('document_type', '文档类型', 'ontologyGraph.field_document_type'), FIELD('version', '版本', 'ontologyGraph.field_version')], builtIn: true },
  { id: 'builtin_resource_location', domain: 'resources', name: '地点', nameKey: 'ontologyGraph.category_location', description: '与人物或事项有关的地点。', descriptionKey: 'ontologyGraph.category_location_hint', fields: [FIELD('location_type', '地点类型', 'ontologyGraph.field_location_type'), FIELD('context', '说明', 'ontologyGraph.field_context')], builtIn: true },
  { id: 'builtin_concept_term', domain: 'concepts', name: '术语', nameKey: 'ontologyGraph.category_term', description: '有明确名称和含义的概念。', descriptionKey: 'ontologyGraph.category_term_hint', fields: [FIELD('definition', '定义', 'ontologyGraph.field_definition'), FIELD('aliases', '别名', 'ontologyGraph.field_aliases')], builtIn: true },
  { id: 'builtin_concept_method', domain: 'concepts', name: '方法', nameKey: 'ontologyGraph.category_method', description: '可复用的流程、技巧或方法。', descriptionKey: 'ontologyGraph.category_method_hint', fields: [FIELD('steps', '步骤', 'ontologyGraph.field_steps'), FIELD('applicable_when', '适用条件', 'ontologyGraph.field_applicable_when')], builtIn: true },
  { id: 'builtin_concept_rule', domain: 'concepts', name: '规则', nameKey: 'ontologyGraph.category_rule', description: '在明确条件下适用的约束或判断。', descriptionKey: 'ontologyGraph.category_rule_hint', fields: [FIELD('condition', '条件', 'ontologyGraph.field_condition'), FIELD('result', '结果', 'ontologyGraph.field_result')], builtIn: true },
];

const BUILTIN_CATEGORY_IDS = new Set(BUILTIN_ONTOLOGY_CATEGORIES.map((category) => category.id));
const BUILTIN_CATEGORY_BY_ID = new Map(BUILTIN_ONTOLOGY_CATEGORIES.map((category) => [category.id, category]));
const ONTOLOGY_DOMAIN_SET = new Set<string>(ONTOLOGY_DOMAINS);

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ontology ${field}`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, field: string, max: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} required`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`invalid ontology ${field}`);
  const text = value.trim();
  if (required && !text) throw new Error(`${field} required`);
  if (text.length > max) throw new Error(`ontology ${field} too long`);
  return text;
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !safeId(value)) throw new Error(`invalid ontology ${field}`);
  return value;
}

function requireDomain(value: unknown): OntologyDomain {
  if (typeof value !== 'string' || !ONTOLOGY_DOMAIN_SET.has(value)) throw new Error('invalid ontology domain');
  return value as OntologyDomain;
}

function fieldKind(value: unknown): OntologyFieldKind {
  if (value === 'text' || value === 'date' || value === 'number') return value;
  throw new Error('invalid ontology field kind');
}

function validateField(value: unknown): OntologyField {
  const raw = plainObject(value, 'field');
  return {
    id: requiredId(raw.id, 'field id'),
    name: boundedText(raw.name, 'field name', 80, true),
    kind: fieldKind(raw.kind),
  };
}

function validateFields(value: unknown): OntologyField[] {
  if (!Array.isArray(value) || value.length > MAX_FIELDS_PER_CATEGORY) throw new Error('invalid ontology fields');
  const fields = value.map(validateField);
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const field of fields) {
    const nameKey = field.name.toLocaleLowerCase();
    if (ids.has(field.id) || names.has(nameKey)) throw new Error('duplicate ontology category field');
    ids.add(field.id);
    names.add(nameKey);
  }
  return fields;
}

function validateCategory(value: unknown): OntologyCategory {
  const raw = plainObject(value, 'category');
  const id = requiredId(raw.id, 'category id');
  if (BUILTIN_CATEGORY_IDS.has(id)) throw new Error('custom ontology category id conflicts with built-in category');
  const parentId = raw.parentId == null || raw.parentId === '' ? undefined : requiredId(raw.parentId, 'parent category id');
  return {
    id,
    domain: requireDomain(raw.domain),
    name: boundedText(raw.name, 'category name', 80, true),
    description: boundedText(raw.description, 'category description', 500),
    ...(parentId ? { parentId } : {}),
    fields: validateFields(raw.fields),
    builtIn: false,
  };
}

function validateSourceRefs(value: unknown): OntologySourceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SOURCE_REFS) throw new Error('invalid ontology source references');
  const seen = new Set<string>();
  const refs: OntologySourceRef[] = [];
  for (const item of value) {
    const raw = plainObject(item, 'source reference');
    if (raw.kind !== 'asset' && raw.kind !== 'candidate') throw new Error('invalid ontology source reference kind');
    const id = requiredId(raw.id, 'source reference id');
    const key = `${raw.kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: raw.kind, id });
  }
  return refs;
}

function validateProperties(value: unknown, category: OntologyCategory): Record<string, string> {
  const raw = plainObject(value || {}, 'entity properties');
  const fields = new Map(category.fields.map((field) => [field.id, field]));
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENTITY_PROPERTIES) throw new Error('too many ontology entity properties');
  const properties: Record<string, string> = {};
  for (const [fieldId, fieldValue] of entries) {
    if (!fields.has(fieldId) || typeof fieldValue !== 'string') throw new Error('invalid ontology entity property');
    const text = fieldValue.trim();
    if (text.length > 4_000) throw new Error('ontology entity property too long');
    if (text) properties[fieldId] = text;
  }
  return properties;
}

function validateEntity(value: unknown, categories: Map<string, OntologyCategory>): OntologyEntity {
  const raw = plainObject(value, 'entity');
  const id = requiredId(raw.id, 'entity id');
  const domain = requireDomain(raw.domain);
  const categoryId = requiredId(raw.categoryId, 'entity category id');
  const category = categories.get(categoryId);
  if (!category || category.domain !== domain) throw new Error('ontology entity category is unavailable');
  const status = raw.status === 'archived' ? 'archived' : raw.status === 'active' ? 'active' : null;
  if (!status) throw new Error('invalid ontology entity status');
  const createdAt = boundedText(raw.createdAt, 'entity createdAt', 40, true);
  const updatedAt = boundedText(raw.updatedAt, 'entity updatedAt', 40, true);
  return {
    id,
    domain,
    categoryId,
    name: boundedText(raw.name, 'entity name', 120, true),
    description: boundedText(raw.description, 'entity description', 4_000),
    properties: validateProperties(raw.properties || {}, category),
    sourceRefs: validateSourceRefs(raw.sourceRefs),
    status,
    createdAt,
    updatedAt,
  };
}

function validateEndpoint(value: unknown): OntologyEndpoint {
  const raw = plainObject(value, 'relation endpoint');
  if (raw.kind === 'self') return { kind: 'self' };
  if (raw.kind === 'entity') return { kind: 'entity', id: requiredId(raw.id, 'relation entity id') };
  throw new Error('invalid ontology relation endpoint kind');
}

function validateRelation(value: unknown): OntologyRelation {
  const raw = plainObject(value, 'relation');
  const subject = validateEndpoint(raw.subject);
  const object = validateEndpoint(raw.object);
  if (subject.kind === 'self' && object.kind === 'self') throw new Error('ontology self relation is not allowed');
  if (subject.kind === 'entity' && object.kind === 'entity' && subject.id === object.id) {
    throw new Error('ontology entity cannot relate to itself');
  }
  return {
    id: requiredId(raw.id, 'relation id'),
    subject,
    predicate: boundedText(raw.predicate, 'relation name', 100, true),
    object,
    note: boundedText(raw.note, 'relation note', 1_000),
    sourceRefs: validateSourceRefs(raw.sourceRefs),
    createdAt: boundedText(raw.createdAt, 'relation createdAt', 40, true),
    updatedAt: boundedText(raw.updatedAt, 'relation updatedAt', 40, true),
  };
}

function emptyFile(userId: string): OntologyGraphFile {
  return {
    schemaVersion: ONTOLOGY_GRAPH_SCHEMA_VERSION,
    ownerId: userId,
    categories: [],
    entities: [],
    relations: [],
  };
}

function validateGraphFile(userId: string, value: unknown): OntologyGraphFile {
  const raw = plainObject(value, 'graph file');
  if (raw.schemaVersion !== ONTOLOGY_GRAPH_SCHEMA_VERSION) throw new Error('unsupported ontology graph schema version');
  if (raw.ownerId !== userId) throw new Error('ontology graph owner mismatch');
  if (!Array.isArray(raw.categories) || raw.categories.length > MAX_CATEGORIES) throw new Error('invalid ontology categories');
  if (!Array.isArray(raw.entities) || raw.entities.length > MAX_ENTITIES) throw new Error('invalid ontology entities');
  if (!Array.isArray(raw.relations) || raw.relations.length > MAX_RELATIONS) throw new Error('invalid ontology relations');

  const categories = raw.categories.map(validateCategory);
  const categoryMap = new Map<string, OntologyCategory>([
    ...BUILTIN_ONTOLOGY_CATEGORIES.map((category) => [category.id, category] as const),
    ...categories.map((category) => [category.id, category] as const),
  ]);
  const categoryIds = new Set<string>();
  const categoryNames = new Set<string>(BUILTIN_ONTOLOGY_CATEGORIES.map((category) => (
    `${category.domain}\0${category.parentId || ''}\0${category.name.toLocaleLowerCase()}`
  )));
  for (const category of categories) {
    if (categoryIds.has(category.id)) throw new Error('duplicate ontology category id');
    categoryIds.add(category.id);
    const key = `${category.domain}\0${category.parentId || ''}\0${category.name.toLocaleLowerCase()}`;
    if (categoryNames.has(key)) throw new Error('duplicate ontology category name');
    categoryNames.add(key);
    if (category.parentId) {
      const parent = categoryMap.get(category.parentId);
      if (!parent || parent.domain !== category.domain) throw new Error('ontology parent category is unavailable');
      const visited = new Set<string>([category.id]);
      let current: OntologyCategory | undefined = parent;
      while (current) {
        if (visited.has(current.id)) throw new Error('ontology category cycle');
        visited.add(current.id);
        current = current.parentId ? categoryMap.get(current.parentId) : undefined;
      }
    }
  }

  const entities = raw.entities.map((entity) => validateEntity(entity, categoryMap));
  const entityIds = new Set<string>();
  for (const entity of entities) {
    if (entityIds.has(entity.id)) throw new Error('duplicate ontology entity id');
    entityIds.add(entity.id);
  }
  const relations = raw.relations.map(validateRelation);
  const relationIds = new Set<string>();
  const relationKeys = new Set<string>();
  for (const relation of relations) {
    if (relationIds.has(relation.id)) throw new Error('duplicate ontology relation id');
    relationIds.add(relation.id);
    for (const endpoint of [relation.subject, relation.object]) {
      if (endpoint.kind === 'entity' && !entityIds.has(endpoint.id)) throw new Error('ontology relation endpoint is unavailable');
    }
    const key = JSON.stringify([relation.subject, relation.predicate.toLocaleLowerCase(), relation.object]);
    if (relationKeys.has(key)) throw new Error('duplicate ontology relation');
    relationKeys.add(key);
  }

  return {
    schemaVersion: ONTOLOGY_GRAPH_SCHEMA_VERSION,
    ownerId: userId,
    categories,
    entities,
    relations,
  };
}

async function readGraphFile(userId: string): Promise<OntologyGraphFile> {
  if (!safeId(userId)) throw new Error('invalid user id');
  const file = userOntologyGraphFile(userId);
  let rawText: string;
  try {
    rawText = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return emptyFile(userId);
    throw error;
  }
  if (Buffer.byteLength(rawText, 'utf8') > MAX_GRAPH_BYTES) throw new Error('ontology graph file exceeds size limit');
  let parsed: unknown;
  try { parsed = JSON.parse(rawText) as unknown; }
  catch { throw new Error('malformed ontology graph file'); }
  return validateGraphFile(userId, parsed);
}

function snapshot(state: OntologyGraphFile): OntologyGraphSnapshot {
  return {
    schemaVersion: ONTOLOGY_GRAPH_SCHEMA_VERSION,
    categories: [...BUILTIN_ONTOLOGY_CATEGORIES, ...state.categories],
    entities: state.entities,
    relations: state.relations,
  };
}

async function mutateGraph<T>(
  userId: string,
  operation: 'write' | 'update' | 'remove',
  recordId: string | undefined,
  mutate: (state: OntologyGraphFile) => T,
): Promise<T> {
  if (!safeId(userId)) throw new Error('invalid user id');
  const file = userOntologyGraphFile(userId);
  return fileEditLock(file).runExclusive(async () => {
    const state = await readGraphFile(userId);
    const result = mutate(state);
    const normalized = validateGraphFile(userId, state);
    const serialized = JSON.stringify(normalized);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_GRAPH_BYTES) throw new Error('ontology graph file exceeds size limit');
    await writeJson(file, normalized);
    notifyCognitionWrite(userId, 'ontology-graph', operation, recordId);
    return result;
  });
}

function findCustomCategory(state: OntologyGraphFile, categoryId: string): OntologyCategory {
  const category = state.categories.find((item) => item.id === categoryId);
  if (!category) throw new Error('ontology category not found');
  return category;
}

function mergeCategoryFields(existing: OntologyField[], input: unknown): OntologyField[] {
  if (!Array.isArray(input) || input.length > MAX_FIELDS_PER_CATEGORY) throw new Error('invalid ontology category fields');
  const fieldsById = new Map(existing.map((field) => [field.id, field]));
  const fields = input.map((raw) => {
    const item = plainObject(raw, 'category field');
    const name = boundedText(item.name, 'field name', 80, true);
    const id = item.id == null || item.id === '' ? genId12() : requiredId(item.id, 'field id');
    const previous = fieldsById.get(id);
    if (item.id != null && item.id !== '' && !previous) throw new Error('invalid ontology field id');
    return {
      id,
      name,
      kind: item.kind === undefined ? (previous?.kind || 'text') : fieldKind(item.kind),
    } satisfies OntologyField;
  });
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const field of fields) {
    const nameKey = field.name.toLocaleLowerCase();
    if (ids.has(field.id) || names.has(nameKey)) throw new Error('duplicate ontology category field');
    ids.add(field.id);
    names.add(nameKey);
  }
  return fields;
}

function assertFieldsNotInUse(state: OntologyGraphFile, category: OntologyCategory, nextFields: OntologyField[]): void {
  const nextIds = new Set(nextFields.map((field) => field.id));
  const removed = new Set(category.fields.filter((field) => !nextIds.has(field.id)).map((field) => field.id));
  if (!removed.size) return;
  const used = state.entities.some((entity) => entity.categoryId === category.id
    && Object.keys(entity.properties).some((fieldId) => removed.has(fieldId)));
  if (used) throw new Error('ontology category field is used by entities');
}

function normalizeEntityProperties(value: unknown, category: OntologyCategory): Record<string, string> {
  return validateProperties(value || {}, category);
}

function normalizeEntitySources(value: unknown): OntologySourceRef[] {
  return validateSourceRefs(value);
}

function entityCategory(state: OntologyGraphFile, categoryId: string): OntologyCategory {
  const category = state.categories.find((item) => item.id === categoryId)
    || BUILTIN_CATEGORY_BY_ID.get(categoryId);
  if (!category) throw new Error('ontology category not found');
  return category;
}

function endpointFromInput(value: unknown): OntologyEndpoint {
  return validateEndpoint(value);
}

function assertRelationEndpoints(state: OntologyGraphFile, subject: OntologyEndpoint, object: OntologyEndpoint, allowArchived = false): void {
  const entities = new Map(state.entities.map((entity) => [entity.id, entity]));
  for (const endpoint of [subject, object]) {
    if (endpoint.kind !== 'entity') continue;
    const entity = entities.get(endpoint.id);
    if (!entity) throw new Error('ontology relation endpoint not found');
    if (!allowArchived && entity.status !== 'active') throw new Error('ontology relation endpoint is archived');
  }
  if (subject.kind === 'self' && object.kind === 'self') throw new Error('ontology self relation is not allowed');
  if (subject.kind === 'entity' && object.kind === 'entity' && subject.id === object.id) {
    throw new Error('ontology entity cannot relate to itself');
  }
}

function relationDuplicate(state: OntologyGraphFile, subject: OntologyEndpoint, predicate: string, object: OntologyEndpoint, ignoreId?: string): boolean {
  const key = JSON.stringify([subject, predicate.toLocaleLowerCase(), object]);
  return state.relations.some((relation) => relation.id !== ignoreId
    && JSON.stringify([relation.subject, relation.predicate.toLocaleLowerCase(), relation.object]) === key);
}

export async function readOntologyGraph(userId: string): Promise<OntologyGraphSnapshot> {
  return snapshot(await readGraphFile(userId));
}

export async function createOntologyCategory(userId: string, input: {
  domain?: unknown;
  name?: unknown;
  description?: unknown;
  parentId?: unknown;
  fields?: unknown;
}): Promise<OntologyCategory> {
  return mutateGraph(userId, 'write', undefined, (state) => {
    const domain = requireDomain(input.domain);
    const name = boundedText(input.name, 'category name', 80, true);
    const description = boundedText(input.description, 'category description', 500);
    const parentId = input.parentId == null || input.parentId === '' ? undefined : requiredId(input.parentId, 'parent category id');
    const all = [...BUILTIN_ONTOLOGY_CATEGORIES, ...state.categories];
    if (parentId && !all.some((category) => category.id === parentId && category.domain === domain)) {
      throw new Error('ontology parent category not found');
    }
    const nameKey = `${domain}\0${parentId || ''}\0${name.toLocaleLowerCase()}`;
    if (all.some((category) => `${category.domain}\0${category.parentId || ''}\0${category.name.toLocaleLowerCase()}` === nameKey)) {
      throw new Error('ontology category already exists');
    }
    const fields = mergeCategoryFields([], Array.isArray(input.fields)
      ? input.fields.map((field) => (typeof field === 'string' ? { name: field, kind: 'text' } : field))
      : []);
    const category: OntologyCategory = { id: genId12(), domain, name, description, ...(parentId ? { parentId } : {}), fields, builtIn: false };
    state.categories.push(category);
    return category;
  });
}

export async function updateOntologyCategory(userId: string, input: {
  categoryId?: unknown;
  name?: unknown;
  description?: unknown;
  parentId?: unknown;
  fields?: unknown;
}): Promise<OntologyCategory> {
  const categoryId = requiredId(input.categoryId, 'category id');
  return mutateGraph(userId, 'update', categoryId, (state) => {
    const category = findCustomCategory(state, categoryId);
    const name = input.name === undefined ? category.name : boundedText(input.name, 'category name', 80, true);
    const description = input.description === undefined ? category.description : boundedText(input.description, 'category description', 500);
    const parentId = input.parentId === undefined
      ? category.parentId
      : input.parentId == null || input.parentId === '' ? undefined : requiredId(input.parentId, 'parent category id');
    const all = [...BUILTIN_ONTOLOGY_CATEGORIES, ...state.categories.filter((item) => item.id !== categoryId)];
    if (parentId && !all.some((item) => item.id === parentId && item.domain === category.domain)) throw new Error('ontology parent category not found');
    const nameKey = `${category.domain}\0${parentId || ''}\0${name.toLocaleLowerCase()}`;
    if (all.some((item) => `${item.domain}\0${item.parentId || ''}\0${item.name.toLocaleLowerCase()}` === nameKey)) throw new Error('ontology category already exists');
    const fields = input.fields === undefined ? category.fields : mergeCategoryFields(category.fields, input.fields);
    assertFieldsNotInUse(state, category, fields);
    const next: OntologyCategory = { ...category, name, description, ...(parentId ? { parentId } : { parentId: undefined }), fields };
    state.categories[state.categories.findIndex((item) => item.id === categoryId)] = next;
    return next;
  });
}

export async function deleteOntologyCategory(userId: string, categoryIdValue: unknown): Promise<void> {
  const categoryId = requiredId(categoryIdValue, 'category id');
  await mutateGraph(userId, 'remove', categoryId, (state) => {
    findCustomCategory(state, categoryId);
    if (state.entities.some((entity) => entity.categoryId === categoryId)) throw new Error('ontology category contains entities');
    if (state.categories.some((category) => category.parentId === categoryId)) throw new Error('ontology category contains child categories');
    state.categories = state.categories.filter((category) => category.id !== categoryId);
  });
}

export async function createOntologyEntity(userId: string, input: {
  categoryId?: unknown;
  name?: unknown;
  description?: unknown;
  properties?: unknown;
  sourceRefs?: unknown;
}): Promise<OntologyEntity> {
  return mutateGraph(userId, 'write', undefined, (state) => {
    const categoryId = requiredId(input.categoryId, 'entity category id');
    const category = entityCategory(state, categoryId);
    const timestamp = nowIso();
    const entity: OntologyEntity = {
      id: genId12(),
      domain: category.domain,
      categoryId,
      name: boundedText(input.name, 'entity name', 120, true),
      description: boundedText(input.description, 'entity description', 4_000),
      properties: normalizeEntityProperties(input.properties, category),
      sourceRefs: normalizeEntitySources(input.sourceRefs),
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.entities.push(entity);
    return entity;
  });
}

export async function updateOntologyEntity(userId: string, input: {
  entityId?: unknown;
  name?: unknown;
  description?: unknown;
  properties?: unknown;
  sourceRefs?: unknown;
  status?: unknown;
}): Promise<OntologyEntity> {
  const entityId = requiredId(input.entityId, 'entity id');
  return mutateGraph(userId, 'update', entityId, (state) => {
    const index = state.entities.findIndex((entity) => entity.id === entityId);
    if (index < 0) throw new Error('ontology entity not found');
    const current = state.entities[index];
    const category = entityCategory(state, current.categoryId);
    const status = input.status === undefined ? current.status : input.status;
    if (status !== 'active' && status !== 'archived') throw new Error('invalid ontology entity status');
    const updated: OntologyEntity = {
      ...current,
      name: input.name === undefined ? current.name : boundedText(input.name, 'entity name', 120, true),
      description: input.description === undefined ? current.description : boundedText(input.description, 'entity description', 4_000),
      properties: input.properties === undefined ? current.properties : normalizeEntityProperties(input.properties, category),
      sourceRefs: input.sourceRefs === undefined ? current.sourceRefs : normalizeEntitySources(input.sourceRefs),
      status,
      updatedAt: nowIso(),
    };
    state.entities[index] = updated;
    return updated;
  });
}

export async function deleteOntologyEntity(userId: string, entityIdValue: unknown): Promise<void> {
  const entityId = requiredId(entityIdValue, 'entity id');
  await mutateGraph(userId, 'remove', entityId, (state) => {
    if (!state.entities.some((entity) => entity.id === entityId)) throw new Error('ontology entity not found');
    if (state.relations.some((relation) => (
      (relation.subject.kind === 'entity' && relation.subject.id === entityId)
      || (relation.object.kind === 'entity' && relation.object.id === entityId)
    ))) throw new Error('ontology entity has relationships');
    state.entities = state.entities.filter((entity) => entity.id !== entityId);
  });
}

export async function createOntologyRelation(userId: string, input: {
  subject?: unknown;
  predicate?: unknown;
  object?: unknown;
  note?: unknown;
  sourceRefs?: unknown;
}): Promise<OntologyRelation> {
  return mutateGraph(userId, 'write', undefined, (state) => {
    const subject = endpointFromInput(input.subject);
    const object = endpointFromInput(input.object);
    assertRelationEndpoints(state, subject, object);
    const predicate = boundedText(input.predicate, 'relation name', 100, true);
    if (relationDuplicate(state, subject, predicate, object)) throw new Error('ontology relation already exists');
    const timestamp = nowIso();
    const relation: OntologyRelation = {
      id: genId12(), subject, predicate, object,
      note: boundedText(input.note, 'relation note', 1_000),
      sourceRefs: validateSourceRefs(input.sourceRefs),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.relations.push(relation);
    return relation;
  });
}

export async function updateOntologyRelation(userId: string, input: {
  relationId?: unknown;
  subject?: unknown;
  predicate?: unknown;
  object?: unknown;
  note?: unknown;
  sourceRefs?: unknown;
}): Promise<OntologyRelation> {
  const relationId = requiredId(input.relationId, 'relation id');
  return mutateGraph(userId, 'update', relationId, (state) => {
    const index = state.relations.findIndex((relation) => relation.id === relationId);
    if (index < 0) throw new Error('ontology relation not found');
    const current = state.relations[index];
    const subject = input.subject === undefined ? current.subject : endpointFromInput(input.subject);
    const object = input.object === undefined ? current.object : endpointFromInput(input.object);
    assertRelationEndpoints(state, subject, object, true);
    const predicate = input.predicate === undefined ? current.predicate : boundedText(input.predicate, 'relation name', 100, true);
    if (relationDuplicate(state, subject, predicate, object, relationId)) throw new Error('ontology relation already exists');
    const updated: OntologyRelation = {
      ...current, subject, object, predicate,
      note: input.note === undefined ? current.note : boundedText(input.note, 'relation note', 1_000),
      sourceRefs: input.sourceRefs === undefined ? current.sourceRefs : validateSourceRefs(input.sourceRefs),
      updatedAt: nowIso(),
    };
    state.relations[index] = updated;
    return updated;
  });
}

export async function deleteOntologyRelation(userId: string, relationIdValue: unknown): Promise<void> {
  const relationId = requiredId(relationIdValue, 'relation id');
  await mutateGraph(userId, 'remove', relationId, (state) => {
    if (!state.relations.some((relation) => relation.id === relationId)) throw new Error('ontology relation not found');
    state.relations = state.relations.filter((relation) => relation.id !== relationId);
  });
}

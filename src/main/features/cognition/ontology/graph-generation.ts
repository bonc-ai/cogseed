/** Model-assisted graph organization over the authoritative ontology projection.
 * The model chooses groups, labels and coordinates; it may not invent formal
 * nodes or edges. Suggestions are stored separately as pending review items. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createLogger } from '../../../logger';
import { prompts } from '../../../prompts/loader';
import { localCalendarDay } from './calendar-day';
import { readOntologyView } from './service';
import { queryOntologyGraph, type OntologyGraphProjection } from './query';
import { notifyCognitionWrite } from '../../recall/store-events';
import { resolveRecallCaptureModelCandidates } from '../../recall/capture-model-selection';
import { runRecallCaptureModel } from '../../recall/capture-model-routing';
import {
  beginGraphSnapshotGeneration,
  failGraphSnapshotGeneration,
  graphScopeKey,
  readGraphSnapshotEntry,
  saveGraphSnapshot,
  type OntologyGraphScope,
  type OntologyGraphSnapshot,
  type OntologyGraphSnapshotEdge,
  type OntologyGraphSnapshotEntry,
  type OntologyGraphSnapshotNode,
  type OntologyGraphSuggestion,
} from './graph-snapshot';
import type { OntologyDocument } from './model';

const log = createLogger('cognition.graph-generation');
const PROMPT_VERSION = 'v1';
const MODEL_NODE_LIMIT = 80;
const MODEL_EDGE_LIMIT = 160;

const layoutSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1).max(160),
    x: z.number().finite(),
    y: z.number().finite(),
    group: z.string().trim().max(80).optional(),
    label: z.string().trim().min(1).max(200).optional(),
  }).strict()).max(220),
  edges: z.array(z.object({
    id: z.string().min(1).max(160),
    group: z.string().trim().max(80).optional(),
    label: z.string().trim().min(1).max(200).optional(),
  }).strict()).max(500),
  suggestedEdges: z.array(z.object({
    from: z.string().min(1).max(160),
    to: z.string().min(1).max(160),
    label: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(1000),
  }).strict()).max(20).optional(),
}).strict();

export interface GraphLayoutOutput {
  nodes: Array<{ id: string; x: number; y: number; group?: string; label?: string }>;
  edges: Array<{ id: string; group?: string; label?: string }>;
  suggestedEdges: Array<{ from: string; to: string; label: string; reason: string }>;
}

export interface GraphLayoutInput {
  userId: string;
  scope: OntologyGraphScope;
  at: string;
  contentScale: 'schema' | 'instances';
  ontologyRevision: number;
  projection: OntologyGraphProjection;
  signal?: AbortSignal;
}

export interface GraphLayoutGenerator {
  generate(input: GraphLayoutInput): Promise<{ layout: GraphLayoutOutput; provider?: string; model?: string }>;
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse((fenced?.[1] || text).trim());
}

function selectModelSubgraph(projection: OntologyGraphProjection): { nodes: OntologyGraphProjection['nodes']; edges: OntologyGraphProjection['edges'] } {
  if (projection.nodes.length <= MODEL_NODE_LIMIT) return { nodes: projection.nodes, edges: projection.edges.slice(0, MODEL_EDGE_LIMIT) };
  const degree = new Map<string, number>();
  for (const edge of projection.edges) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const nodes = [...projection.nodes].sort((left, right) => (
    (degree.get(right.id) || 0) - (degree.get(left.id) || 0) || left.id.localeCompare(right.id)
  )).slice(0, MODEL_NODE_LIMIT);
  const ids = new Set(nodes.map(node => node.id));
  const edges = projection.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).slice(0, MODEL_EDGE_LIMIT);
  return { nodes, edges };
}

export const modelGraphLayoutGenerator: GraphLayoutGenerator = {
  async generate(input) {
    const candidates = await resolveRecallCaptureModelCandidates(input.userId, []);
    const subgraph = selectModelSubgraph(input.projection);
    const systemPrompt = prompts.load('cognition_graph_layout');
    const message = JSON.stringify({
      scope: input.scope.kind,
      ...(input.scope.kind === 'module' ? { moduleId: input.scope.moduleId } : {}),
      at: input.at,
      ontologyRevision: input.ontologyRevision,
      nodes: subgraph.nodes.map(({ id, kind, label, moduleId, description }) => ({
        id, kind, label, ...(moduleId ? { moduleId } : {}), ...(description ? { description } : {}),
      })),
      edges: subgraph.edges.map(({ id, from, to, label, kind, recordId }) => ({
        id, from, to, label, kind, ...(recordId ? { recordId } : {}),
      })),
    });
    const response = await runRecallCaptureModel(input.userId, {
      sessionId: `ontology-graph-${graphScopeKey(input.scope).replace(/[^A-Za-z0-9_-]/g, '-')}-${input.ontologyRevision}`,
      systemPrompt,
      message,
      modelCandidates: candidates,
      ...(input.signal ? { signal: input.signal } : {}),
      responseFormat: 'json_object',
      maxOutputTokens: 8_000,
    });
    if (response.result.meta.error) throw response.result.meta.error;
    if (!response.result.text?.trim()) throw new Error('graph layout model returned no output');
    const parsed = layoutSchema.safeParse(parseJson(response.result.text));
    if (!parsed.success) throw new Error(`invalid graph layout: ${parsed.error.issues.slice(0, 4).map(issue => issue.path.join('.')).join(', ')}`);
    return {
      layout: {
        nodes: parsed.data.nodes.map(node => ({
          id: String(node.id),
          x: Math.max(-2_000, Math.min(2_000, node.x)),
          y: Math.max(-2_000, Math.min(2_000, node.y)),
          ...(node.group ? { group: node.group } : {}),
          ...(node.label ? { label: node.label } : {}),
        })),
        edges: parsed.data.edges.map(edge => ({
          id: String(edge.id),
          ...(edge.group ? { group: edge.group } : {}),
          ...(edge.label ? { label: edge.label } : {}),
        })),
        suggestedEdges: (parsed.data.suggestedEdges || []).map(suggestion => ({
          from: String(suggestion.from),
          to: String(suggestion.to),
          label: String(suggestion.label),
          reason: String(suggestion.reason),
        })),
      },
      ...(response.chosen ? { provider: response.chosen.provider, model: response.chosen.model } : {}),
    };
  },
};

function fallbackPosition(index: number, total: number): { x: number; y: number } {
  const angle = index * 2.399963229728653;
  const radius = 220 + Math.sqrt(Math.max(1, total)) * 90;
  return { x: Math.cos(angle) * radius * 1.45, y: Math.sin(angle) * radius * 0.82 };
}

function suggestionId(from: string, to: string, label: string): string {
  return `graph-suggestion-${createHash('sha256').update(`${from}\0${to}\0${label}`).digest('hex').slice(0, 20)}`;
}

export function buildGraphSnapshot(input: {
  userId: string;
  scope: OntologyGraphScope;
  doc: OntologyDocument;
  projection: OntologyGraphProjection;
  at: string;
  contentScale: 'schema' | 'instances';
  layout: GraphLayoutOutput;
  provider?: string;
  model?: string;
}): OntologyGraphSnapshot {
  const modelNodes = new Map(input.layout.nodes.map(node => [node.id, node]));
  const modelEdges = new Map(input.layout.edges.map(edge => [edge.id, edge]));
  const nodes: OntologyGraphSnapshotNode[] = input.projection.nodes.map((node, index) => {
    const recordId = node.id.startsWith('literal-') ? node.id.slice('literal-'.length) : node.id;
    const record = input.doc.records[recordId];
    if (!record) throw new Error(`graph node has no ontology record: ${node.id}`);
    const modelNode = modelNodes.get(node.id);
    const fallback = fallbackPosition(index, input.projection.nodes.length);
    return {
      id: node.id,
      recordId,
      version: node.version ?? record.version,
      label: modelNode?.label || node.label,
      kind: node.kind,
      ...(node.moduleId ? { moduleId: node.moduleId } : {}),
      ...(modelNode?.group ? { group: modelNode.group } : {}),
      x: modelNode?.x ?? fallback.x,
      y: modelNode?.y ?? fallback.y,
      source: record.source,
    };
  });
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges: OntologyGraphSnapshotEdge[] = input.projection.edges.map(edge => {
    if (!edge.recordId) throw new Error(`graph edge has no ontology record: ${edge.id}`);
    const record = input.doc.records[edge.recordId];
    if (!record) throw new Error(`graph edge record missing: ${edge.recordId}`);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new Error(`graph edge endpoint missing: ${edge.id}`);
    const modelEdge = modelEdges.get(edge.id);
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: modelEdge?.label || edge.label,
      kind: edge.kind,
      recordId: edge.recordId,
      version: edge.version ?? record.version,
      formal: true,
      ...(modelEdge?.group ? { group: modelEdge.group } : {}),
      source: record.source,
      ...(edge.validity ? { validity: edge.validity } : {}),
    };
  });
  const existingFormal = new Set(edges.map(edge => `${edge.from}\0${edge.to}\0${edge.label}`));
  const seenSuggestions = new Set<string>();
  const suggestions: OntologyGraphSuggestion[] = [];
  for (const suggestion of input.layout.suggestedEdges) {
    if (!nodeIds.has(suggestion.from) || !nodeIds.has(suggestion.to) || suggestion.from === suggestion.to) continue;
    const key = `${suggestion.from}\0${suggestion.to}\0${suggestion.label}`;
    if (existingFormal.has(key) || seenSuggestions.has(key)) continue;
    seenSuggestions.add(key);
    suggestions.push({
      id: suggestionId(suggestion.from, suggestion.to, suggestion.label),
      from: suggestion.from,
      to: suggestion.to,
      label: suggestion.label,
      reason: suggestion.reason,
      status: 'pending_review',
    });
  }
  const checkedRecordVersions: Record<string, number> = {};
  for (const node of nodes) checkedRecordVersions[node.recordId] = node.version;
  for (const edge of edges) checkedRecordVersions[edge.recordId] = edge.version;
  return {
    schemaVersion: 1,
    ownerId: input.userId,
    scope: input.scope.kind,
    ...(input.scope.kind === 'module' ? { moduleId: input.scope.moduleId } : {}),
    ontologyRevision: input.doc.revision,
    at: input.at,
    contentScale: input.contentScale,
    nodes,
    edges,
    suggestions,
    generatedAt: new Date().toISOString(),
    generator: { kind: 'model', ...(input.provider ? { provider: input.provider } : {}), ...(input.model ? { model: input.model } : {}), promptVersion: PROMPT_VERSION },
    validation: { valid: true, checkedRecordVersions },
  };
}

export interface GraphGenerationRequest {
  userId: string;
  scope: OntologyGraphScope;
  at?: string;
  contentScale?: 'schema' | 'instances';
  signal?: AbortSignal;
  generator?: GraphLayoutGenerator;
}

const inFlight = new Map<string, Promise<OntologyGraphSnapshotEntry>>();

/** Dedup covers the requested output shape. Revision is deliberately absent:
 * an in-flight generation reconciles to the current revision through its own
 * re-read-and-retry loop, and the commit hook that schedules a fresh
 * generation joins the same promise instead of stacking a second model run. */
function generationKey(request: GraphGenerationRequest): string {
  const at = request.at || localCalendarDay();
  return `${request.userId}\0${graphScopeKey(request.scope)}\0${request.contentScale || 'instances'}\0${at}`;
}

export function requestGraphGeneration(request: GraphGenerationRequest): Promise<OntologyGraphSnapshotEntry> {
  const key = generationKey(request);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = (async () => {
    const at = request.at || localCalendarDay();
    const contentScale = request.contentScale || 'instances';
    let lastError = 'graph generation failed';
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const doc = await readOntologyView(request.userId);
        await beginGraphSnapshotGeneration(request.userId, request.scope, doc.revision);
        notifyCognitionWrite(request.userId, 'ontology-graph', 'update', graphScopeKey(request.scope));
        const projection = queryOntologyGraph(doc, {
          ...(request.scope.kind === 'module' ? { moduleId: request.scope.moduleId, at } : {}),
          contentScale,
        });
        const layout = await (request.generator || modelGraphLayoutGenerator).generate({
          userId: request.userId,
          scope: request.scope,
          at,
          contentScale,
          ontologyRevision: doc.revision,
          projection,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        const latest = await readOntologyView(request.userId);
        if (latest.revision !== doc.revision) {
          lastError = 'ontology changed during graph generation';
          continue;
        }
        const snapshot = buildGraphSnapshot({
          userId: request.userId,
          scope: request.scope,
          doc,
          projection,
          at,
          contentScale,
          layout: layout.layout,
          ...(layout.provider ? { provider: layout.provider } : {}),
          ...(layout.model ? { model: layout.model } : {}),
        });
        const entry = await saveGraphSnapshot(request.userId, snapshot);
        notifyCognitionWrite(request.userId, 'ontology-graph', 'update', graphScopeKey(request.scope));
        return entry;
      }
      throw new Error(lastError);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Failure-path bookkeeping is best-effort: a corrupt snapshot store makes
      // fail-marking and the fallback read throw too, but this function must
      // resolve to an entry — the commit hook invokes it fire-and-forget and
      // cannot absorb a rejection.
      try {
        await failGraphSnapshotGeneration(request.userId, request.scope,
          (await readOntologyView(request.userId).catch(() => ({ revision: 0 }))).revision, lastError);
        notifyCognitionWrite(request.userId, 'ontology-graph', 'update', graphScopeKey(request.scope));
      } catch { /* the failed entry below still records the generation error */ }
      log.warn('ontology graph generation failed', { scope: graphScopeKey(request.scope), error: lastError });
      const fallback = await readGraphSnapshotEntry(request.userId, request.scope).catch(() => null);
      return fallback || {
        status: 'failed', ontologyRevision: 0, updatedAt: new Date().toISOString(), error: lastError,
      };
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/** Called after an ontology commit. The test environment opts out so fixture
 * commits never trigger real model calls; product runs generate in the background. */
export async function scheduleGraphGenerationForOntologyChange(
  userId: string,
  changedIds: readonly string[],
  _revision: number,
): Promise<void> {
  if (process.env.NODE_ENV === 'test' && process.env.COGSEED_GRAPH_GENERATION_IN_TEST !== '1') return;
  const doc = await readOntologyView(userId);
  const moduleIds = new Set<string>();
  for (const id of changedIds) {
    const record = doc.records[id];
    if (!record) continue;
    const moduleId = record.kind === 'module' ? record.id : record.moduleId;
    if (moduleId) moduleIds.add(moduleId);
    if (record.kind === 'reference') moduleIds.add(record.targetModuleId);
  }
  const scopes: OntologyGraphScope[] = [{ kind: 'global' }, ...[...moduleIds].map(moduleId => ({ kind: 'module' as const, moduleId }))];
  for (const scope of scopes) {
    void requestGraphGeneration({ userId, scope, at: localCalendarDay(), contentScale: 'instances' });
  }
}

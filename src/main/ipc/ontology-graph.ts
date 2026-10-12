import * as ontologyGraph from '../features/ontology_graph';

type IpcContext = { userId: string };
type Payload = Record<string, unknown>;

function asPayload(value: unknown): Payload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Payload;
}

export const invokeHandlers = {
  'ontology.graph.read': async (_payload: unknown, ctx: IpcContext) => ({
    graph: await ontologyGraph.readOntologyGraph(ctx.userId),
  }),
  'ontology.category.create': async (payload: unknown, ctx: IpcContext) => ({
    category: await ontologyGraph.createOntologyCategory(ctx.userId, asPayload(payload)),
  }),
  'ontology.category.update': async (payload: unknown, ctx: IpcContext) => ({
    category: await ontologyGraph.updateOntologyCategory(ctx.userId, asPayload(payload)),
  }),
  'ontology.category.delete': async (payload: unknown, ctx: IpcContext) => {
    await ontologyGraph.deleteOntologyCategory(ctx.userId, asPayload(payload).categoryId);
    return { ok: true };
  },
  'ontology.entity.create': async (payload: unknown, ctx: IpcContext) => ({
    entity: await ontologyGraph.createOntologyEntity(ctx.userId, asPayload(payload)),
  }),
  'ontology.entity.update': async (payload: unknown, ctx: IpcContext) => ({
    entity: await ontologyGraph.updateOntologyEntity(ctx.userId, asPayload(payload)),
  }),
  'ontology.entity.delete': async (payload: unknown, ctx: IpcContext) => {
    await ontologyGraph.deleteOntologyEntity(ctx.userId, asPayload(payload).entityId);
    return { ok: true };
  },
  'ontology.relation.create': async (payload: unknown, ctx: IpcContext) => ({
    relation: await ontologyGraph.createOntologyRelation(ctx.userId, asPayload(payload)),
  }),
  'ontology.relation.update': async (payload: unknown, ctx: IpcContext) => ({
    relation: await ontologyGraph.updateOntologyRelation(ctx.userId, asPayload(payload)),
  }),
  'ontology.relation.delete': async (payload: unknown, ctx: IpcContext) => {
    await ontologyGraph.deleteOntologyRelation(ctx.userId, asPayload(payload).relationId);
    return { ok: true };
  },
};

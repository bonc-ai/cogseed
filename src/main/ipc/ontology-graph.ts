import * as ontologyGraph from '../features/ontology_graph';
import { OntologyError } from '../features/cognition/ontology/model';

type IpcContext = { userId: string };
function rejectLegacyGraphWrite(): never {
  throw new OntologyError('legacy_write_disabled', '旧图谱写入入口已停用。请在本体工作台通过共同治理入口整理或提交候选。');
}

export const invokeHandlers = {
  'ontology.graph.read': async (_payload: unknown, ctx: IpcContext) => ({
    graph: await ontologyGraph.readOntologyGraph(ctx.userId),
  }),
  'ontology.category.create': async () => rejectLegacyGraphWrite(),
  'ontology.category.update': async () => rejectLegacyGraphWrite(),
  'ontology.category.delete': async () => rejectLegacyGraphWrite(),
  'ontology.entity.create': async () => rejectLegacyGraphWrite(),
  'ontology.entity.update': async () => rejectLegacyGraphWrite(),
  'ontology.entity.delete': async () => rejectLegacyGraphWrite(),
  'ontology.relation.create': async () => rejectLegacyGraphWrite(),
  'ontology.relation.update': async () => rejectLegacyGraphWrite(),
  'ontology.relation.delete': async () => rejectLegacyGraphWrite(),
};

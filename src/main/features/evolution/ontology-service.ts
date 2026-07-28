import * as path from 'node:path';
import { loadEngine } from './engine-loader';
import { buildLlmComplete } from './llm-bridge';

function workspaceRoot(): string {
  const root = process.env.ORKAS_WORKSPACE_ROOT || '';
  if (!root) throw new Error('ORKAS_WORKSPACE_ROOT not set');
  return root;
}
function skillOntologyDir(uid: string, skillId: string): string {
  return path.join(workspaceRoot(), uid, 'cloud', 'skills', skillId, 'ontology');
}

interface OntoSlice { tbox: unknown[]; rbox: unknown[]; abox: unknown[]; }

export async function extractAndSaveOntology(
  uid: string, skillId: string, text: string, agentId = '',
): Promise<{ slice: OntoSlice; degraded: boolean }> {
  const engine = await loadEngine();
  const Writer = engine.OntologyWriter as new (dir: string) => {
    extractOntologyFromText: (t: string, llm?: unknown) => Promise<{ slice: OntoSlice; degraded: boolean }>;
    writeOntology: (id: string, slice: OntoSlice) => Promise<void>;
  };
  const writer = new Writer(skillOntologyDir(uid, skillId));
  const llm = buildLlmComplete({ userId: uid, agentId });
  const result = await writer.extractOntologyFromText(text, llm);
  if (!result.degraded) {
    await writer.writeOntology(skillId, result.slice);
  }
  return result;
}

export async function listSkillOntologies(uid: string, skillId: string): Promise<unknown[]> {
  const engine = await loadEngine();
  const Reader = engine.OntologyReader as new (dir: string) => { listOntologies: () => Promise<unknown[]> };
  const reader = new Reader(skillOntologyDir(uid, skillId));
  try { return await reader.listOntologies(); } catch { return []; }
}

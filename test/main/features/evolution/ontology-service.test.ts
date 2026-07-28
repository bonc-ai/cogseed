import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractAndSaveOntology, listSkillOntologies,
} from '../../../../src/main/features/evolution/ontology-service';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onto-svc-'));
  process.env.ORKAS_WORKSPACE_ROOT = dir;
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); delete process.env.ORKAS_WORKSPACE_ROOT; });

vi.mock('../../../../src/main/features/evolution/engine-loader', () => {
  class FakeWriter {
    constructor(private d: string) {}
    async extractOntologyFromText(_t: string, llm?: any) {
      if (!llm) return { slice: { tbox: [], rbox: [], abox: [] }, degraded: true };
      return { slice: { tbox: [{ id: 'Invoice', label: '发票', description: '', class_kind: 'entity', grain: 'instance' }], rbox: [], abox: [] }, degraded: false };
    }
    async writeOntology(id: string, slice: any) {
      await fs.mkdir(this.d, { recursive: true });
      await fs.writeFile(path.join(this.d, `${id}.json`), JSON.stringify(slice), 'utf-8');
    }
  }
  class FakeReader { constructor(private d: string) {} async listOntologies() { return []; } }
  return { loadEngine: async () => ({ OntologyWriter: FakeWriter, OntologyReader: FakeReader }) };
});
vi.mock('../../../../src/main/features/evolution/llm-bridge', () => ({
  buildLlmComplete: () => async () => ({ text: '{}', degraded: false }),
}));

describe('ontology-service', () => {
  it('extractAndSaveOntology 有 llm 时抽出 TBox 并写入 cloud/skills/<id>/ontology', async () => {
    const r = await extractAndSaveOntology('u1', 'sk1', '公司报销需要发票');
    expect(r.degraded).toBe(false);
    expect(r.slice.tbox[0].id).toBe('Invoice');
    const ontoDir = path.join(dir, 'u1', 'cloud', 'skills', 'sk1', 'ontology');
    const files = await fs.readdir(ontoDir);
    expect(files.length).toBeGreaterThan(0);
  });

  it('listSkillOntologies 委托引擎 Reader', async () => {
    const list = await listSkillOntologies('u1', 'sk1');
    expect(Array.isArray(list)).toBe(true);
  });
});

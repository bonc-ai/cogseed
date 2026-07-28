import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OntologyWriter } from '../src/modules/ontology-writer';
import type { LlmComplete } from '../src/modules/llm-port';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onto-x-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const mockLlm: LlmComplete = async () => ({
  text: JSON.stringify({
    tbox: [{ id: 'Invoice', label: '发票', description: '', class_kind: 'entity', grain: 'instance' }],
    rbox: [], abox: [],
  }),
  degraded: false,
});

describe('OntologyWriter.extractOntologyFromText', () => {
  it('有 llm 时解析 JSON 得到 TBox', async () => {
    const w = new OntologyWriter(dir);
    const r = await w.extractOntologyFromText('公司报销需要发票', mockLlm);
    expect(r.degraded).toBe(false);
    expect(r.slice.tbox[0].id).toBe('Invoice');
  });

  it('无 llm 时返回空 slice 且标记降级', async () => {
    const w = new OntologyWriter(dir);
    const r = await w.extractOntologyFromText('任意文本');
    expect(r.degraded).toBe(true);
    expect(r.slice.tbox).toEqual([]);
  });
});

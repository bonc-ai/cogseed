import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { OntologyReader } from './ontology-reader.js';
import type { LlmComplete } from './llm-port.js';
import type { OntologyClass, OntologyRule, OntologyExample, OntologySlice } from '../types/index.js';

/**
 * 本体写入器：把 TBox/RBox/ABox 落成 OntologyReader 能回读的 YAML。
 * 与 Reader 的文件名约定和 YAML 形状严格对齐，保证写读闭环。
 */
export class OntologyWriter {
  constructor(private ontologyDir: string) {}

  private dirFor(id: string): string { return path.join(this.ontologyDir, id); }

  async writeOntology(
    id: string,
    slice: { tbox: OntologyClass[]; rbox: OntologyRule[]; abox: OntologyExample[] },
  ): Promise<void> {
    const dir = this.dirFor(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'tbox.yaml'), yaml.stringify({ classes: slice.tbox }), 'utf-8');
    await fs.writeFile(path.join(dir, 'rbox.yaml'), yaml.stringify({ rbox: { rules: slice.rbox } }), 'utf-8');
    await fs.writeFile(path.join(dir, 'abox.yaml'), yaml.stringify({ abox: { case_examples: slice.abox } }), 'utf-8');
  }

  private async readSlice(id: string): Promise<OntologySlice> {
    const reader = new OntologyReader(this.ontologyDir);
    try {
      const { slice } = await reader.loadOntology(id);
      return slice;
    } catch {
      return { tbox: [], rbox: [], abox: [] };
    }
  }

  async upsertClass(id: string, cls: OntologyClass): Promise<void> {
    const slice = await this.readSlice(id);
    const tbox = slice.tbox.filter(c => c.id !== cls.id);
    tbox.push(cls);
    await this.writeOntology(id, { tbox, rbox: slice.rbox, abox: slice.abox });
  }

  async upsertRule(id: string, rule: OntologyRule): Promise<void> {
    const slice = await this.readSlice(id);
    const rbox = slice.rbox.filter(r => r.id !== rule.id);
    rbox.push(rule);
    await this.writeOntology(id, { tbox: slice.tbox, rbox, abox: slice.abox });
  }

  async upsertExample(id: string, ex: OntologyExample): Promise<void> {
    const slice = await this.readSlice(id);
    const abox = slice.abox.filter(e => e.id !== ex.id);
    abox.push(ex);
    await this.writeOntology(id, { tbox: slice.tbox, rbox: slice.rbox, abox });
  }

  /**
   * 从自由文本 LLM 抽取本体（TBox/RBox/ABox）。
   * 无 llm 或解析失败时返回空 slice + degraded:true，绝不凭空造本体。
   */
  async extractOntologyFromText(
    text: string,
    llm?: LlmComplete,
  ): Promise<{ slice: OntologySlice; degraded: boolean }> {
    const empty: OntologySlice = { tbox: [], rbox: [], abox: [] };
    if (!llm) return { slice: empty, degraded: true };

    const prompt = [
      '从下述文本抽取领域本体，只输出 JSON，字段 tbox/rbox/abox。',
      'tbox 每项 {id,label,description,class_kind,grain}；',
      'rbox 每项 {id,type,name,description,applies_to:{classes:[]},condition:{when},action:{type,instruction},severity,confidence}；',
      'abox 每项 {id,type,user_query,expected_understanding,expected_behavior:{status,explanation}}。',
      '文本：',
      text.slice(0, 4000),
    ].join('\n');

    const { text: out, degraded } = await llm(prompt);
    if (degraded) return { slice: empty, degraded: true };
    try {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return { slice: empty, degraded: true };
      const parsed = JSON.parse(m[0]);
      return {
        slice: {
          tbox: Array.isArray(parsed.tbox) ? parsed.tbox : [],
          rbox: Array.isArray(parsed.rbox) ? parsed.rbox : [],
          abox: Array.isArray(parsed.abox) ? parsed.abox : [],
        },
        degraded: false,
      };
    } catch {
      return { slice: empty, degraded: true };
    }
  }
}

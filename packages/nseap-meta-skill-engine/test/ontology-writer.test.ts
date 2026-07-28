import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { OntologyWriter } from '../src/modules/ontology-writer';
import { OntologyReader } from '../src/modules/ontology-reader';
import type { OntologyClass, OntologyRule } from '../src/types/index.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'onto-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const tbox: OntologyClass[] = [{ id: 'AcademicPaper', label: '学术论文', description: '一篇论文', class_kind: 'entity', grain: 'instance' }];
const rbox: OntologyRule[] = [{ id: 'R1', type: 'validation', name: '查重门槛', description: '', applies_to: { classes: ['AcademicPaper'] }, condition: { when: 'similarity>0.3' }, action: { type: 'block', instruction: '拒绝' }, severity: 'blocking', confidence: 0.9 }];

describe('OntologyWriter', () => {
  it('写入的本体能被 OntologyReader 原样回读', async () => {
    const w = new OntologyWriter(dir);
    await w.writeOntology('paper', { tbox, rbox, abox: [] });
    const reader = new OntologyReader(dir);
    const { slice } = await reader.loadOntology('paper');
    expect(slice.tbox[0].id).toBe('AcademicPaper');
    expect(slice.rbox[0].id).toBe('R1');
    expect(slice.rbox[0].severity).toBe('blocking');
  });

  it('upsertClass 合并进已存在的 TBox 而非覆盖', async () => {
    const w = new OntologyWriter(dir);
    await w.writeOntology('paper', { tbox, rbox: [], abox: [] });
    await w.upsertClass('paper', { id: 'CoursePaper', label: '课程论文', description: '', class_kind: 'entity', grain: 'instance', parent: 'AcademicPaper' });
    const reader = new OntologyReader(dir);
    const { slice } = await reader.loadOntology('paper');
    expect(slice.tbox.map(c => c.id).sort()).toEqual(['AcademicPaper', 'CoursePaper']);
  });
});

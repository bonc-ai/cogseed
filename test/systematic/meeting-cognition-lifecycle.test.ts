/** Existing ontology records remain readable and manually editable; conversation tools cannot form long-term cognition. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderCognition } from '../renderer/helpers/cognition-renderer';
let root: string, oldRoot: string | undefined;
const uid = 'system-meeting-user', cid = 'meeting-lifecycle';
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-meeting-system-')); oldRoot = process.env.COGSEED_WORKSPACE_ROOT; process.env.COGSEED_WORKSPACE_ROOT = root; vi.resetModules(); });
afterEach(() => { if (oldRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT; else process.env.COGSEED_WORKSPACE_ROOT = oldRoot; fs.rmSync(root, { recursive: true, force: true }); });
async function setup() {
 const { commitOntologyCommand, readOntologyView } = await import('../../src/main/features/cognition/ontology/service');
 const create=(recordId:string,record:any)=>({intent:'create',recordId,record,sourceLabel:'用户提供的会议材料'});
 const type=(name:string)=>({kind:'definition',moduleId:'meeting',name,description:'',definitionKind:'type',subjectTypes:[],objectTypes:[],valueType:'entity',cardinality:'many',cardinalityAnchor:'subject'});
 const attribute=(name:string)=>({...type(name),definitionKind:'attribute',subjectTypes:['meeting-type'],valueType:'text',cardinality:'one'});
 const entity=(name:string,typeId:string)=>({kind:'entity',moduleId:'meeting',name,typeId,description:'',aliases:[],identityStatus:'confirmed'});
 const fact=(definitionId:string,value:string)=>({kind:'assertion',moduleId:'meeting',subjectId:'meeting-series',definitionId,object:{kind:'literal',valueType:'text',value},validity:{from:'2026-10-09',until:null,precision:'day',timezone:'Asia/Shanghai'}});
 const actions=[create('meeting',{kind:'module',name:'9:30站会',description:'例行会议',scope:{kind:'personal'}}),create('meeting-type',type('会议')),create('product-type',type('产品')),create('frequency',attribute('频率')),create('procedure',attribute('procedure含义')),create('meeting-series',entity('9:30早会','meeting-type')),create('expense',entity('报销智能体','product-type')),create('frequency-fact',fact('frequency','每个工作日9:30')),create('unknown-fact',fact('procedure','未确认'))];

 await commitOntologyCommand(uid, { commandId: 'seed-existing-meeting', expectedRevision: 0, actions });
 const { createOntologyTools } = await import('../../src/main/model/core-agent/ontology-tools');
 const { createTranscriptMemoryTools } = await import('../../src/main/model/core-agent/transcript-memory-tools');
 return { commitOntologyCommand, readOntologyView, tools: createOntologyTools({ userId: uid }), correctionTools: createTranscriptMemoryTools({ userId: uid, cid }) };
}
const payload = (result: any) => JSON.parse(result.content);
describe('既有会议认知管理与对话只读边界', () => {
 it('本体页面与任务查询继续读取已保存记录，工具不再暴露即时保存入口', async () => {
  const s = await setup();
  expect(s.tools.map(t => t.name)).toEqual(['cognition_ontology_query']);
  expect(s.correctionTools.map(t => t.name)).toEqual(['transcript_corrections_query']);
  const snapshot = await s.readOntologyView(uid);
  expect(renderCognition({ name: 'ontology' }, { ontologySnapshot: snapshot })).toContain('ca-ontology-mount');
  expect(snapshot.records.meeting).toMatchObject({ name: '9:30站会' });
  const before = snapshot.revision;
  const read = payload(await s.tools[0].execute({ query: '9:30站会' }));
  expect(read.facts.some((f: any) => f.statement.includes('每个工作日9:30'))).toBe(true);
  expect((await s.readOntologyView(uid)).revision).toBe(before);
  expect(read).not.toHaveProperty('sourceMessages');
 });
 it('人工修改已有事实保留原记录、后继与历史，冷启动后可读', async () => {
  const s = await setup(); const doc = await s.readOntologyView(uid);
  await s.commitOntologyCommand(uid, { commandId: 'manual-correction', expectedRevision: doc.revision, actions: [
   { intent: 'correct', recordId: 'frequency-fact', expectedVersion: 1, object: { kind: 'literal', valueType: 'text', value: '每周一9:30' }, sourceLabel: '人工编辑已保存本体' },
  ] });
  const edited = await s.readOntologyView(uid);
  expect(edited.records['frequency-fact'].status).toBe('corrected');
  expect(edited.history.some(h => h.after.kind === 'assertion' && h.after.supersedesId === 'frequency-fact')).toBe(true);
  vi.resetModules(); const { readOntologyDocument } = await import('../../src/main/features/cognition/ontology/service');
  expect(readOntologyDocument(uid).records['frequency-fact'].status).toBe('corrected');
 });
 it('读取既有纠错词表不改变词表，当前材料应用不改变本体', async () => {
  const s = await setup();
  const { upsertEntry, loadGlossary } = await import('../../src/main/features/transcript_glossary');
  // Seed previously saved user data; the conversational tool only reads it.
  upsertEntry(uid, { wrong: '包智能体', correct: '报销智能体', source: 'manual', docId: `chat:${cid}` });
  const before = JSON.stringify(loadGlossary(uid));
  const result = payload(await s.correctionTools[0].execute({ moduleId: 'meeting' }));
  expect(result.entries).toHaveLength(1);
  expect(JSON.stringify(loadGlossary(uid))).toBe(before);
  const { scanText, applyCorrections } = await import('../../src/main/features/transcript_auto_correct');
  const text = '包智能体进展待讨论。';
  const scan = scanText(text, result.entries, { docId: `chat:${cid}` });
  expect(applyCorrections(text, scan.candidates, { acceptedIds: scan.candidates.map(c => c.entryRef) }).text).toBe('报销智能体进展待讨论。');
  expect((await s.readOntologyView(uid)).revision).toBe(1);
 });
});

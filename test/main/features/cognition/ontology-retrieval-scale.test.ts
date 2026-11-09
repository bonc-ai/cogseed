/** Deterministic large-scale ontology retrieval stress. Seeds a synthetic
 * multi-module ontology and measures recall, injection width, truncation and
 * latency through runOntologyTaskQuery, buildTaskOntologyContext and
 * queryOntologyGraph. Level 1 runs always as correctness invariants; larger
 * levels opt in with COGSEED_ONTOLOGY_SCALE_STRESS=1 and print metrics. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
let previousRoot: string | undefined;
const userId = 'ontology-retrieval-scale-user';
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '周', '吴', '徐'];

interface ScaleTask {
  kind: 'entity' | 'alias' | 'relation' | 'rule' | 'fat-first' | 'fat-last' | 'ambiguous' | 'flood' | 'none';
  taskText: string;
  query: string;
  purpose?: string;
  targetModuleId?: string;
  targetFactRecordId?: string;
  targetRuleRecordId?: string;
}

interface ScaleFixture {
  actions: Array<Record<string, unknown>>;
  tasks: ScaleTask[];
  recordCount: number;
}

function buildFixture(moduleCount: number): ScaleFixture {
  const actions: Array<Record<string, unknown>> = [];
  const referenceActions: Array<Record<string, unknown>> = [];
  const tasks: ScaleTask[] = [];
  const action = (recordId: string, record: Record<string, unknown>) => {
    actions.push({ intent: 'create', recordId, record, sourceLabel: '检索压测' });
  };
  const validity = { from: '2026-01-01', until: null, precision: 'day', timezone: 'Asia/Shanghai' } as const;
  const defineModule = (index: number, entityCount: number, fatTargets: boolean) => {
    const mid = `m${index}`;
    const entities: Array<{ id: string; name: string; aliases: string[] }> = [
      { id: `${mid}-shared-entity`, name: `共享平台账号${index}`, aliases: [] },
    ];
    for (let j = 0; j < entityCount; j += 1) {
      const eid = fatTargets && (j === 0 || j === entityCount - 1)
        ? (j === 0 ? `${mid}-fat-aa` : `${mid}-fat-zz`)
        : `${mid}-e${j}`;
      const holder = fatTargets && (j === 0 || j === entityCount - 1)
        ? (j === 0 ? `端首${index}` : `端尾${index}`)
        : `${SURNAMES[j % SURNAMES.length]}研${index}员${j}`;
      entities.push({ id: eid, name: holder, aliases: j % 3 === 1 ? [`花名${index}_${j}`] : [] });
    }
    action(mid, { kind: 'module', name: `领域${index}项目`, description: `第${index}个合成领域`, scope: { kind: 'personal' } });
    action(`${mid}-person-type`, { kind: 'definition', moduleId: mid, name: '人员', description: '', definitionKind: 'type', subjectTypes: [], objectTypes: [], valueType: 'entity', cardinality: 'many', cardinalityAnchor: 'subject' });
    action(`${mid}-owner-def`, { kind: 'definition', moduleId: mid, name: '负责人', description: '', definitionKind: 'relation', subjectTypes: [`${mid}-person-type`], objectTypes: [`${mid}-person-type`], valueType: 'entity', cardinality: 'one', cardinalityAnchor: 'subject' });
    action(`${mid}-score-def`, { kind: 'definition', moduleId: mid, name: '评分', description: '', definitionKind: 'attribute', subjectTypes: [`${mid}-person-type`], objectTypes: [], valueType: 'text', cardinality: 'one', cardinalityAnchor: 'subject' });
    for (const entity of entities) {
      action(entity.id, { kind: 'entity', moduleId: mid, typeId: `${mid}-person-type`, name: entity.name, description: '', aliases: entity.aliases, identityStatus: 'confirmed' });
    }
    for (let j = 0; j < entities.length; j += 1) {
      const subject = entities[j];
      const target = entities[(j + 1) % entities.length];
      action(`${mid}-own-${subject.id}`, { kind: 'assertion', moduleId: mid, subjectId: subject.id, definitionId: `${mid}-owner-def`, object: { kind: 'entity', id: target.id }, validity });
      if (j >= 1 && j <= 4) {
        action(`${mid}-score-${subject.id}`, { kind: 'assertion', moduleId: mid, subjectId: subject.id, definitionId: `${mid}-score-def`, object: { kind: 'literal', valueType: 'text', value: `压测评分${index}_${j}` }, validity });
      }
    }
    for (let r = 0; r < 3; r += 1) {
      action(`${mid}-rule-${r}`, {
        kind: 'rule', moduleId: mid, name: `周报规范${index}_${r}`, requirement: `周报需包含风险栏${index}_${r}`,
        strength: r === 0 ? 'required' : 'suggestion',
        condition: { kind: 'task', field: 'purpose', equals: 'weekly_report' },
        effect: r === 0 ? { kind: 'include_recipient', entityId: `${mid}-shared-entity` } : r === 1 ? { kind: 'choice', key: `choice_${index}`, value: 'a' } : { kind: 'note' },
        exception: '',
      });
    }
    if (index % 5 === 0 && index + 1 < moduleCount) {
      // References point at the next module, so they are appended after every module exists.
      referenceActions.push({ intent: 'create', recordId: `${mid}-ref-next`, record: { kind: 'reference', moduleId: mid, targetModuleId: `m${(index + 1) % moduleCount}`, versionPolicy: 'current' }, sourceLabel: '检索压测' });
    }
  };
  const smallScaleFat = moduleCount < 25 ? moduleCount - 1 : -1;
  for (let index = 0; index < moduleCount; index += 1) {
    const fat = index % 25 === 24 || index === smallScaleFat;
    defineModule(index, fat ? 80 : 8, fat);
  }
  // Ground-truth tasks, spread deterministically over the module range.
  const pick = (kind: ScaleTask['kind'], count: number, build: (index: number) => ScaleTask) => {
    for (let n = 0; n < count; n += 1) {
      const index = Math.floor(((n + 0.5) / count) * moduleCount) % moduleCount;
      if (index >= moduleCount) continue;
      tasks.push({ kind, ...build(index) });
    }
  };
  pick('entity', 20, index => ({
    kind: 'entity', taskText: `请整理刘研${index}员3本周的工作安排`, query: `刘研${index}员3`,
    targetModuleId: `m${index}`, targetFactRecordId: `m${index}-own-m${index}-e3`,
  }));
  pick('alias', 10, index => ({
    kind: 'alias', taskText: `联系花名${index}_1确认评审时间`, query: `花名${index}_1`,
    targetModuleId: `m${index}`, targetFactRecordId: `m${index}-own-m${index}-e1`,
  }));
  pick('relation', 10, index => ({
    kind: 'relation', taskText: `张研${index}员2的负责人是谁`, query: `张研${index}员2`,
    targetModuleId: `m${index}`, targetFactRecordId: `m${index}-own-m${index}-e2`,
  }));
  pick('rule', 10, index => ({
    kind: 'rule', taskText: `按周报规范${index}_0整理本周周报`, query: `周报规范${index}_0`, purpose: 'weekly_report',
    targetModuleId: `m${index}`, targetRuleRecordId: `m${index}-rule-0`,
  }));
  let fatIndex = Math.floor((moduleCount - 1) / 25) * 25 + 24;
  if (fatIndex >= moduleCount) fatIndex -= 25;
  if (fatIndex < 0) fatIndex = moduleCount - 1;
  tasks.push({ kind: 'fat-first', taskText: `端首${fatIndex}的负责人是谁`, query: `端首${fatIndex}`, targetModuleId: `m${fatIndex}`, targetFactRecordId: `m${fatIndex}-own-m${fatIndex}-fat-aa` });
  tasks.push({ kind: 'fat-last', taskText: `端尾${fatIndex}的负责人是谁`, query: `端尾${fatIndex}`, targetModuleId: `m${fatIndex}`, targetFactRecordId: `m${fatIndex}-own-m${fatIndex}-fat-zz` });
  if (moduleCount >= 5) {
    tasks.push({ kind: 'ambiguous', taskText: '重名联系人的负责人是谁', query: '重名联系人' });
    action('m3-dup-entity', { kind: 'entity', moduleId: 'm3', typeId: 'm3-person-type', name: '重名联系人', description: '', aliases: [], identityStatus: 'confirmed' });
    action('m3-dup-own', { kind: 'assertion', moduleId: 'm3', subjectId: 'm3-dup-entity', definitionId: 'm3-owner-def', object: { kind: 'entity', id: 'm3-e0' }, validity });
    action('m4-dup-entity', { kind: 'entity', moduleId: 'm4', typeId: 'm4-person-type', name: '重名联系人', description: '', aliases: [], identityStatus: 'confirmed' });
    action('m4-dup-own', { kind: 'assertion', moduleId: 'm4', subjectId: 'm4-dup-entity', definitionId: 'm4-owner-def', object: { kind: 'entity', id: 'm4-e0' }, validity });
  }
  tasks.push({ kind: 'flood', taskText: '共享平台账号的负责人是谁', query: '共享平台账号' });
  tasks.push({ kind: 'none', taskText: '量子纠缠与占星术的关系', query: '量子纠缠与占星术' });
  const allActions = [...actions, ...referenceActions];
  return { actions: allActions, tasks, recordCount: allActions.length };
}

interface CaseResult {
  kind: string;
  ms: number;
  ctxMs: number;
  moduleHit: boolean | null;
  factHit: boolean | null;
  ruleHit: boolean | null;
  factModules: number;
  truncatedFacts: number;
  truncatedRules: number;
  truncatedModules: number;
  searchTruncated: boolean;
  ctxCited: boolean | null;
  ctxModules: number;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

describe('ontology retrieval at scale', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-ontology-scale-'));
    previousRoot = process.env.COGSEED_WORKSPACE_ROOT;
    process.env.COGSEED_WORKSPACE_ROOT = root;
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousRoot === undefined) delete process.env.COGSEED_WORKSPACE_ROOT;
    else process.env.COGSEED_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const levels = process.env.COGSEED_ONTOLOGY_SCALE_STRESS === '1'
    ? (process.env.COGSEED_ONTOLOGY_SCALE_LEVELS || '20,100,300').split(',').map(Number).filter(Number.isInteger)
    : [20];

  for (const moduleCount of levels) {
    it(`retrieves seeded targets at ${moduleCount} modules (correctness invariants)`, async () => {
      const fixture = buildFixture(moduleCount);
      const { commitOntologyCommand } = await import('../../../../src/main/features/cognition/ontology/service');
      const seedStart = performance.now();
      let revision = 0;
      for (let offset = 0; offset < fixture.actions.length; offset += 50) {
        await commitOntologyCommand(userId, {
          commandId: `scale-seed-${moduleCount}-${offset}`, expectedRevision: revision,
          actions: fixture.actions.slice(offset, offset + 50) as never,
        });
        revision += 1;
      }
      const seedMs = performance.now() - seedStart;
      const { runOntologyTaskQuery } = await import('../../../../src/main/features/cognition/ontology/task-query');
      const { buildTaskOntologyContext } = await import('../../../../src/main/features/cognition/ontology/task-context');
      const { readOntologyView } = await import('../../../../src/main/features/cognition/ontology/service');
      const { queryOntologyGraph } = await import('../../../../src/main/features/cognition/ontology/query');
      const doc = await readOntologyView(userId);
      const results: CaseResult[] = [];
      for (const task of fixture.tasks) {
        const started = performance.now();
        const result = await runOntologyTaskQuery({
          userId, context: { taskText: task.taskText }, query: task.query,
          at: '2026-11-01', ...(task.purpose ? { purpose: task.purpose } : {}),
        });
        const queryMs = performance.now() - started;
        const ctxStarted = performance.now();
        const ctx = await buildTaskOntologyContext({
          userId, taskText: task.taskText, ...(task.purpose ? { purpose: task.purpose } : {}), at: '2026-11-01',
        });
        const ctxMs = performance.now() - ctxStarted;
        // Correctness invariants that must hold at any scale.
        expect(result.facts.length).toBeLessThanOrEqual(60);
        expect(result.rules.length).toBeLessThanOrEqual(30);
        expect(result.modules.length).toBeLessThanOrEqual(50);
        for (const fact of [...result.facts, ...result.uncertainFacts]) {
          const record = doc.records[fact.source.recordId];
          expect(record, `fact citation resolves: ${fact.citation}`).toBeTruthy();
          expect(record.status).toBe('active');
        }
        if (task.kind === 'none') {
          expect(result.modules, 'no-hit task injects nothing').toHaveLength(0);
          expect(result.facts).toHaveLength(0);
          expect(result.rules).toHaveLength(0);
        }
        if (task.kind === 'flood') {
          expect(result.modules.length, 'module flood bounded by maxModules').toBeLessThanOrEqual(50);
        }
        if (task.kind === 'ambiguous') {
          const moduleIds = new Set(result.modules.map(module => module.id));
          for (const id of moduleIds) expect(['m3', 'm4'], 'ambiguous name never merges into a wrong module').toContain(id);
        }
        const factModuleIds = new Set(result.facts.map(fact => fact.module.id));
        const targetModuleHit = task.targetModuleId ? result.modules.some(module => module.id === task.targetModuleId) : null;
        const targetFactHit = task.targetFactRecordId ? result.facts.some(fact => fact.source.recordId === task.targetFactRecordId) || result.uncertainFacts.some(fact => fact.source.recordId === task.targetFactRecordId) : null;
        const targetRuleHit = task.targetRuleRecordId ? result.rules.some(rule => rule.source.recordId === task.targetRuleRecordId) : null;
        const targetCitation = task.targetFactRecordId
          ? `[[ontology:${task.targetModuleId}/${task.targetFactRecordId}@1]]` : null;
        results.push({
          kind: task.kind, ms: queryMs, ctxMs,
          moduleHit: targetModuleHit, factHit: targetFactHit, ruleHit: targetRuleHit,
          factModules: factModuleIds.size,
          truncatedFacts: result.truncated.facts, truncatedRules: result.truncated.rules, truncatedModules: result.truncated.modules,
          searchTruncated: result.searchTruncated,
          ctxCited: targetCitation ? ctx.promptBlock.includes(targetCitation) || ctx.readRefs.some(ref => ref.recordId === task.targetFactRecordId) : null,
          ctxModules: new Set(ctx.readRefs.map(ref => ref.moduleId)).size,
        });
      }
      // Graph projection at the same scale.
      const graphStart = performance.now();
      const moduleGraph = queryOntologyGraph(doc, { moduleId: 'm0', at: '2026-11-01', contentScale: 'instances' });
      const globalGraph = queryOntologyGraph(doc, {});
      const graphMs = performance.now() - graphStart;
      expect(moduleGraph.nodes.length).toBeGreaterThan(0);
      expect(globalGraph.nodes.length).toBeLessThanOrEqual(200);
      // Phase timing: isolate the per-query fixed cost between the document
      // read and source admission.
      const { assessOntologySources } = await import('../../../../src/main/features/cognition/ontology/source-admission');
      const phaseReads: number[] = [], phaseAdmits: number[] = [];
      for (let n = 0; n < 5; n += 1) {
        const readStart = performance.now();
        const phaseDoc = await readOntologyView(userId);
        phaseReads.push(performance.now() - readStart);
        const admitStart = performance.now();
        await assessOntologySources(userId, phaseDoc, { taskText: '刘研0员3' });
        phaseAdmits.push(performance.now() - admitStart);
      }
      console.log('[ontology-scale:phases] ' + JSON.stringify({
        readP50: Math.round(percentile(phaseReads, 0.5)), admitP50: Math.round(percentile(phaseAdmits, 0.5)),
      }));
      if (process.env.COGSEED_SCALE_PROFILE === '1') {
        const { searchOntologyRecordsWithMeta, queryOntologyFacts, queryOntologyRules } = await import('../../../../src/main/features/cognition/ontology/query');
        const searchStart = performance.now();
        const floodRows = searchOntologyRecordsWithMeta(doc, '共享平台账号', undefined, { taskOnly: true });
        const searchMs = performance.now() - searchStart;
        const factTimes: number[] = [], ruleTimes: number[] = [];
        const floodModuleIds = [...new Set(floodRows.rows.map(row => row.kind === 'module' ? row.id : row.moduleId))].slice(0, 10);
        for (const moduleId of floodModuleIds) {
          const factStart = performance.now();
          queryOntologyFacts(doc, { moduleId, at: '2026-11-01' });
          factTimes.push(performance.now() - factStart);
          const ruleStart = performance.now();
          queryOntologyRules(doc, { moduleId, task: { at: '2026-11-01', purpose: 'weekly_report' } });
          ruleTimes.push(performance.now() - ruleStart);
        }
        const canonicalStart = performance.now();
        (await import('../../../../src/main/features/cognition/ontology/service')).readOntologyDocument(userId);
        const canonicalMs = performance.now() - canonicalStart;
        const legacyGraphStart = performance.now();
        const legacyGraph = await import('../../../../src/main/features/ontology_graph');
        legacyGraph.readOntologyGraph(userId);
        const legacyGraphMs = performance.now() - legacyGraphStart;
        const poStart = performance.now();
        const po = await import('../../../../src/main/features/po/store');
        po.loadPoDocSync(userId);
        const poMs = performance.now() - poStart;
        const bridgeStart = performance.now();
        const bridge = await import('../../../../src/main/features/cognition_bridge');
        await bridge.readUnifiedPoDocument(userId);
        const bridgeMs = performance.now() - bridgeStart;
        console.log('[ontology-scale:profile] ' + JSON.stringify({
          records: Object.keys(doc.records).length, searchMs: Math.round(searchMs),
          floodRows: floodRows.rows.length, floodTruncated: floodRows.truncated,
          factMsPerModule: Math.round(percentile(factTimes, 0.5)), factMsMax: Math.round(Math.max(...factTimes)),
          ruleMsPerModule: Math.round(percentile(ruleTimes, 0.5)),
          canonicalMs: Math.round(canonicalMs), legacyGraphMs: Math.round(legacyGraphMs),
          poMs: Math.round(poMs), bridgeMs: Math.round(bridgeMs),
        }));
      }

      const grouped = new Map<string, CaseResult[]>();
      for (const row of results) {
        grouped.set(row.kind, [...(grouped.get(row.kind) || []), row]);
      }
      const summarize = (rows: CaseResult[]) => ({
        n: rows.length,
        moduleRecall: rows.filter(row => row.moduleHit === true).length / rows.filter(row => row.moduleHit !== null).length || 0,
        factRecall: rows.filter(row => row.factHit === true).length / rows.filter(row => row.factHit !== null).length || 0,
        ruleRecall: rows.filter(row => row.ruleHit === true).length / rows.filter(row => row.ruleHit !== null).length || 0,
        ctxRecall: rows.filter(row => row.ctxCited === true).length / rows.filter(row => row.ctxCited !== null).length || 0,
        p50ms: Math.round(percentile(rows.map(row => row.ms), 0.5)),
        p95ms: Math.round(percentile(rows.map(row => row.ms), 0.95)),
        maxMs: Math.round(Math.max(...rows.map(row => row.ms))),
      });
      const timing = results.map(row => row.ms);
      const ctxTiming = results.map(row => row.ctxMs);
      const report = {
        modules: moduleCount, records: fixture.recordCount, seedMs: Math.round(seedMs),
        graphMs: Math.round(graphMs), graphTruncated: { module: moduleGraph.truncated, global: globalGraph.truncated },
        queryP50: Math.round(percentile(timing, 0.5)), queryP95: Math.round(percentile(timing, 0.95)), queryMax: Math.round(Math.max(...timing)),
        ctxP50: Math.round(percentile(ctxTiming, 0.5)), ctxP95: Math.round(percentile(ctxTiming, 0.95)), ctxMax: Math.round(Math.max(...ctxTiming)),
        kinds: Object.fromEntries([...grouped.entries()].map(([kind, rows]) => [kind, summarize(rows)])),
        flood: { modules: results.find(row => row.kind === 'flood')?.factModules, truncatedModules: results.find(row => row.kind === 'flood')?.truncatedModules },
      };
      console.log('[ontology-scale] ' + JSON.stringify(report));
      if (moduleCount === 20) {
        // Always-on level: seeded ground-truth recall must hold at small scale.
        for (const kind of ['entity', 'alias', 'relation', 'rule', 'fat-first', 'fat-last']) {
          const rows = grouped.get(kind) || [];
          for (const row of rows) {
            expect(row.moduleHit, `${kind} module recall`).toBe(true);
            expect(row.factHit ?? row.ruleHit, `${kind} target recall`).toBe(true);
            expect(row.ctxCited ?? true, `${kind} context citation`).toBe(true);
          }
        }
      }
    }, 600_000);
  }
});

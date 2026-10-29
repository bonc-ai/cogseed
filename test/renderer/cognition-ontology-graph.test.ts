import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

function graphApi(): any {
  const window: Record<string, unknown> = {};
  const source = readFileSync(resolve('src/renderer/modules/cognition-ontology-graph.js'), 'utf8');
  runInNewContext(source, { window, Intl, Date, Math, String, Map, Set });
  return window.CogOntologyGraph;
}
const moduleRecord = (id: string) => ({ id, kind: 'module', status: 'active', name: id, source: { kind: 'user', label: 'user' } });
const entity = (id: string, moduleId = 'm') => ({ id, kind: 'entity', moduleId, status: 'active', name: id, source: { kind: 'user', label: 'user' } });

describe('ontology relationship projection', () => {
  it('draws entity facts and explicit references while keeping literal values in details', () => {
    const records: Record<string, any> = {
      m: moduleRecord('m'), other: moduleRecord('other'), a: entity('a'), b: entity('b'),
      relation: { id: 'relation', kind: 'definition', status: 'active', moduleId: 'm', name: '协作' },
      ref: { id: 'ref', kind: 'reference', status: 'active', moduleId: 'm', targetModuleId: 'other' },
      edge: { id: 'edge', kind: 'assertion', status: 'active', moduleId: 'm', subjectId: 'a', definitionId: 'relation', object: { kind: 'entity', id: 'b' }, validity: { from: null, until: null, precision: 'day' } },
      literal: { id: 'literal', kind: 'assertion', status: 'active', moduleId: 'm', subjectId: 'a', definitionId: 'relation', object: { kind: 'literal', value: 'long text' }, validity: { from: null, until: null, precision: 'day' } },
    };
    const api = graphApi();
    const local = api._project({ records }, 'm', '2026-10-10');
    expect(local.nodes.map((node: any) => node.id)).toEqual(['a', 'b']);
    expect(local.edges.map((edge: any) => edge.id)).toEqual(['edge']);
    expect(local.edges[0].unknownDate).toBe(true);
    expect(local.edges[0].certainty).toBe('confirmed');
    expect(local.edges[0].uncertain).toBe(false);
    expect(local.edges[0].labelKey).toBe('');
    expect(local.literalFacts.get('a')[0].object.value).toBe('long text');
    const references = api._project({ records }, '', '2026-10-10').edges;
    expect(references.map((edge: any) => edge.id)).toEqual(['ref']);
    expect(references[0].labelKey).toBe('graphModuleReference');
  });

  it('omits expired facts and bounds a large graph with honest counts', () => {
    const records: Record<string, any> = { m: moduleRecord('m') };
    for (let index = 0; index < 520; index++) records[`e${index}`] = entity(`e${index}`);
    records.expired = { id: 'expired', kind: 'assertion', moduleId: 'm', status: 'active', subjectId: 'e0', definitionId: 'x', object: { kind: 'entity', id: 'e1' }, validity: { from: '2020-01-01', until: '2020-02-01', precision: 'day' } };
    const api = graphApi(), projected = api._project({ records }, 'm', '2026-10-10');
    expect(projected.edges).toHaveLength(0);
    const visible = api._visibleProjection(projected, '', 110);
    expect(visible.nodes).toHaveLength(110);
    expect(visible.hidden).toBe(410);
  });

  it('spreads sixty disconnected nodes and preserves moved positions', () => {
    const api = graphApi();
    const nodes = Array.from({ length: 60 }, (_, index) => ({ id: `n${index}` }));
    const positions = api._positionsFor(nodes, [], new Map());
    let closest = Infinity;
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const first = positions.get(nodes[a].id), second = positions.get(nodes[b].id);
      closest = Math.min(closest, Math.hypot(first.x - second.x, first.y - second.y));
    }
    expect(closest).toBeGreaterThan(80);
    const moved = new Map([['n0', { x: 777, y: 333 }]]);
    expect(api._positionsFor(nodes, [], moved).get('n0')).toEqual({ x: 777, y: 333 });
    const compact = api._positionsFor(nodes, [], new Map(), true);
    let compactClosest = Infinity;
    for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
      const first = compact.get(nodes[a].id), second = compact.get(nodes[b].id);
      compactClosest = Math.min(compactClosest, Math.hypot(first.x - second.x, first.y - second.y));
    }
    expect(compactClosest).toBeGreaterThan(80);
  });

  it('labels module nodes without a box and shortens CogSeed module names', () => {
    const api = graphApi();
    expect(api._displayModuleName('CogSeed · 产品与系统')).toBe('产品与系统');
    expect(api._nodeSubtitle({ kind: 'module' }, (key: string, fallback: string) => key === 'module' ? '本体' : fallback)).toBe('本体');
    expect(api._nodeSubtitle({ kind: 'entity', box: 'A' }, (_key: string, fallback: string) => fallback === 'entity' ? '对象' : fallback)).toBe('A · 对象');
    const records = { m: { ...moduleRecord('m'), name: 'CogSeed · 产品与系统' } };
    const node = api._project({ records }, '', '2026-10-10').nodes[0];
    expect(node.label).toBe('产品与系统');
    expect(node.fullLabel).toBe('CogSeed · 产品与系统');
  });

  it('caps the global fit scale at 120% without changing local scale', () => {
    const api = graphApi();
    expect(api._fitScale(1, true)).toBe(1.2);
    expect(api._fitScale(1, false)).toBe(1);
    expect(api._fitScale(0.5, true)).toBeCloseTo(0.6);
  });

  it('keeps product-system nodes and relation labels apart, including reciprocal and parallel edges', () => {
    const api = graphApi();
    const ids = ['app', 'renderer', 'preload', 'main', 'core', 'runtime', 'local', 'mcp', 'storage', 'cloud', 'localdata', 'knowledge', 'continuity', 'cognition'];
    const nodes = [...ids, 'rule-1', 'rule-2', 'rule-3', 'rule-4'].map(id => ({ id }));
    const pairs = [
      ...['renderer', 'preload', 'main', 'core', 'runtime', 'local', 'mcp', 'storage'].map(id => ['app', id, '包含组件']),
      ...['knowledge', 'continuity', 'cognition'].map(id => ['app', id, '提供能力']),
      ['renderer', 'preload', '通过边界调用'], ['preload', 'main', '通过边界调用'],
      ...['core', 'runtime', 'local', 'mcp', 'storage'].map(id => ['main', id, '通过边界调用']),
      ['storage', 'cloud', '管理数据域'], ['storage', 'localdata', '管理数据域'],
      ['main', 'preload', '返回结果'], ['app', 'main', '管理生命周期'],
    ];
    const edges = pairs.map(([from, to, label], index) => ({ id: `edge-${index}`, from, to, label }));
    const positions = api._positionsFor(nodes, edges, new Map());
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = positions.get(nodes[i].id), b = positions.get(nodes[j].id);
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(140);
    }
    const checkLabels = () => {
      const routes = api._edgeRoutes(nodes, edges, positions, (edge: any) => edge.label);
      const boxes: any[] = [...routes.values()];
      expect(boxes).toHaveLength(edges.length);
      for (const box of boxes) for (const node of positions.values()) {
        const dx = Math.max(0, Math.abs(box.x - node.x) - box.width / 2);
        const dy = Math.max(0, Math.abs(box.y - node.y) - box.height / 2);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(48);
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        expect(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2).toBe(true);
      }
    };
    checkLabels();
    const moved = positions.get('renderer');
    positions.set('renderer', { x: moved.x + 35, y: moved.y + 20 });
    checkLabels();
  });

  it('distinguishes uncertain assertions from unknown start dates', () => {
    const records: Record<string, any> = { m: moduleRecord('m'), a: entity('a'), b: entity('b') };
    records.unknown = { id: 'unknown', kind: 'assertion', status: 'active', moduleId: 'm', subjectId: 'a', definitionId: 'p', object: { kind: 'entity', id: 'b' }, certainty: 'unknown', validity: { from: '2026-01-01', until: null, precision: 'day' } };
    const edge = graphApi()._project({ records }, 'm', '2026-10-10').edges[0];
    expect(edge.unknownDate).toBe(false);
    expect(edge.certainty).toBe('unknown');
    expect(edge.uncertain).toBe(true);
  });

  it('allows edits only for active canonical records in active canonical modules', () => {
    const api = graphApi();
    const records: Record<string, any> = { m: moduleRecord('m'), e: entity('e') };
    expect(api._editableRecord(records, records.e)).toBe(true);
    records.m.source.kind = 'legacy';
    expect(api._editableRecord(records, records.e)).toBe(false);
    records.m.source.kind = 'user'; records.m.status = 'paused';
    expect(api._editableRecord(records, records.e)).toBe(false);
    records.m.status = 'active'; records.e.status = 'paused';
    expect(api._editableRecord(records, records.e)).toBe(false);
    records.e.status = 'active'; records.e.source.kind = 'legacy';
    expect(api._editableRecord(records, records.e)).toBe(false);
    records.m.source.kind = 'legacy';
    expect(api._editableRecord(records, records.m)).toBe(false);
  });

  it('uses the local calendar day for the default query date', () => {
    const date = new Date();
    const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    expect(graphApi()._today()).toBe(expected);
  });

  it('projects a module as a star with assertion beads and the outer record layers', () => {
    const api = graphApi();
    const records: Record<string, any> = {
      m: moduleRecord('m'), a: entity('a'), b: entity('b'), c: entity('c'),
      rel: { id: 'rel', kind: 'definition', moduleId: 'm', status: 'active', name: '包含组件', cardinality: 'many', subjectTypes: ['type'], objectTypes: ['type'] },
      type: { id: 'type', kind: 'definition', moduleId: 'm', status: 'active', name: '系统组件' },
      rule: { id: 'rule', kind: 'rule', moduleId: 'm', status: 'active', name: '边界规则', effect: { kind: 'include_recipient', entityId: 'a' } },
      ref: { id: 'ref', kind: 'reference', moduleId: 'm', status: 'active', name: '外部引用', targetModuleId: 'm', targetRecordId: 'b' },
      assert: { id: 'assert', kind: 'assertion', moduleId: 'm', status: 'active', subjectId: 'a', definitionId: 'rel', object: { kind: 'entity', id: 'b' }, validity: { from: null, until: null, precision: 'day' } },
      literal: { id: 'literal', kind: 'assertion', moduleId: 'm', status: 'active', subjectId: 'a', definitionId: 'rel', object: { kind: 'literal', value: 'src/a.ts' }, validity: { from: null, until: null, precision: 'day' } },
    };
    const projected = api._starProject({ records }, 'm', '2026-10-10', (_key: string, fallback: string) => fallback);
    expect(projected.nodes.filter((node: any) => node.kind === 'entity')).toHaveLength(3);
    expect(projected.nodes.find((node: any) => node.id === 'assert').shape).toBe('bead');
    expect(projected.nodes.find((node: any) => node.id === 'literal').shape).toBe('square');
    expect(projected.nodes.find((node: any) => node.id === 'rel').shape).toBe('ring');
    expect(projected.nodes.find((node: any) => node.id === 'rule').shape).toBe('rule');
    expect(projected.nodes.find((node: any) => node.id === 'ref').shape).toBe('portal');
    expect(projected.edges.map((edge: any) => edge.id)).toEqual(['assert', 'ref:ref', 'rule:rule']);
    expect(projected.literalFacts.get('a')[0].id).toBe('literal');
  });

  it('lays out a center, entity ring and trimmed assertion beads', () => {
    const api = graphApi();
    const records: Record<string, any> = {
      m: moduleRecord('m'), a: entity('a'), b: entity('b'), c: entity('c'),
      rel: { id: 'rel', kind: 'definition', moduleId: 'm', status: 'active', name: '关系' },
      assert: { id: 'assert', kind: 'assertion', moduleId: 'm', status: 'active', subjectId: 'a', definitionId: 'rel', object: { kind: 'entity', id: 'b' }, validity: { from: null, until: null, precision: 'day' } },
    };
    const projected = api._starProject({ records }, 'm', '2026-10-10', (_key: string, fallback: string) => fallback);
    const laidOut = api._starLayout(projected, 'a', new Map());
    const center = laidOut.positions.get('a'), second = laidOut.positions.get('b'), third = laidOut.positions.get('c');
    const onEntityRing = (point: any) => ((point.x - center.x) / 280) ** 2 + ((point.y - center.y) / 135) ** 2;
    expect(onEntityRing(second)).toBeCloseTo(1, 2);
    expect(onEntityRing(third)).toBeCloseTo(1, 2);
    for (const point of laidOut.positions.values()) {
      expect(point.x).toBeGreaterThanOrEqual(450 - 365 - 1);
      expect(point.x).toBeLessThanOrEqual(450 + 365 + 1);
      expect(point.y).toBeGreaterThanOrEqual(280 - 180 - 1);
      expect(point.y).toBeLessThanOrEqual(280 + 180 + 1);
    }
    const byId = new Map(projected.nodes.map((node: any) => [node.id, node]));
    const edge = projected.edges.find((item: any) => item.id === 'assert');
    const trim = api._starTrimEdge(edge, laidOut.positions, byId);
    expect(Math.hypot(trim.start.x - center.x, trim.start.y - center.y)).toBeGreaterThanOrEqual(byId.get('a').r + 1.5);
    expect(Math.hypot(trim.end.x - second.x, trim.end.y - second.y)).toBeGreaterThanOrEqual(byId.get('b').r + 1.5);
    const bead = api._starBeadPoint(edge, laidOut.positions, byId);
    let closest = Infinity;
    for (let index = 0; index <= 100; index++) {
      const t = index / 100, mt = 1 - t;
      const x = mt * mt * trim.start.x + 2 * mt * t * trim.control.x + t * t * trim.end.x;
      const y = mt * mt * trim.start.y + 2 * mt * t * trim.control.y + t * t * trim.end.y;
      closest = Math.min(closest, Math.hypot(bead.x - x, bead.y - y));
    }
    expect(closest).toBeLessThan(.5);
  });

  it('labels objects, concepts, rules and references in two tiers', () => {
    const api = graphApi();
    const records: Record<string, any> = {
      m: moduleRecord('m'), a: entity('a'), b: entity('b'), c: entity('c'),
      rel: { id: 'rel', kind: 'definition', moduleId: 'm', status: 'active', name: '包含组件' },
      type: { id: 'type', kind: 'definition', moduleId: 'm', status: 'active', name: '系统组件' },
      rule: { id: 'rule', kind: 'rule', moduleId: 'm', status: 'active', name: '边界规则', effect: { kind: 'include_recipient', entityId: 'a' } },
      ref: { id: 'ref', kind: 'reference', moduleId: 'm', status: 'active', name: '外部引用', targetModuleId: 'm', targetRecordId: 'b' },
      assert: { id: 'assert', kind: 'assertion', moduleId: 'm', status: 'active', subjectId: 'a', definitionId: 'rel', object: { kind: 'entity', id: 'b' }, validity: { from: null, until: null, precision: 'day' } },
    };
    const projected = api._starProject({ records }, 'm', '2026-10-10', (_key: string, fallback: string) => fallback);
    api._starLayout(projected, 'a', new Map());
    const labeled = projected.nodes.filter((node: any) => ['entity', 'definition', 'rule', 'reference'].includes(node.kind));
    expect(labeled.length).toBeGreaterThan(4);
    expect(labeled.every((node: any) => node.labelVisible)).toBe(true);
    const object = projected.nodes.find((node: any) => node.id === 'b');
    expect(object.labelChip).toBe(true);
    expect(object.labelSize).toBe(9.5);
    const concept = projected.nodes.find((node: any) => node.id === 'rel');
    expect(concept.labelChip).toBe(false);
    expect(concept.labelSize).toBe(8);
    expect(concept.labelText).toBe('包含组件');
    expect(projected.nodes.find((node: any) => node.id === 'a').labelSize).toBe(14);
    const boxes = labeled.map((node: any) => ({
      x: node.labelX - node.labelWidth / 2, y: node.labelY - node.labelHeight / 2,
      width: node.labelWidth, height: node.labelHeight,
    }));
    for (let first = 0; first < boxes.length; first++) {
      for (let second = first + 1; second < boxes.length; second++) {
        const a = boxes[first], b = boxes[second];
        expect(a.x + a.width <= b.x + 2 || b.x + b.width <= a.x + 2
          || a.y + a.height <= b.y + 2 || b.y + b.height <= a.y + 2).toBe(true);
      }
    }
  });

  it('caps star visibility while always keeping the focus', () => {
    const api = graphApi();
    const nodes = Array.from({ length: 200 }, (_, index) => ({ id: `e${index}`, kind: 'entity', box: 'A', r: 11 }));
    const visible = api._visibleStar({ nodes, edges: [] }, 'e42', 'all');
    expect(visible.nodes).toHaveLength(60);
    expect(visible.nodes.some((node: any) => node.id === 'e42')).toBe(true);
    expect(visible.hidden).toBe(140);
    expect(visible.focusId).toBe('e42');
  });

  it('exposes at most five non-empty reading points', () => {
    const api = graphApi();
    const points = api._readingPoints({ summaryPoints: [
      { text: 'one', evidenceIds: ['a'] }, { text: 'two', evidenceIds: ['b'] },
      { text: 'three', evidenceIds: ['c'] }, { text: 'four', evidenceIds: ['d'] },
      { text: 'five', evidenceIds: ['e'] }, { text: 'six', evidenceIds: ['f'] },
      { text: '   ', evidenceIds: [] },
    ] });
    expect(points).toHaveLength(5);
    expect(points.every((point: any) => point.text.length > 0)).toBe(true);
    expect(api._readingPoints({})).toEqual([]);
  });
});

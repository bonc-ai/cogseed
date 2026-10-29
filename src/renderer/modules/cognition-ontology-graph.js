/* 本体主档的关系图投影。所有保存均由本体页面处理。 */
(function initCogOntologyGraph(root) {
  'use strict';

  const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const hash = value => {
    let result = 2166136261;
    for (const character of String(value)) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
    return result >>> 0;
  };
  const compare = (a, b) => String(a.id).localeCompare(String(b.id));
  const short = value => String(value || '').length > 15 ? `${String(value).slice(0, 14)}…` : String(value || '');
  const displayModuleName = value => String(value || '').replace(/^CogSeed\s*·\s*/i, '');
  const nodeSubtitle = (node, translate) => {
    const key = node.kind === 'assertion' ? 'graphAssertionKind' : node.kind === 'entity' ? 'graphEntityKind' : node.kind;
    const fallback = node.kind === 'module' ? '本体' : node.kind;
    const label = typeof translate === 'function' ? translate(key, fallback) : fallback;
    return node.box ? `${node.box} · ${label}` : label;
  };
  const fitScale = (fitted, global) => global ? Math.min(1.2, fitted * 1.2) : fitted;
  const today = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const validAt = (record, at) => {
    const validity = record.validity || {};
    const from = validity.from && validity.precision === 'month' ? `${validity.from}-01` : validity.from;
    const until = validity.until && validity.precision === 'month' ? `${validity.until}-01` : validity.until;
    return (!from || from <= at) && (!until || at < until);
  };
  const editableRecord = (records, record) => {
    const module = record?.kind === 'module' ? record : records?.[record?.moduleId];
    return record?.status === 'active' && record.source?.kind !== 'legacy'
      && module?.status === 'active' && module.source?.kind !== 'legacy';
  };

  function project(doc, moduleId, at) {
    const records = doc?.records || {};
    const active = record => record?.status === 'active' && records[record.moduleId]?.status === 'active';
    const nodes = [], edges = [], literalFacts = new Map();
    if (!moduleId) {
      const modules = Object.values(records).filter(record => record.kind === 'module' && record.status === 'active').sort(compare);
      const ids = new Set(modules.map(record => record.id));
      for (const module of modules) nodes.push({ id: module.id, record: module, label: displayModuleName(module.name), fullLabel: module.name, kind: 'module' });
      for (const record of Object.values(records)) if (record.kind === 'reference' && active(record)
        && ids.has(record.moduleId) && ids.has(record.targetModuleId)) {
        edges.push({ id: record.id, from: record.moduleId, to: record.targetModuleId, record,
          label: record.targetRecordId ? '引用对象' : '引用本体',
          labelKey: record.targetRecordId ? 'graphRecordReference' : 'graphModuleReference', kind: 'reference' });
      }
    } else {
      const module = records[moduleId];
      if (!module || module.kind !== 'module' || module.status !== 'active') return { nodes, edges, literalFacts };
      const entityIds = new Set();
      for (const record of Object.values(records)) if (record.kind === 'entity' && record.moduleId === moduleId && active(record)) {
        entityIds.add(record.id);
        nodes.push({ id: record.id, record, label: record.name, kind: 'entity' });
      }
      for (const record of Object.values(records)) {
        if (record.kind !== 'assertion' || record.moduleId !== moduleId || !active(record) || !validAt(record, at)) continue;
        if (!entityIds.has(record.subjectId)) continue;
        if (record.object?.kind === 'literal') {
          literalFacts.set(record.subjectId, [...(literalFacts.get(record.subjectId) || []), record]);
          continue;
        }
        const target = records[record.object?.id];
        if (!target || target.kind !== 'entity' || target.status !== 'active' || records[target.moduleId]?.status !== 'active') continue;
        if (!entityIds.has(target.id)) {
          entityIds.add(target.id);
          nodes.push({ id: target.id, record: target, label: target.name, kind: 'entity', referenced: true });
        }
        edges.push({ id: record.id, from: record.subjectId, to: target.id, record,
          label: records[record.definitionId]?.name || '关系',
          labelKey: records[record.definitionId]?.name ? '' : 'relation', kind: 'assertion',
          unknownDate: !record.validity?.from, certainty: record.certainty || 'confirmed',
          uncertain: Boolean(record.certainty && record.certainty !== 'confirmed') });
      }
      for (const record of Object.values(records)) if (record.kind === 'rule' && record.moduleId === moduleId && active(record)) {
        nodes.push({ id: record.id, record, label: record.name, kind: 'rule' });
        if (record.effect?.kind === 'include_recipient' && entityIds.has(record.effect.entityId))
          edges.push({ id: `rule:${record.id}`, from: record.id, to: record.effect.entityId,
            record, label: '接收人', labelKey: 'graphRecipient', kind: 'rule', certainty: record.certainty || 'confirmed',
            uncertain: Boolean(record.certainty && record.certainty !== 'confirmed') });
      }
    }
    nodes.sort(compare); edges.sort(compare);
    return { nodes, edges, literalFacts };
  }

  function visibleProjection(projected, focusId, limit = 110) {
    const { nodes, edges } = projected;
    if (nodes.length <= limit) return { nodes, edges, hidden: 0 };
    const adjacency = new Map(nodes.map(node => [node.id, new Set()]));
    for (const edge of edges) {
      adjacency.get(edge.from)?.add(edge.to);
      adjacency.get(edge.to)?.add(edge.from);
    }
    const selected = new Set(), queue = [];
    const seed = focusId && adjacency.has(focusId) ? focusId
      : [...nodes].sort((a, b) => (adjacency.get(b.id)?.size || 0) - (adjacency.get(a.id)?.size || 0) || compare(a, b))[0]?.id;
    if (seed) queue.push(seed);
    while (selected.size < limit) {
      if (!queue.length) {
        const next = nodes.find(node => !selected.has(node.id));
        if (!next) break;
        queue.push(next.id);
      }
      const id = queue.shift();
      if (selected.has(id)) continue;
      selected.add(id);
      queue.push(...[...(adjacency.get(id) || [])].sort());
    }
    return { nodes: nodes.filter(node => selected.has(node.id)),
      edges: edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)), hidden: nodes.length - selected.size };
  }

  const NODE_RADIUS = 48;
  const labelWidth = label => Math.max(42, [...String(label)].reduce((sum, char) => sum + (/[\u2e80-\uffff]/.test(char) ? 13 : 7), 0) + 18);

  function positionsFor(nodes, edges, saved, compactIsolated = false) {
    const positions = new Map();
    if (!nodes.length) return positions;
    const connected = new Set(edges.flatMap(edge => [edge.from, edge.to]));
    const ordered = nodes.filter(node => connected.has(node.id)).sort(compare);
    const isolated = nodes.filter(node => !connected.has(node.id)).sort(compare);
    const count = ordered.length, radius = Math.max(170, Math.sqrt(count) * 100);
    for (let index = 0; index < count; index++) {
      const node = ordered[index], angle = index * 2.399963229728653 + hash(node.id) / 0xffffffff * .35;
      const distance = Math.sqrt((index + .5) / count) * radius;
      positions.set(node.id, saved.get(node.id) || { x: Math.cos(angle) * distance * 1.65, y: Math.sin(angle) * distance });
    }
    // Spread the connected graph across a landscape canvas. Isolated rules are
    // packed afterward, so they cannot push the useful component into a tiny cluster.
    for (let turn = 0; turn < 180; turn++) {
      const delta = new Map(ordered.map(node => [node.id, { x: 0, y: 0 }]));
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const a = positions.get(ordered[i].id), b = positions.get(ordered[j].id);
        const dx = a.x - b.x || .01, dy = a.y - b.y || .01;
        const distance = Math.max(1, Math.hypot(dx / 1.55, dy));
        const force = Math.max(0, 220 - distance) / distance * .22;
        delta.get(ordered[i].id).x += dx * force; delta.get(ordered[i].id).y += dy * force;
        delta.get(ordered[j].id).x -= dx * force; delta.get(ordered[j].id).y -= dy * force;
      }
      for (const edge of edges) {
        const a = positions.get(edge.from), b = positions.get(edge.to);
        if (!a || !b || edge.from === edge.to) continue;
        const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
        const force = (distance - 290) / distance * .014;
        delta.get(edge.from).x += dx * force; delta.get(edge.from).y += dy * force;
        delta.get(edge.to).x -= dx * force; delta.get(edge.to).y -= dy * force;
      }
      for (const node of ordered) {
        if (saved.has(node.id)) continue;
        const position = positions.get(node.id), movement = delta.get(node.id);
        position.x += Math.max(-16, Math.min(16, movement.x));
        position.y += Math.max(-16, Math.min(16, movement.y));
      }
    }
    for (const node of ordered) if (!saved.has(node.id)) {
      const position = positions.get(node.id); position.x *= 1.12; position.y *= .52;
    }
    // Compress the initial aspect ratio without allowing circular nodes to collide.
    for (let turn = 0; turn < 40; turn++) for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      const a = positions.get(ordered[i].id), b = positions.get(ordered[j].id);
      const dx = b.x - a.x || .01, dy = b.y - a.y || .01, distance = Math.max(.1, Math.hypot(dx, dy));
      if (distance >= 158) continue;
      const force = (158 - distance) / distance * .5;
      if (!saved.has(ordered[i].id)) { a.x -= dx * force; a.y -= dy * force; }
      if (!saved.has(ordered[j].id)) { b.x += dx * force; b.y += dy * force; }
    }
    const values = [...positions.values()];
    const gapX = compactIsolated ? 160 : 180, gapY = compactIsolated ? 132 : 150, offset = compactIsolated ? 140 : 180;
    const width = values.length ? Math.max(480, Math.max(...values.map(p => p.x)) - Math.min(...values.map(p => p.x))) : Math.max(480, Math.sqrt(isolated.length * 2) * gapX);
    const columns = Math.max(1, Math.floor(width / gapX));
    const middle = values.length ? (Math.min(...values.map(p => p.x)) + Math.max(...values.map(p => p.x))) / 2 : 0;
    const bottom = values.length ? Math.max(...values.map(p => p.y)) + offset : 0;
    isolated.forEach((node, index) => {
      const rowCount = Math.min(columns, isolated.length - Math.floor(index / columns) * columns);
      positions.set(node.id, saved.get(node.id) || { x: middle + (index % columns - (rowCount - 1) / 2) * gapX, y: bottom + Math.floor(index / columns) * gapY });
    });
    return positions;
  }

  function edgeRoutes(nodes, edges, positions, labelFor) {
    const placed = [], routes = new Map();
    const nodePositions = nodes.map(node => ({ id: node.id, ...positions.get(node.id) }));
    const overlaps = (a, b, gap = 8) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap;
    const touchesNode = (box, node, radius = NODE_RADIUS + 12) => Math.hypot(Math.max(0, Math.abs(box.x - node.x) - box.width / 2), Math.max(0, Math.abs(box.y - node.y) - box.height / 2)) < radius;
    for (const edge of [...edges].sort((a, b) => labelWidth(labelFor(b)) - labelWidth(labelFor(a)) || compare(a, b))) {
      const a = positions.get(edge.from), b = positions.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.max(1, Math.hypot(dx, dy));
      const width = labelWidth(labelFor(edge));
      let best;
      const offsets = edge.from === edge.to ? [100, 140, 180] : [0, 36, -36, 72, -72, 112, -112, 160, -160, 220, -220];
      for (const offset of offsets) for (const fraction of [.5, .35, .65, .22, .78]) {
        const x = a.x + dx * fraction - (dy / length || (edge.from === edge.to ? 1 : 0)) * offset;
        const y = a.y + dy * fraction + (dx / length || (edge.from === edge.to ? 1 : 0)) * offset;
        const box = { x, y, width, height: 26 };
        const collision = nodePositions.filter(node => touchesNode(box, node)).length + placed.filter(other => overlaps(box, other)).length;
        const score = collision * 100000 + Math.abs(offset) + Math.abs(fraction - .5) * 120;
        if (!best || score < best.score) best = { ...box, score };
      }
      const toward = (point, target) => {
        const distance = Math.max(1, Math.hypot(target.x - point.x, target.y - point.y));
        return { x: point.x + (target.x - point.x) / distance * (NODE_RADIUS + 3), y: point.y + (target.y - point.y) / distance * (NODE_RADIUS + 3) };
      };
      // The quadratic midpoint is the label position, not its control point.
      const control = { x: 2 * best.x - (a.x + b.x) / 2, y: 2 * best.y - (a.y + b.y) / 2 };
      const start = toward(a, control), end = toward(b, control);
      const cx = 2 * best.x - (start.x + end.x) / 2, cy = 2 * best.y - (start.y + end.y) / 2;
      const path = edge.from === edge.to
        ? `M${a.x - 32},${a.y - 36} C${best.x - 80},${best.y - 75} ${best.x + 80},${best.y - 75} ${a.x + 32},${a.y - 36}`
        : `M${start.x},${start.y} Q${cx},${cy} ${end.x},${end.y}`;
      placed.push(best); routes.set(edge.id, { ...best, path });
    }
    return routes;
  }

  const STAR = {
    width: 900, height: 560, centerX: 450, centerY: 280,
    entity: { x: 280, y: 135 }, halo: { x: 340, y: 160 }, outer: { x: 365, y: 180 }, limit: 180,
  };
  const STAR_CAPS = { entity: 60, assertion: 80, definition: 40, rule: 24, reference: 12, attribute: 40 };
  const starClamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const starMatchesLens = (node, value) => value === 'all' || node.box === value
    || (value === 'R' && node.kind === 'definition' && (node.record.cardinality || node.record.subjectTypes?.length || node.record.objectTypes?.length));
  const starTextWidth = (value, size) => Math.max(size, [...String(value || '')]
    .reduce((sum, character) => sum + (/[\u2e80-\uffff]/.test(character) ? 1 : .56), 0) * size);

  function starProject(doc, moduleId, at, translate) {
    const records = doc?.records || {};
    const t = typeof translate === 'function' ? translate : (key, fallback) => fallback;
    const module = records[moduleId];
    const empty = { nodes: [], edges: [], literalFacts: new Map() };
    if (!module || module.kind !== 'module' || module.status !== 'active') return empty;
    const local = Object.values(records).filter(record => record.moduleId === moduleId && record.status === 'active');
    const entities = new Map();
    const nodes = [];
    const edges = [];
    const literalFacts = new Map();
    for (const record of local) {
      if (record.kind === 'entity') {
        entities.set(record.id, record);
        nodes.push({ id: record.id, record, kind: 'entity', box: 'A', label: record.name, fullLabel: record.name, star: true, shape: 'disc', r: 11 });
      } else if (record.kind === 'definition') {
        nodes.push({ id: record.id, record, kind: 'definition', box: 'T', label: record.name, fullLabel: record.name, star: true, shape: 'ring', r: 7 });
      } else if (record.kind === 'rule') {
        nodes.push({ id: record.id, record, kind: 'rule', box: 'R', label: record.name, fullLabel: record.name, star: true, shape: 'rule', r: 13 });
      } else if (record.kind === 'reference') {
        nodes.push({ id: record.id, record, kind: 'reference', box: 'ref', label: record.name || t('reference', '引用'), fullLabel: record.name || t('reference', '引用'), star: true, shape: 'portal', r: 11 });
      }
    }
    const degree = new Map();
    const bump = id => degree.set(id, (degree.get(id) || 0) + 1);
    for (const record of local) {
      if (record.kind !== 'assertion' || !validAt(record, at)) continue;
      if (!entities.has(record.subjectId)) continue;
      const definition = records[record.definitionId];
      const label = definition?.name || t('relation', '关系');
      if (record.object?.kind === 'literal') {
        literalFacts.set(record.subjectId, [...(literalFacts.get(record.subjectId) || []), record]);
        nodes.push({ id: record.id, record, kind: 'attribute', box: 'A', label, fullLabel: `${label}: ${record.object.value}`, star: true, shape: 'square', r: 3.2 });
        continue;
      }
      const target = records[record.object?.id];
      if (!target || target.kind !== 'entity' || target.status !== 'active' || !entities.has(target.id)) continue;
      bump(record.subjectId); bump(target.id);
      nodes.push({ id: record.id, record, kind: 'assertion', box: 'A', label, fullLabel: `${records[record.subjectId]?.name || ''} —${label}→ ${target.name || ''}`, star: true, shape: 'bead', r: 3.6 });
      edges.push({ id: record.id, from: record.subjectId, to: target.id, record, label, kind: 'assertion',
        uncertain: Boolean(record.certainty && record.certainty !== 'confirmed'), unknownDate: !record.validity?.from });
    }
    for (const record of local) {
      if (record.kind === 'rule' && record.effect?.entityId && entities.has(record.effect.entityId)) {
        edges.push({ id: `rule:${record.id}`, from: record.id, to: record.effect.entityId, record,
          label: t('effect', '影响'), kind: 'rule' });
      }
      if (record.kind === 'reference' && record.targetRecordId && entities.has(record.targetRecordId)) {
        edges.push({ id: `ref:${record.id}`, from: record.id, to: record.targetRecordId, record,
          label: t('reference', '引用'), kind: 'reference' });
      }
    }
    nodes.forEach(node => {
      if (node.kind === 'entity') node.r = starClamp(11 + (degree.get(node.id) || 0), 11, 20);
      if (node.kind === 'attribute') node.anchorId = node.record.subjectId;
    });
    nodes.sort(compare); edges.sort(compare);
    return { nodes, edges, literalFacts };
  }

  function starTrimEdge(edge, positions, byId) {
    const a = positions.get(edge.from), b = positions.get(edge.to);
    if (!a || !b) return null;
    if (edge.from === edge.to) {
      return { start: { x: a.x - 18, y: a.y - 12 }, control: { x: a.x, y: a.y - 64 }, end: { x: a.x + 18, y: a.y - 12 } };
    }
    const dx = b.x - a.x, dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    const bend = (8 + hash(edge.id) % 13) * (hash(edge.id) % 2 === 0 ? 1 : -1);
    const control = { x: (a.x + b.x) / 2 - (dy / length) * bend, y: (a.y + b.y) / 2 + (dx / length) * bend };
    const toward = (point, target, radius) => {
      const distance = Math.hypot(target.x - point.x, target.y - point.y) || 1;
      return { x: point.x + (target.x - point.x) / distance * radius, y: point.y + (target.y - point.y) / distance * radius };
    };
    return {
      start: toward(a, control, (byId.get(edge.from)?.r || 0) + 2),
      control,
      end: toward(b, control, (byId.get(edge.to)?.r || 0) + 2),
    };
  }

  function starBeadPoint(edge, positions, byId) {
    const trim = starTrimEdge(edge, positions, byId);
    if (!trim) return null;
    const t = starClamp(.5 + ((hash(edge.id) % 5) - 2) * .14, .22, .78);
    const mt = 1 - t;
    return {
      x: mt * mt * trim.start.x + 2 * mt * t * trim.control.x + t * t * trim.end.x,
      y: mt * mt * trim.start.y + 2 * mt * t * trim.control.y + t * t * trim.end.y,
    };
  }

  function starLayout(projected, focusId, saved) {
    const nodes = projected.nodes;
    const byId = new Map(nodes.map(node => [node.id, node]));
    const positions = new Map();
    const degree = node => projected.edges.filter(edge => edge.from === node.id || edge.to === node.id).length;
    let center = byId.get(focusId);
    if (!center) center = nodes.filter(node => node.kind === 'entity').sort((a, b) => degree(b) - degree(a) || compare(a, b))[0] || nodes[0];
    if (!center) return { positions, centerId: '' };
    center.r = center.kind === 'entity' ? 26 : 24;
    center.isCenter = true;
    const centerPosition = saved.get(center.id) || { x: STAR.centerX, y: STAR.centerY };
    positions.set(center.id, centerPosition);

    const ringOf = (list, radius, startAngle, offset) => {
      const count = list.length;
      list.forEach((node, index) => {
        const step = count ? Math.PI * 2 / count : Math.PI * 2;
        const jitter = (hash(node.id) / 0xffffffff - .5) * step * .12;
        const angle = startAngle + index * step + jitter;
        positions.set(node.id, saved.get(node.id) || {
          x: centerPosition.x + Math.cos(angle) * radius.x,
          y: centerPosition.y + Math.sin(angle) * radius.y,
        });
      });
    };

    const entities = nodes.filter(node => node.kind === 'entity' && node.id !== center.id)
      .sort((a, b) => degree(b) - degree(a) || compare(a, b));
    ringOf(entities, STAR.entity, -Math.PI / 2, 0);
    const definitions = nodes.filter(node => node.kind === 'definition').sort(compare);
    ringOf(definitions, STAR.halo, -Math.PI / 2 + .22, 0);
    const rules = nodes.filter(node => node.kind === 'rule').sort(compare);
    const ruleAngles = rules.length > 6 ? [Math.PI * .18, Math.PI * .78] : [Math.PI * .32, Math.PI * .68];
    rules.forEach((node, index) => {
      const angle = ruleAngles[0] + (rules.length <= 1 ? .5 : index / Math.max(1, rules.length - 1)) * (ruleAngles[1] - ruleAngles[0]);
      positions.set(node.id, saved.get(node.id) || { x: centerPosition.x + Math.cos(angle) * STAR.outer.x, y: centerPosition.y + Math.sin(angle) * STAR.outer.y });
    });
    const references = nodes.filter(node => node.kind === 'reference').sort(compare);
    references.forEach((node, index) => {
      const angle = Math.PI * 1.12 + (index + .5) * (Math.PI * .7 / Math.max(1, references.length));
      positions.set(node.id, saved.get(node.id) || { x: centerPosition.x + Math.cos(angle) * STAR.outer.x, y: centerPosition.y + Math.sin(angle) * STAR.outer.y });
    });

    const attributeCount = new Map();
    nodes.filter(node => node.kind === 'attribute').sort(compare).forEach(node => {
      const subject = positions.get(node.anchorId);
      if (!subject) return;
      const count = attributeCount.get(node.anchorId) || 0;
      attributeCount.set(node.anchorId, count + 1);
      const base = Math.atan2(subject.y - centerPosition.y, subject.x - centerPosition.x);
      const angle = base + (count - .5) * .45;
      node.attributeAngle = angle;
      positions.set(node.id, { x: subject.x + Math.cos(angle) * 17, y: subject.y + Math.sin(angle) * 17 });
    });

    const assertionEdges = new Map(projected.edges.filter(edge => edge.kind === 'assertion').map(edge => [edge.id, edge]));
    for (const node of nodes) {
      if (node.kind !== 'assertion') continue;
      const edge = assertionEdges.get(node.id);
      const point = edge ? starBeadPoint(edge, positions, byId) : null;
      if (point) positions.set(node.id, point);
    }

    const placedLabels = [];
    const centerSize = 14;
    const centerWidth = starTextWidth(center.label, centerSize);
    const centerLabelY = centerPosition.y + center.r + 18;
    center.labelText = center.label;
    center.labelVisible = true;
    center.labelSize = centerSize;
    center.labelWidth = centerWidth;
    center.labelHeight = 18;
    center.labelX = centerPosition.x;
    center.labelY = centerLabelY;
    center.labelDx = 0;
    center.labelDy = center.r + 18;
    placedLabels.push({ x: centerPosition.x - centerWidth / 2, y: centerLabelY - 9, width: centerWidth, height: 18 });
    const nodeBoxes = nodes.filter(node => positions.get(node.id)).map(node => {
      const point = positions.get(node.id);
      return { x: point.x, y: point.y, r: (node.r || 4) + 4 };
    });
    const placeLabel = (node, size, chip) => {
      const position = positions.get(node.id);
      if (!position) return;
      const text = node.label;
      const width = starTextWidth(text, size) + (chip ? 10 : 4);
      const height = chip ? 16 : 12;
      const gap = node.r + 10;
      const candidates = [
        { x: position.x - width / 2, y: position.y + gap, width, height },
        { x: position.x - width / 2, y: position.y - gap - height, width, height },
        { x: position.x + gap, y: position.y - height / 2, width, height },
        { x: position.x - gap - width, y: position.y - height / 2, width, height },
      ];
      const chosen = candidates.find(box => !nodeBoxes.some(other =>
        box.x - other.r < other.x && other.x < box.x + box.width + other.r
        && box.y - other.r < other.y && other.y < box.y + box.height + other.r)
        && !placedLabels.some(other => !(box.x + box.width < other.x - 2 || box.x > other.x + other.width + 2
          || box.y + box.height < other.y - 2 || box.y > other.y + other.height + 2)));
      if (!chosen) { node.labelVisible = false; return; }
      node.labelText = text;
      node.labelSize = size;
      node.labelChip = chip;
      node.labelWidth = width;
      node.labelHeight = height;
      node.labelX = chosen.x + width / 2;
      node.labelY = chosen.y + height / 2;
      node.labelVisible = true;
      placedLabels.push(chosen);
    };
    for (const kind of ['entity', 'definition', 'rule', 'reference']) {
      for (const node of nodes) {
        if (node.kind !== kind || node.id === center.id) continue;
        placeLabel(node, kind === 'entity' ? 9.5 : 8, kind === 'entity');
      }
    }
    return { positions, centerId: center.id };
  }

  function visibleStar(projected, focusId, lens) {
    const eligible = projected.nodes.filter(node => starMatchesLens(node, lens));
    if (!eligible.length) return { nodes: [], edges: [], hidden: 0, focusId: '' };
    let focus = eligible.find(node => node.id === focusId)
      || eligible.filter(node => node.kind === 'entity').sort((a, b) => (b.r || 0) - (a.r || 0) || compare(a, b))[0]
      || eligible[0];
    if (eligible.length <= STAR.limit) {
      const ids = new Set(eligible.map(node => node.id));
      return { nodes: eligible, edges: projected.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)), hidden: 0, focusId: focus.id };
    }
    const selected = new Set([focus.id]);
    const counts = { entity: 1, assertion: 0, definition: 0, rule: 0, reference: 0, attribute: 0 };
    const ordered = eligible.filter(node => node.id !== focus.id).sort((a, b) => {
      const kindOrder = { entity: 0, assertion: 1, definition: 2, rule: 3, reference: 4, attribute: 5 };
      return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9) || compare(a, b);
    });
    for (const node of ordered) {
      if (selected.size >= STAR.limit) break;
      if (counts[node.kind] >= (STAR_CAPS[node.kind] || 0)) continue;
      selected.add(node.id); counts[node.kind] = (counts[node.kind] || 0) + 1;
    }
    return {
      nodes: eligible.filter(node => selected.has(node.id)),
      edges: projected.edges.filter(edge => selected.has(edge.from) && selected.has(edge.to)),
      hidden: eligible.length - selected.size,
      focusId: focus.id,
    };
  }

  function readingPoints(module) {
    const points = Array.isArray(module?.summaryPoints) ? module.summaryPoints : [];
    return points.slice(0, 5).map((point, index) => ({
      id: `reading-${index}`,
      text: String(point?.text || '').trim(),
      evidenceIds: Array.isArray(point?.evidenceIds) ? point.evidenceIds.filter(Boolean) : [],
    })).filter(point => point.text);
  }

  function mount(container, options) {
    if (!container || !options?.doc) throw new Error('Ontology graph requires a container and document');
    let current = { ...options }, destroyed = false, projected, shown;
    let routes = new Map(), routeKey = "";
    let layoutFocus = '';
    let selection = null, collapsed = true, focusId = '', lens = 'all', neighborhood = 1, scale = 1, pan = { x: 0, y: 0 }, drag = null;
    let readingIndex = -1, hovered = '', expandedInspectorId = '';
    if (options.initialSelection && ['node', 'edge'].includes(options.initialSelection.kind) && options.initialSelection.id) {
      selection = { kind: options.initialSelection.kind, id: String(options.initialSelection.id) };
      collapsed = false;
    }
    const saved = new Map(), text = (key, fallback, vars) => typeof current.text === 'function' ? current.text(key, fallback, vars) : fallback;
    const read = id => current.doc?.records?.[id];
    const button = (label, className, attrs, role = 'secondary') => root.uiButton({ label, role, className, attrs });
    function projection() {
      if (!current.prototype) return project(current.doc, current.moduleId || '', current.at || today());
      if (!current.moduleId) {
        const records = Object.values(current.doc?.records || {});
        const nodes = records.filter(record => record.kind === 'module').sort(compare).map(record => ({ id: record.id, record, label: displayModuleName(record.name), fullLabel: record.name, kind: 'module' }));
        const ids = new Set(nodes.map(node => node.id));
        const edges = records.filter(record => record.kind === 'reference' && record.status === 'active' && ids.has(record.moduleId) && ids.has(record.targetModuleId)).map(record => ({ id: record.id, from: record.moduleId, to: record.targetModuleId, record, label: text('reference', '引用'), kind: 'reference' }));
        return { nodes, edges, literalFacts: new Map() };
      }
      return starProject(current.doc, current.moduleId, current.at || today(), text);
    }
    const matchesLens = (node, value) => value === 'all' || node.box === value || (value === 'R' && node.kind === 'definition' && (node.record.cardinality || node.record.subjectTypes?.length || node.record.objectTypes?.length));
    function visibleSemantic(model) {
      if (!current.prototype || !current.moduleId) return visibleProjection(model, focusId);
      const result = visibleStar(model, focusId, lens);
      if (result.focusId) focusId = result.focusId;
      return { nodes: result.nodes, edges: result.edges, hidden: result.hidden };
    }
    const nodeLabelMarkup = value => {
      const lines = []; let line = '', units = 0;
      const tokens = String(value || '').match(/[A-Za-z0-9_-]+|\s+|[^\s]/gu) || [];
      for (const token of tokens) {
        const parts = token.length > 12 ? token.match(/.{1,12}/gu) : [token];
        for (const part of parts) {
          const width = [...part].reduce((sum, character) => sum + (/[\u2e80-\uffff]/.test(character) ? 2 : 1), 0);
          if (units + width > 12 && line) { lines.push(line.trim()); line = ''; units = 0; }
          if (!line && !part.trim()) continue;
          line += part; units += width;
        }
      }
      if (line) lines.push(line);
      const shown = lines.slice(0, 3);
      if (lines.length > 3) shown[2] = shown[2].slice(0, -1) + '…';
      return shown.map((part, index) => `<tspan x="0" y="${(index - (shown.length - 1) / 2) * 16}">${escapeHtml(part)}</tspan>`).join('');
    };
    const relationLabel = edge => edge.labelKey ? text(edge.labelKey, edge.label) : edge.label;
    const edgeLabel = edge => `${short(relationLabel(edge))}${edge.unknownDate ? ` ${text('graphTimeUnknownShort', '时?')}` : ''}${edge.certainty === 'inferred' ? ` ${text('graphInferredShort', '推')}` : edge.certainty === 'unknown' ? ` ${text('graphCertaintyUnknownShort', '未?')}` : ''}`;
    function routeGeometry() {
      const key = shown.nodes.map(node => { const p = saved.get(node.id); return `${node.id}:${p.x},${p.y}`; }).join('|')
        + shown.edges.map(edge => `${edge.id}:${edge.from}:${edge.to}:${edgeLabel(edge)}`).join('|');
      if (key !== routeKey) { routes = edgeRoutes(shown.nodes, shown.edges, saved, edgeLabel); routeKey = key; }
    }

    const isStar = () => Boolean(current.prototype && current.moduleId);
    const starById = () => new Map(shown.nodes.map(node => [node.id, node]));

    function starPosition(node, byId) {
      if (node.kind === 'assertion') {
        const edge = shown.edges.find(item => item.id === node.id && item.kind === 'assertion');
        return edge ? starBeadPoint(edge, saved, byId) : null;
      }
      if (node.kind === 'attribute') {
        const subject = saved.get(node.anchorId);
        if (!subject) return null;
        const angle = node.attributeAngle == null ? 0 : node.attributeAngle;
        return { x: subject.x + Math.cos(angle) * 17, y: subject.y + Math.sin(angle) * 17 };
      }
      return saved.get(node.id) || null;
    }

    function starNodeMarkup(node) {
      const base = saved.get(node.id) || { x: 0, y: 0 };
      const lx = (node.labelX || 0) - base.x;
      const ly = (node.labelY || 0) - base.y;
      const chip = node.labelChip
        ? `<rect x="${(-node.labelWidth / 2).toFixed(1)}" y="${(-node.labelHeight / 2).toFixed(1)}" width="${node.labelWidth.toFixed(1)}" height="${node.labelHeight.toFixed(1)}" rx="4"/>`
        : '';
      const label = node.labelVisible && !node.isCenter && node.kind !== 'assertion' && node.kind !== 'attribute'
        ? `<g class="cog-og-star-label kind-${escapeHtml(node.kind)}${node.labelChip ? ' is-chip' : ' is-annotation'}" transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)})">${chip}<text x="0" y="0" text-anchor="middle" dominant-baseline="middle">${escapeHtml(node.labelText || node.label)}</text></g>`
        : '';
      const hit = `<circle class="cog-og-node-hit" r="${Math.max(10, node.r + 4)}"/>`;
      let shape = '';
      if (node.shape === 'disc') shape = `<circle class="cog-og-node-soft" r="${node.r + 4}"/><circle class="cog-og-node-main" r="${node.r}"/>`;
      else if (node.shape === 'ring') shape = `<circle class="cog-og-node-ring" r="${node.r}"/>`;
      else if (node.shape === 'rule') shape = `<circle class="cog-og-node-rule" r="${node.r}"/>`;
      else if (node.shape === 'portal') shape = `<circle class="cog-og-node-portal" r="${node.r}"/>`;
      else if (node.shape === 'bead') shape = `<circle class="cog-og-node-bead" r="${node.r}"/>`;
      else shape = '<rect class="cog-og-node-square" x="-3" y="-3" width="6" height="6" transform="rotate(45)"/>';
      return `<g class="cog-og-node cog-og-node--${escapeHtml(node.kind)}${node.isCenter ? ' is-center is-focus' : ''}${node.referenced ? ' is-referenced' : ''}" data-og-node="${escapeHtml(node.id)}" tabindex="0" role="button" aria-label="${escapeHtml(node.fullLabel || node.label)}" transform="translate(${base.x} ${base.y})">${hit}${shape}${label}</g>`;
    }

    function starEdgeMarkup(edge) {
      return `<g class="cog-og-edge cog-og-edge--${escapeHtml(edge.kind)}${edge.uncertain ? ' is-uncertain' : ''}" data-og-edge="${escapeHtml(edge.id)}" tabindex="0" role="button" aria-label="${escapeHtml(edgeLabel(edge))}"><path class="cog-og-edge-hit"/><path class="cog-og-edge-line"/></g>`;
    }

    function starLegendMarkup() {
      const groups = new Map();
      shown.edges.filter(edge => edge.kind === 'assertion').forEach(edge => {
        const key = relationLabel(edge);
        groups.set(key, (groups.get(key) || 0) + 1);
      });
      const items = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([label, count]) => `<span class="cog-og-star-legend-item"><i></i>${escapeHtml(short(label))} <b>${count}</b></span>`);
      const rules = shown.nodes.filter(node => node.kind === 'rule').length;
      const definitions = shown.nodes.filter(node => node.kind === 'definition').length;
      const references = shown.nodes.filter(node => node.kind === 'reference').length;
      const facts = shown.nodes.filter(node => node.kind === 'assertion' || node.kind === 'attribute').length;
      if (rules) items.push(`<span class="cog-og-star-legend-item"><i class="is-rule"></i>${escapeHtml(text('graphRulesLegend', '规则 / 约束'))} <b>${rules}</b></span>`);
      if (definitions) items.push(`<span class="cog-og-star-legend-item"><i class="is-definition"></i>${escapeHtml(text('concepts', '概念'))} <b>${definitions}</b></span>`);
      if (references) items.push(`<span class="cog-og-star-legend-item"><i class="is-reference"></i>${escapeHtml(text('reference', '引用'))} <b>${references}</b></span>`);
      if (facts) items.push(`<span class="cog-og-star-legend-item"><i class="is-fact"></i>${escapeHtml(text('facts', '事实'))} <b>${facts}</b></span>`);
      if (!items.length) return '';
      return `${root.uiButton({ label: text('graphLegend', '图例'), role: 'ghost', size: 'sm', className: 'cog-og-star-legend-btn', attrs: { 'data-og-legend': '', 'aria-expanded': 'false' } })}<div class="cog-og-star-legend" data-og-legend-pop hidden>${items.join('')}</div>`;
    }

    function readingMarkup() {
      const points = readingPoints(read(current.moduleId));
      if (!points.length) return '';
      const chips = points.map((point, index) => root.uiButton({
        label: String(index + 1).padStart(2, '0'), role: 'ghost', size: 'sm',
        className: `cog-og-reading-chip${readingIndex === index ? ' is-active' : ''}`,
        attrs: { 'data-og-reading': String(index), title: point.text, 'aria-label': point.text, 'aria-pressed': String(readingIndex === index) },
      })).join('');
      const all = root.uiButton({
        label: text('graphReadingAll', '全图'), role: 'ghost', size: 'sm',
        className: `cog-og-reading-chip${readingIndex < 0 ? ' is-active' : ''}`,
        attrs: { 'data-og-reading': 'all', 'aria-pressed': String(readingIndex < 0) },
      });
      return `<div class="cog-og-star-chips" aria-label="${escapeHtml(text('graphReadingPath', '阅读路径'))}"><span class="cog-og-star-chips-label">${escapeHtml(text('graphReadingPath', '阅读路径'))}</span>${chips}${all}</div>`;
    }

    function graphCanvas(className, label, body) {
      const owner = container.ownerDocument || document;
      const node = owner.createElementNS('http://www.w3.org/2000/svg', 'svg');
      node.setAttribute('class', className);
      node.setAttribute('role', 'group');
      node.setAttribute('aria-label', label);
      node.setAttribute('viewBox', '0 0 900 560');
      node.innerHTML = body;
      return node.outerHTML;
    }

    function starCanvasMarkup() {
      const center = shown.nodes.find(node => node.isCenter && node.labelVisible !== false);
      const centerLabel = center
        ? `<text class="cog-og-star-center-label" data-og-center-label="${escapeHtml(center.id)}" x="${center.labelX}" y="${center.labelY}" text-anchor="middle" dominant-baseline="middle" aria-hidden="true">${escapeHtml(center.label)}</text>`
        : '';
      return `<div class="cog-og-star-stage"><div class="cog-og-star-view">${readingMarkup()}${graphCanvas('cog-og-canvas cog-og-star-canvas', text('moduleGraph', '本体关系图谱'), `<defs><marker id="cog-og-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z"/></marker></defs><g class="cog-og-world">${shown.edges.map(starEdgeMarkup).join('')}${shown.nodes.map(starNodeMarkup).join('')}${centerLabel}</g>`)}${starLegendMarkup()}<div class="cog-og-star-tip" data-og-star-tip hidden></div><aside class="cog-og-inspector" aria-label="${escapeHtml(text('graphDetails', '所选内容'))}"></aside></div><div class="cog-og-star-caption" data-og-star-caption role="status" aria-live="polite" hidden></div></div>`;
    }

    function legacyCanvasMarkup() {
      return graphCanvas('cog-og-canvas', text('moduleGraph', '本体关系图谱'), `<defs><marker id="cog-og-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8 Z"/></marker></defs><g class="cog-og-world">${shown.edges.map(edge => `<g class="cog-og-edge cog-og-edge--${escapeHtml(edge.kind)}${edge.uncertain ? ' is-uncertain' : ''}" data-og-edge="${escapeHtml(edge.id)}" tabindex="0" role="button" aria-label="${escapeHtml(edgeLabel(edge))}"><path marker-end="url(#cog-og-arrow)"/><g class="cog-og-edge-label"><rect x="-55" y="-13" width="110" height="26" rx="5"/><text text-anchor="middle" dominant-baseline="middle">${escapeHtml(edgeLabel(edge))}</text></g></g>`).join('')}${shown.nodes.map(node => `<g class="cog-og-node cog-og-node--${escapeHtml(node.kind)}${node.referenced ? ' is-referenced' : ''}${current.prototype && node.id === focusId ? ' is-focus' : ''}" data-og-node="${escapeHtml(node.id)}" tabindex="0" role="button" aria-label="${escapeHtml(node.fullLabel || node.label)}"><circle r="48"/><text text-anchor="middle" dominant-baseline="middle">${nodeLabelMarkup(node.label)}</text>${current.prototype ? `<text class="ont-graph-node-kind" y="65" text-anchor="middle">${escapeHtml(nodeSubtitle(node, text))}</text>` : ''}</g>`).join('')}</g>`);
    }

    function setReading(index) {
      const points = readingPoints(read(current.moduleId));
      readingIndex = index >= 0 && index < points.length ? index : -1;
      container.querySelectorAll('[data-og-reading]').forEach(button => {
        if (button.classList.contains('cog-og-star-caption-close')) return;
        const value = button.dataset.ogReading;
        const active = value === 'all' ? readingIndex < 0 : Number(value) === readingIndex;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      applyReading();
    }

    function applyReading() {
      const world = container.querySelector('.cog-og-world');
      const caption = container.querySelector('[data-og-star-caption]');
      if (!world) return;
      const points = readingPoints(read(current.moduleId));
      if (readingIndex < 0 || readingIndex >= points.length) {
        world.classList.remove('is-reading');
        container.querySelectorAll('.is-evidence').forEach(element => element.classList.remove('is-evidence'));
        if (caption) caption.hidden = true;
        return;
      }
      const point = points[readingIndex];
      const evidence = new Set(point.evidenceIds);
      const byId = starById();
      shown.edges.forEach(edge => {
        if (evidence.has(edge.id) || evidence.has(edge.record?.id)) {
          evidence.add(edge.id); evidence.add(edge.from); evidence.add(edge.to);
        }
      });
      if (byId.has(focusId)) evidence.add(focusId);
      world.classList.add('is-reading');
      container.querySelectorAll('[data-og-node]').forEach(element => {
        element.classList.toggle('is-evidence', evidence.has(element.dataset.ogNode));
      });
      container.querySelectorAll('[data-og-edge]').forEach(element => {
        element.classList.toggle('is-evidence', evidence.has(element.dataset.ogEdge));
      });
      if (caption) {
        caption.innerHTML = `<div class="cog-og-star-caption-body"><b>${escapeHtml(text('conclusionsTitle', '结论'))} ${String(readingIndex + 1).padStart(2, '0')} / ${String(points.length).padStart(2, '0')}</b><p>${escapeHtml(point.text)}</p><small>${escapeHtml(text('graphReadingEvidence', '{n} 条依据', { n: point.evidenceIds.length }))}</small></div>${root.uiButton({ label: '×', role: 'ghost', size: 'sm', className: 'cog-og-star-caption-close', attrs: { 'data-og-reading': 'all', 'aria-label': text('graphReadingAll', '全图') } })}`;
        caption.hidden = false;
      }
    }

    function paintStar() {
      const world = container.querySelector('.cog-og-world');
      if (!world) return;
      world.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${scale})`);
      const byId = starById();
      const nodeElements = new Map([...container.querySelectorAll('[data-og-node]')].map(element => [element.dataset.ogNode, element]));
      const edgeElements = new Map([...container.querySelectorAll('[data-og-edge]')].map(element => [element.dataset.ogEdge, element]));
      for (const node of shown.nodes) {
        const position = starPosition(node, byId);
        const element = nodeElements.get(node.id);
        if (element && position) element.setAttribute('transform', `translate(${position.x} ${position.y})`);
        element?.classList.toggle('is-selected', selection?.kind === 'node' && selection.id === node.id);
      }
      const centerNode = shown.nodes.find(node => node.isCenter);
      const centerLabel = container.querySelector('[data-og-center-label]');
      if (centerNode && centerLabel) {
        const position = saved.get(centerNode.id);
        if (position) {
          centerLabel.setAttribute('x', String(position.x + (centerNode.labelDx || 0)));
          centerLabel.setAttribute('y', String(position.y + (centerNode.labelDy || 0)));
        }
      }
      for (const edge of shown.edges) {
        const element = edgeElements.get(edge.id);
        const geometry = starTrimEdge(edge, saved, byId);
        if (!element || !geometry) continue;
        const path = `M${geometry.start.x},${geometry.start.y} Q${geometry.control.x},${geometry.control.y} ${geometry.end.x},${geometry.end.y}`;
        element.querySelector('.cog-og-edge-line')?.setAttribute('d', path);
        element.querySelector('.cog-og-edge-hit')?.setAttribute('d', path);
        const selected = selection?.kind === 'edge' && selection.id === edge.id;
        element.classList.toggle('is-selected', selected);
        const line = element.querySelector('.cog-og-edge-line');
        if (line) {
          if (selected) line.setAttribute('marker-end', 'url(#cog-og-arrow)');
          else line.removeAttribute('marker-end');
        }
      }
      const zoom = container.querySelector('[data-og-zoom-value]');
      if (zoom) zoom.textContent = `${Math.round(scale * 100)}%`;
    }

    function starFit() {
      const svg = container.querySelector('.cog-og-canvas');
      if (!svg || !shown.nodes.length) return;
      const bounds = svg.getBoundingClientRect();
      if (bounds.width < 160 || bounds.height < 120) return;
      const byId = starById();
      const values = [];
      shown.nodes.forEach(node => {
        const position = starPosition(node, byId);
        if (!position) return;
        const pad = node.isCenter ? 42 : node.kind === 'entity' ? node.r + 34 : node.kind === 'definition' ? node.r + 22 : node.kind === 'assertion' || node.kind === 'attribute' ? 10 : node.r + 26;
        values.push({ x: position.x - pad, y: position.y - pad }, { x: position.x + pad, y: position.y + pad });
        if (node.labelVisible && node.labelWidth) {
          values.push({ x: node.labelX - node.labelWidth / 2, y: node.labelY - node.labelHeight / 2 });
          values.push({ x: node.labelX + node.labelWidth / 2, y: node.labelY + node.labelHeight / 2 });
        }
      });
      if (!values.length) return;
      const left = Math.min(...values.map(point => point.x)) - 24, right = Math.max(...values.map(point => point.x)) + 24;
      const top = Math.min(...values.map(point => point.y)) - 24, bottom = Math.max(...values.map(point => point.y)) + 24;
      const chips = container.querySelector('.cog-og-star-chips');
      const topInset = Math.max(52, (chips?.getBoundingClientRect().height || 0) + 20);
      const sideInset = 24, bottomInset = 24;
      const availableWidth = Math.max(1, bounds.width - sideInset * 2);
      const availableHeight = Math.max(1, bounds.height - topInset - bottomInset);
      const fitted = Math.min(1.6, Math.max(.08, Math.min(availableWidth / (right - left), availableHeight / (bottom - top))));
      scale = fitted;
      pan = {
        x: sideInset + availableWidth / 2 - (left + right) / 2 * scale,
        y: topInset + availableHeight / 2 - (top + bottom) / 2 * scale,
      };
      svg.setAttribute('viewBox', `0 0 ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`);
      paintStar();
    }

    function paint() {
      if (isStar()) { paintStar(); return; }
      const world = container.querySelector('.cog-og-world');
      if (!world) return;
      world.setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${scale})`);
      const nodeElements = new Map([...container.querySelectorAll('[data-og-node]')].map(element => [element.dataset.ogNode, element]));
      const edgeElements = new Map([...container.querySelectorAll('[data-og-edge]')].map(element => [element.dataset.ogEdge, element]));
      for (const node of shown.nodes) {
        const element = nodeElements.get(node.id);
        const position = saved.get(node.id);
        if (element && position) element.setAttribute('transform', `translate(${position.x} ${position.y})`);
        element?.classList.toggle('is-selected', selection?.kind === 'node' && selection.id === node.id);
      }
      routeGeometry();
      for (const edge of shown.edges) {
        const element = edgeElements.get(edge.id);
        const geometry = routes.get(edge.id);
        if (!element || !geometry) continue;
        element.querySelector('path')?.setAttribute('d', geometry.path);
        const rectangle = element.querySelector('.cog-og-edge-label rect');
        rectangle?.setAttribute('x', String(-geometry.width / 2));
        rectangle?.setAttribute('width', String(geometry.width));
        element.querySelector('.cog-og-edge-label')?.setAttribute('transform', `translate(${geometry.x} ${geometry.y})`);
        element.classList.toggle('is-selected', selection?.kind === 'edge' && selection.id === edge.id);
      }
      const zoom = container.querySelector('[data-og-zoom-value]');
      if (zoom) zoom.textContent = `${Math.round(scale * 100)}%`;
    }
    function fit() {
      if (isStar()) { starFit(); return; }
      const svg = container.querySelector('.cog-og-canvas');
      if (!svg || !shown.nodes.length) return;
      const bounds = svg.getBoundingClientRect();
      routeGeometry();
      const values = [...shown.nodes.flatMap(node => { const p = saved.get(node.id); return [{ x: p.x - NODE_RADIUS, y: p.y - NODE_RADIUS }, { x: p.x + NODE_RADIUS, y: p.y + NODE_RADIUS }]; }), ...[...routes.values()].flatMap(box => [{ x: box.x - box.width / 2, y: box.y - box.height / 2 }, { x: box.x + box.width / 2, y: box.y + box.height / 2 }])];
      const left = Math.min(...values.map(p => p.x)) - 24, right = Math.max(...values.map(p => p.x)) + 24;
      const top = Math.min(...values.map(p => p.y)) - 24, bottom = Math.max(...values.map(p => p.y)) + 24;
      const fitted = Math.min(1, Math.max(.08, Math.min((bounds.width - 60) / (right - left), (bounds.height - 60) / (bottom - top))));
      scale = fitScale(fitted, !current.moduleId);
      pan = { x: bounds.width / 2 - (left + right) / 2 * scale, y: bounds.height / 2 - (top + bottom) / 2 * scale };
      svg.setAttribute('viewBox', `0 0 ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`);
      paint();
    }
    function source(record) {
      const details = [record?.source?.label || text('unknown', '来源未注明')];
      if (record?.source?.kind === 'legacy') details.push(text('legacy', '旧来源 · 只读'));
      else if (record?.status !== 'active') details.push(text('readOnly', '历史记录 · 只读'));
      return details.join(' · ');
    }
    function inspector() {
      const panel = container.querySelector('.cog-og-inspector');
      if (!panel) return;
      if (!selection) {
        panel.innerHTML = `<p class="cog-og-muted">${escapeHtml(text('graphSelectHint', '选择对象或关系查看详情。'))}</p>`;
        return;
      }
      const item = selection.kind === 'node' ? shown.nodes.find(node => node.id === selection.id) : shown.edges.find(edge => edge.id === selection.id);
      if (!item) { selection = null; inspector(); return; }
      const record = item.record, name = selection.kind === 'edge' ? relationLabel(item) : (item.fullLabel || item.label);
      const canEdit = !isStar() && editableRecord(current.doc?.records, record);
      const field = (key, value, tag = 'p') => canEdit
        ? `<${tag} contenteditable="true" role="textbox" aria-label="${escapeHtml(text(key, key))}" data-ontology-edit="${key}" data-record-id="${escapeHtml(record.id)}">${escapeHtml(value || '')}</${tag}>`
        : `<${tag}>${escapeHtml(value || '')}</${tag}>`;
      let body = '';
      if (selection.kind === 'node' && record.kind === 'entity') {
        const type = read(record.typeId);
        const facts = shown.edges.filter(edge => edge.kind === 'assertion' && (edge.from === record.id || edge.to === record.id));
        const literals = projected.literalFacts.get(record.id) || [];
        if (isStar()) {
          const expanded = expandedInspectorId === record.id;
          const total = facts.length + literals.length;
          const visibleFacts = expanded ? facts : facts.slice(0, 3);
          const visibleLiterals = expanded || total <= 3 ? literals : literals.slice(0, 1);
          const attributes = literals.length
            ? `<h4>${escapeHtml(text('attributes', '属性'))} ${literals.length}</h4>${visibleLiterals.map(fact => button(`${read(fact.definitionId)?.name || '属性'}：${fact.object.value}`, 'cog-og-detail-link', { 'data-og-related': fact.id, 'data-og-related-kind': 'assertion' }, 'ghost')).join('')}`
            : '';
          const factRows = visibleFacts.map(edge => button(`${read(edge.from)?.name || ''} → ${relationLabel(edge)} → ${read(edge.to)?.name || ''}`, 'cog-og-detail-link', { 'data-og-related': edge.id, 'data-og-related-kind': 'edge' }, 'ghost')).join('');
          const expand = total > 3
            ? button(expanded ? text('graphInspectorCollapse', '收起完整列表') : text('graphInspectorAll', '查看全部 {n} 条', { n: total }), 'cog-og-inspector-expand', { 'data-og-inspector-expand': record.id }, 'ghost')
            : '';
          body = `${field('description', record.description)}<p class="cog-og-muted">${escapeHtml(text('type', '类型'))}：${escapeHtml(type?.name || text('unknown', '未知'))}</p>`
            + (facts.length ? `<h4>${escapeHtml(text('relatedFacts', '相关事实'))} ${facts.length}</h4>${factRows}` : '')
            + attributes
            + expand
            + `<p class="cog-og-inspector-source">${escapeHtml(text('source', '来源'))} · ${escapeHtml(source(record))}</p>`
            + button(text('openDetails', '查看详情'), 'cog-og-open', { 'data-og-open': record.id, 'data-og-open-kind': record.kind }, 'primary');
        } else {
          body = `${field('description', record.description)}<p class="cog-og-muted">${escapeHtml(text('type', '类型'))}：${escapeHtml(type?.name || text('unknown', '未知'))}</p>`
            + (literals.length ? `<h4>${escapeHtml(text('attributes', '属性'))}</h4>${literals.map(fact => button(`${read(fact.definitionId)?.name || '属性'}：${fact.object.value}`, 'cog-og-detail-link', { 'data-og-related': fact.id, 'data-og-related-kind': 'assertion' }, 'ghost')).join('')}` : '')
            + (facts.length ? `<h4>${escapeHtml(text('relatedFacts', '相关事实'))}</h4>${facts.map(edge => button(`${read(edge.from)?.name || ''} → ${relationLabel(edge)} → ${read(edge.to)?.name || ''}`, 'cog-og-detail-link', { 'data-og-related': edge.id, 'data-og-related-kind': 'edge' }, 'ghost')).join('')}` : '');
        }
      } else if (record.kind === 'assertion') {
        const validity = record.validity || {};
        body = `<p>${escapeHtml(read(record.subjectId)?.name || '')} → ${escapeHtml(read(record.definitionId)?.name || '')} → ${escapeHtml(record.object.kind === 'entity' ? read(record.object.id)?.name || '' : record.object.value)}</p>`
          + `<p class="cog-og-muted">${escapeHtml(text('validity', '有效时间'))}：${escapeHtml(validity.from || text('unknownDate', '开始时间未确认'))} → ${escapeHtml(validity.until || text('ongoing', '持续有效'))}</p>`
          + (record.certainty && record.certainty !== 'confirmed' ? `<p class="cog-og-muted">${escapeHtml(text('certainty', '确定性'))}：${escapeHtml(text(record.certainty, record.certainty))}</p>` : '');
      } else if (record.kind === 'rule') {
        body = `${field('requirement', record.requirement)}<p class="cog-og-muted">${escapeHtml(text('strength', '强度'))}：${escapeHtml(text(record.strength, record.strength))}</p>`;
      } else if (record.kind === 'reference') {
        body = `<p>${escapeHtml(read(record.moduleId)?.name || '')} → ${escapeHtml(read(record.targetModuleId)?.name || '')}</p>`;
      } else body = record.description == null ? '' : field('description', record.description);
      const title = record.name == null ? `<h3>${escapeHtml(name)}</h3>` : field('name', record.name, 'h3');
      const closeInspector = button('×', 'cog-og-inspector-close', { 'data-og-inspector-close': '', 'aria-label': text('closeDetails', '关闭记录详情') }, 'ghost');
      const kindMarkup = kind => `<div class="cog-og-inspector-head"><div class="cog-og-inspector-kind">${escapeHtml(kind)}</div>${closeInspector}</div>`;
      if (isStar() && selection.kind === 'node' && record.kind === 'entity') {
        panel.innerHTML = `${kindMarkup(text('objects', '具体对象'))}<div class="cog-og-inspector-body">${title}${body}</div>`;
        return;
      }
      const moduleGraphButton = !isStar() && record.kind === 'module' && typeof current.onOpenModuleGraph === 'function'
        ? button(text('viewModuleGraph', '查看本体内关系图'), 'cog-og-open primary', { 'data-og-module-graph': record.id }, 'primary')
        : '';
      const bodyMarkup = `${title}${body}<h4>${escapeHtml(text('source', '来源'))}</h4><p class="cog-og-muted">${escapeHtml(source(record))}</p>`;
      const actions = `${moduleGraphButton}${current.prototype ? button(text('expandConnections', '展开邻近联系'), 'cog-og-open', { 'data-og-focus': record.id }) : ''}${button(text('openDetails', '查看详情'), 'cog-og-open', { 'data-og-open': record.id, 'data-og-open-kind': record.kind })}`;
      panel.innerHTML = isStar()
        ? `${kindMarkup(text(record.kind, record.kind))}<div class="cog-og-inspector-body">${bodyMarkup}${actions}</div>`
        : `${kindMarkup(text(record.kind, record.kind))}<div class="cog-og-inspector-body">${bodyMarkup}</div><div class="cog-og-inspector-actions">${actions}</div>`;
    }
    function render(preserveCamera = false) {
      projected = projection();
      shown = visibleSemantic(projected);
      const globalGraph = !current.moduleId;
      const star = isStar();
      if (selection && !shown.nodes.some(node => selection.kind === 'node' && node.id === selection.id)
        && !shown.edges.some(edge => selection.kind === 'edge' && edge.id === selection.id)) selection = null;
      if (!selection) collapsed = true;
      if (current.prototype && layoutFocus !== focusId) { saved.clear(); layoutFocus = focusId; }
      if (star) {
        const laidOut = starLayout(shown, focusId, saved);
        if (laidOut.centerId) focusId = laidOut.centerId;
        for (const node of shown.nodes) {
          const position = laidOut.positions.get(node.id);
          if (position && node.kind !== 'assertion') saved.set(node.id, position);
        }
      } else {
        const positions = positionsFor(shown.nodes, shown.edges, saved, globalGraph);
        if (current.prototype && current.moduleId && !saved.has(focusId)) {
          positions.set(focusId, { x: 450, y: 280 });
          const neighbors = shown.nodes.filter(node => node.id !== focusId);
          neighbors.forEach((node, index) => { const angle = -Math.PI / 2 + index * 2 * Math.PI / neighbors.length; positions.set(node.id, { x: 450 + 260 * Math.cos(angle), y: 280 + 185 * Math.sin(angle) }); });
        }
        for (const [id, position] of positions) saved.set(id, position);
      }
      if (star && !selection) { collapsed = true; expandedInspectorId = ''; }
      const count = `${shown.nodes.length}/${projected.nodes.length} ${text('nodes', '个节点')} · ${shown.edges.length}/${projected.edges.length} ${text('edges', '条关系')}`;
      const limit = shown.hidden
        ? `<div class="cog-og-limit" role="status">${escapeHtml(text('graphLimited', '图谱共 {total} 个节点，当前显示 {shown} 个；其余内容请在本体列表中查找。', { total: projected.nodes.length, shown: shown.nodes.length }))}</div>`
        : '';
      const lensMarkup = `<div class="ont-graph-lenses" aria-label="${escapeHtml(text('graphContents', '选择本体内容'))}">${[['all', text('all', '全部')], ['T', 'T · ' + text('concepts', '概念')], ['R', 'R · ' + text('graphRulesLegend', '规则 / 约束')], ['A', 'A · ' + text('graphObjectsLegend', '对象 / 断言')]].map(([value, label]) => root.uiButton({ label: label + (value === 'all' ? '' : ' ' + projected.nodes.filter(node => matchesLens(node, value)).length), role: 'ghost', size: 'sm', attrs: { 'data-og-lens': value, 'aria-pressed': String(lens === value) } })).join('')}</div>`;
      const focusMarkup = `<label class="cog-og-star-focus">${escapeHtml(text('focus', '聚焦'))}${root.uiSelect({ id: 'cog-og-focus', native: true, value: focusId, ariaLabel: text('chooseGraphFocus', '选择要聚焦的记录'), attrs: { 'data-og-center': '' }, options: projected.nodes.filter(node => matchesLens(node, lens)).map(node => ({ value: node.id, label: node.label })) })}</label>`;
      const overview = current.prototype && current.moduleId ? button(text('graphReturnOverview', '返回概览'), 'cog-og-control', { 'data-og-control': 'overview' }, 'ghost') : '';
      const zoomOut = button('−', 'cog-og-control', { 'data-og-control': 'out', 'aria-label': text('zoomOut', '缩小') }, 'ghost');
      const zoomIn = button('+', 'cog-og-control', { 'data-og-control': 'in', 'aria-label': text('zoomIn', '放大') }, 'ghost');
      const fitButton = button(text(current.prototype ? 'graphResetView' : 'zoomReset', current.prototype ? '重置视图' : '适应画面'), 'cog-og-control', { 'data-og-control': 'fit' }, 'ghost');
      const detailsButton = current.prototype ? '' : button(collapsed ? text('showDetails', '展开详情') : text('hideDetails', '收起详情'), 'cog-og-control', { 'data-og-control': 'details', 'aria-expanded': String(!collapsed) }, 'ghost');
      const controls = `${overview}${zoomOut}<span data-og-zoom-value></span>${zoomIn}${fitButton}${detailsButton}`;
      const legacyToolbar = `<div class="cog-og-toolbar"><span>${current.prototype ? `<strong>${escapeHtml(text(current.moduleId ? 'internalGraphTitle' : 'modulesGraphTitle', current.moduleId ? '本体内部图' : '本体间引用'))}</strong> <small>${escapeHtml(shown.nodes.find(node => node.id === focusId)?.label || count)} · ${escapeHtml(text('graphOverviewShort', '简图'))}</small>` : escapeHtml(count)}</span><div class="cog-og-toolbar-actions">${controls}</div></div>`;
      const navigator = !star && current.prototype && current.moduleId ? `<div class="ont-graph-navigator">${lensMarkup}${focusMarkup}</div>` : '';
      const entityCount = projected.nodes.filter(node => node.kind === 'entity').length;
      const factCount = projected.nodes.filter(node => node.kind === 'assertion' || node.kind === 'attribute').length;
      const starToolbar = star
        ? `<div class="cog-og-star-toolbar"><div class="cog-og-star-title"><b>${escapeHtml(text('graph', '关系图'))}</b><span>${entityCount} ${escapeHtml(text('objectsShort', '对象'))} · ${factCount} ${escapeHtml(text('facts', '事实'))}</span></div>${lensMarkup}${focusMarkup}<div class="cog-og-star-actions">${controls}</div></div>`
        : '';
      const toolbar = star ? starToolbar : legacyToolbar;
      const canvasMarkup = star ? starCanvasMarkup() : legacyCanvasMarkup();
      const inspectorAside = star ? '' : `<aside class="cog-og-inspector" aria-label="${escapeHtml(text('graphDetails', '所选内容'))}"></aside>`;
      container.innerHTML = `<div class="cog-og${globalGraph ? ' cog-og--global' : ''}${star ? ' cog-og--star' : ''}">${toolbar}${limit}${navigator}<div class="cog-og-body${collapsed ? ' is-collapsed' : ''}">${canvasMarkup}${inspectorAside}</div>${!shown.nodes.length ? `<p class="cog-og-empty">${escapeHtml(text('graphEmpty', '还没有可展示的关系。'))}</p>` : ''}</div>`;
      canvasObserver?.disconnect();
      const canvasElement = container.querySelector('.cog-og-canvas');
      if (canvasElement) canvasObserver?.observe(canvasElement);
      inspector();
      if (star) applyReading();
      if (preserveCamera) requestAnimationFrame(paint);
      else requestAnimationFrame(fit);
    }
    function select(kind, id) {
      hideStarTip();
      expandedInspectorId = '';
      selection = { kind, id }; collapsed = false;
      container.querySelector('.cog-og-body')?.classList.remove('is-collapsed');
      const details = container.querySelector('[data-og-control="details"]');
      if (details) { details.textContent = text('hideDetails', '收起详情'); details.setAttribute('aria-expanded', 'true'); }
      inspector(); if (isStar()) paint(); else fit();
      const item = kind === 'node' ? shown.nodes.find(node => node.id === id) : shown.edges.find(edge => edge.id === id);
      if (item?.record) current.onSelect?.({ recordId: item.record.id, kind: item.record.kind });
    }
    function pointer(event) {
      const svg = container.querySelector('.cog-og-canvas'), bounds = svg.getBoundingClientRect();
      return { x: (event.clientX - bounds.left) * svg.viewBox.baseVal.width / Math.max(1, bounds.width),
        y: (event.clientY - bounds.top) * svg.viewBox.baseVal.height / Math.max(1, bounds.height) };
    }
    function onPointerDown(event) {
      hideStarTip();
      if (event.button !== 0 || !event.target.closest('.cog-og-canvas')) return;
      const node = event.target.closest('[data-og-node]');
      if (event.target.closest('[data-og-edge]') && !node) return;
      drag = { id: node?.dataset.ogNode || '', start: pointer(event), origin: node ? { ...saved.get(node.dataset.ogNode) } : { ...pan }, moved: false, pointerId: event.pointerId };
      container.querySelector('.cog-og-canvas').setPointerCapture(event.pointerId);
    }
    function onPointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const now = pointer(event), dx = now.x - drag.start.x, dy = now.y - drag.start.y;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      if (drag.id) saved.set(drag.id, { x: drag.origin.x + dx / scale, y: drag.origin.y + dy / scale });
      else pan = { x: drag.origin.x + dx, y: drag.origin.y + dy };
      paint();
    }
    function onPointerUp(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const was = drag; drag = null;
      if (was.id && !was.moved) select('node', was.id);
    }
    function onClick(event) {
      const legendButton = event.target.closest('[data-og-legend]');
      if (legendButton) {
        const pop = container.querySelector('[data-og-legend-pop]');
        if (pop) {
          pop.hidden = !pop.hidden;
          legendButton.setAttribute('aria-expanded', String(!pop.hidden));
        }
        return;
      }
      const reading = event.target.closest('[data-og-reading]');
      if (reading) { const value = reading.dataset.ogReading; setReading(value === 'all' ? -1 : Number(value)); return; }
      const lensButton = event.target.closest('[data-og-lens]');
      if (lensButton) { lens = lensButton.dataset.ogLens; focusId = ''; neighborhood = 1; selection = null; readingIndex = -1; render(); return; }
      const focus = event.target.closest('[data-og-focus]');
      if (focus) { if (focusId === focus.dataset.ogFocus) neighborhood = Math.min(4, neighborhood + 1); else { focusId = focus.dataset.ogFocus; neighborhood = 1; } readingIndex = -1; render(); return; }
      const control = event.target.closest('[data-og-control]');
      if (control) {
        const action = control.dataset.ogControl;
        if (action === 'overview') { focusId = ''; neighborhood = 1; saved.clear(); selection = null; readingIndex = -1; collapsed = true; render(); fit(); return; }
        if (action === 'details') { collapsed = !collapsed; render(); }
        else if (action === 'fit') fit();
        else { scale = Math.max(.16, Math.min(3, scale * (action === 'in' ? 1.2 : 1 / 1.2))); paint(); }
        return;
      }
      const closeInspector = event.target.closest('[data-og-inspector-close]');
      if (closeInspector) {
        selection = null; collapsed = true; expandedInspectorId = '';
        container.querySelector('.cog-og-body')?.classList.add('is-collapsed');
        current.onInspectorClose?.();
        inspector(); if (isStar()) paint(); else fit();
        return;
      }
      const expandInspector = event.target.closest('[data-og-inspector-expand]');
      if (expandInspector) {
        const id = expandInspector.dataset.ogInspectorExpand;
        expandedInspectorId = expandedInspectorId === id ? '' : id;
        inspector();
        return;
      }
      const moduleGraph = event.target.closest('[data-og-module-graph]');
      if (moduleGraph) { current.onOpenModuleGraph?.(moduleGraph.dataset.ogModuleGraph); return; }
      const open = event.target.closest('[data-og-open]');
      if (open) { current.onSelect?.({ recordId: open.dataset.ogOpen, kind: open.dataset.ogOpenKind, open: true }); return; }
      const related = event.target.closest('[data-og-related]');
      if (related) {
        if (related.dataset.ogRelatedKind === 'edge') select('edge', related.dataset.ogRelated);
        else current.onSelect?.({ recordId: related.dataset.ogRelated, kind: 'assertion' });
        return;
      }
      const edge = event.target.closest('[data-og-edge]');
      if (edge) select('edge', edge.dataset.ogEdge);
    }
    function onKeyDown(event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest('[data-og-node],[data-og-edge]');
      if (!item) return;
      event.preventDefault();
      select(item.dataset.ogNode ? 'node' : 'edge', item.dataset.ogNode || item.dataset.ogEdge);
    }
    function onWheel(event) {
      if (!event.target.closest('.cog-og-canvas')) return;
      hideStarTip();
      event.preventDefault();
      const point = pointer(event);
      // Normalize wheel distance so a trackpad gesture does not apply a full step per event.
      const pixels = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY;
      const delta = Math.max(-120, Math.min(120, pixels));
      const next = Math.max(.16, Math.min(3, scale * Math.exp(-delta * .0006)));
      pan = { x: point.x - (point.x - pan.x) * next / scale, y: point.y - (point.y - pan.y) * next / scale };
      scale = next; paint();
    }
    function onCenterChange(event) { if (!event.target.matches('[data-og-center]')) return; focusId = event.target.value; neighborhood = 1; selection = null; readingIndex = -1; render(); }
    function onDocumentClick(event) {
      if (!isStar()) return;
      if (event.target.closest('[data-og-legend]') || event.target.closest('[data-og-legend-pop]')) return;
      const pop = container.querySelector('[data-og-legend-pop]');
      if (!pop || pop.hidden) return;
      pop.hidden = true;
      container.querySelector('[data-og-legend]')?.setAttribute('aria-expanded', 'false');
    }
    function starTipData(node) {
      const record = read(node.id);
      let main = node.fullLabel || node.label;
      if (node.kind === 'assertion') {
        const edge = shown.edges.find(item => item.id === node.id && item.kind === 'assertion');
        if (edge) main = `${read(edge.from)?.name || ''} → ${relationLabel(edge)} → ${read(edge.to)?.name || ''}`;
      } else if (node.kind === 'attribute') {
        main = [read(record?.subjectId)?.name, read(record?.definitionId)?.name || node.label, record?.object?.value].filter(Boolean).join(' · ');
      } else if (node.kind === 'reference') {
        const target = read(record?.targetModuleId)?.name;
        main = target ? `${text('reference', '引用')} · ${target}` : text('reference', '引用');
      }
      const kind = node.kind === 'entity' ? text('objects', '具体对象')
        : node.kind === 'definition' ? text('graphDefinitionKind', '概念 / 关系')
        : node.kind === 'rule' ? text('graphRulesLegend', '规则 / 约束')
        : node.kind === 'reference' ? text('reference', '引用')
        : node.kind === 'assertion' ? text('facts', '事实')
        : text('attributes', '属性');
      return { main, kind };
    }
    function showStarTip(id, element) {
      const tip = container.querySelector('[data-og-star-tip]');
      const node = shown.nodes.find(item => item.id === id);
      const hit = element?.querySelector('.cog-og-node-hit');
      const view = container.querySelector('.cog-og-star-view');
      if (!tip || !node || !hit || !view) return;
      const data = starTipData(node);
      tip.innerHTML = `<b>${escapeHtml(data.main)}</b><span>${escapeHtml(data.kind)}</span>`;
      tip.hidden = false;
      const hitRect = hit.getBoundingClientRect(), viewRect = view.getBoundingClientRect();
      const width = tip.offsetWidth, height = tip.offsetHeight;
      let left = hitRect.left - viewRect.left + hitRect.width / 2 - width / 2;
      let top = hitRect.top - viewRect.top - height - 9;
      if (top < 8) top = hitRect.top - viewRect.top + hitRect.height + 9;
      tip.style.left = `${Math.max(8, Math.min(viewRect.width - width - 8, left))}px`;
      tip.style.top = `${Math.max(8, top)}px`;
    }
    function hideStarTip() {
      const tip = container.querySelector('[data-og-star-tip]');
      if (tip) tip.hidden = true;
    }
    function onPointerOver(event) {
      if (!isStar() || drag) return;
      const node = event.target.closest('[data-og-node]');
      if (!node) return;
      const prior = container.querySelector('.cog-og-node.is-hovered');
      if (prior && prior !== node) prior.classList.remove('is-hovered');
      node.classList.add('is-hovered');
      hovered = node.dataset.ogNode;
      showStarTip(node.dataset.ogNode, node);
    }
    function onPointerOut(event) {
      const node = event.target.closest('[data-og-node]');
      if (!node) return;
      if (event.relatedTarget && node.contains(event.relatedTarget)) return;
      node.classList.remove('is-hovered');
      if (hovered === node.dataset.ogNode) hovered = '';
      hideStarTip();
    }
    function onFocusIn(event) {
      if (!isStar()) return;
      const node = event.target.closest('[data-og-node]');
      if (!node) return;
      node.classList.add('is-hovered');
      showStarTip(node.dataset.ogNode, node);
    }
    function onFocusOut(event) {
      if (!isStar()) return;
      const node = event.target.closest('[data-og-node]');
      if (!node) return;
      node.classList.remove('is-hovered');
      hideStarTip();
    }
    container.addEventListener('change', onCenterChange);
    container.addEventListener('click', onClick);
    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerUp);
    container.addEventListener('pointerover', onPointerOver);
    container.addEventListener('pointerout', onPointerOut);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    container.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('click', onDocumentClick);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(container);
    const canvasObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (isStar()) fit(); }) : null;
    const controller = {
      update(next) {
        if (destroyed) return;
        const nextModule = next.moduleId === undefined ? current.moduleId : next.moduleId;
        const changedModule = nextModule !== current.moduleId;
        if (changedModule) { saved.clear(); selection = null; focusId = ''; readingIndex = -1; }
        const priorNodeIds = shown.nodes.map(node => node.id).join('\u0000');
        const priorEdgeIds = shown.edges.map(edge => edge.id).join('\u0000');
        const priorLabels = shown.nodes.map(node => `${node.id}:${node.label}`).join('\u0000');
        current = { ...current, ...next };
        const nextProjection = projection();
        const nextShown = visibleSemantic(nextProjection);
        const sameStructure = !changedModule && priorNodeIds === nextShown.nodes.map(node => node.id).join('\u0000')
          && priorEdgeIds === nextShown.edges.map(edge => edge.id).join('\u0000')
          && priorLabels === nextShown.nodes.map(node => `${node.id}:${node.label}`).join('\u0000');
        if (!sameStructure) { render(!changedModule); return; }
        projected = nextProjection; shown = nextShown;
        for (const node of shown.nodes) {
          const element = [...container.querySelectorAll('[data-og-node]')].find(item => item.dataset.ogNode === node.id);
          if (!element) continue;
          if (!isStar()) {
            const label = element.querySelector('text');
            if (label) label.innerHTML = nodeLabelMarkup(node.label);
          }
          element.setAttribute('aria-label', node.fullLabel || node.label);
        }
        for (const edge of shown.edges) {
          const element = [...container.querySelectorAll('[data-og-edge]')].find(item => item.dataset.ogEdge === edge.id);
          if (!element) continue;
          const label = element.querySelector('text');
          if (label) label.textContent = edgeLabel(edge);
          element.setAttribute('aria-label', edgeLabel(edge));
          element.classList.toggle('is-uncertain', Boolean(edge.uncertain));
        }
        if (!container.querySelector('[data-ontology-edit]:focus')) inspector();
        hideStarTip();
        paint();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true; observer?.disconnect();
        canvasObserver?.disconnect();
        container.removeEventListener('change', onCenterChange);
        container.removeEventListener('click', onClick);
        container.removeEventListener('keydown', onKeyDown);
        container.removeEventListener('pointerdown', onPointerDown);
        container.removeEventListener('pointermove', onPointerMove);
        container.removeEventListener('pointerup', onPointerUp);
        container.removeEventListener('pointercancel', onPointerUp);
        container.removeEventListener('pointerover', onPointerOver);
        container.removeEventListener('pointerout', onPointerOut);
        container.removeEventListener('focusin', onFocusIn);
        container.removeEventListener('focusout', onFocusOut);
        container.removeEventListener('wheel', onWheel);
        document.removeEventListener('click', onDocumentClick);
        container.replaceChildren();
      },
    };
    render();
    return controller;
  }

  let active = null;
  root.CogOntologyGraph = {
    mount(container, options) { active?.destroy(); active = mount(container, options); return active; },
    update(options) { active?.update(options); },
    destroy() { active?.destroy(); active = null; },
    _project: project, _visibleProjection: visibleProjection, _positionsFor: positionsFor, _edgeRoutes: edgeRoutes, _editableRecord: editableRecord, _today: today,
    _displayModuleName: displayModuleName, _nodeSubtitle: nodeSubtitle, _fitScale: fitScale,
    _starProject: starProject, _starLayout: starLayout, _visibleStar: visibleStar, _starTrimEdge: starTrimEdge, _starBeadPoint: starBeadPoint, _readingPoints: readingPoints,
  };
})(window);

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const paramsStart = source.indexOf('(', start + marker.length);
  if (paramsStart < 0) throw new Error(`missing params for ${name}`);
  let depth = 0;
  let bodyStart = -1;
  for (let i = paramsStart; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        bodyStart = source.indexOf('{', i + 1);
        break;
      }
    }
  }
  if (bodyStart < 0) throw new Error(`missing body for ${name}`);
  depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadHelpers() {
  const code = [
    extractFunction('_projectionIdsFromCitations'),
    extractFunction('_projectionReceiptForMessage'),
    extractFunction('_findProjectionSidecar'),
    extractFunction('_shouldSuppressProjectionTransportProse'),
  ].join('\n');
  const context: any = {
    CSS: { escape: (value: string) => value.replace(/"/g, '\\"') },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

describe('model-selected projection sidecar coalescing', () => {
  it('collects citation projection ids without duplicates', () => {
    const { _projectionIdsFromCitations } = loadHelpers();
    expect(_projectionIdsFromCitations([
      { projection_id: 'proj-a' },
      { projection_id: 'proj-b' },
      { projection_id: 'proj-a' },
      {},
    ])).toEqual(['proj-a', 'proj-b']);
  });

  it('finds the persisted sidecar DOM anchor for a final-reply citation', () => {
    const { _findProjectionSidecar } = loadHelpers();
    const sidecar = { hidden: false };
    const container = {
      querySelector(selector: string) {
        return selector.includes('proj-a') ? sidecar : null;
      },
    };
    expect(_findProjectionSidecar(container, {
      recall_citations: [{ projection_id: 'missing' }, { projection_id: 'proj-a' }],
    })).toEqual({ projectionId: 'proj-a', sidecar });
    expect(_findProjectionSidecar(container, {
      recall_citations: [{ projection_id: 'missing' }],
    })).toBeNull();
  });

  it('suppresses only standalone transport prose and keeps the final reply body', () => {
    const { _shouldSuppressProjectionTransportProse } = loadHelpers();
    const sidecar = { recall_projection_card: { projectionId: 'proj-a', authorization: 'model_selected' } };
    expect(_shouldSuppressProjectionTransportProse(sidecar, null)).toBe(true);
    expect(_shouldSuppressProjectionTransportProse({
      recall_citations: [{ projection_id: 'proj-a' }],
    }, sidecar)).toBe(false);
    expect(_shouldSuppressProjectionTransportProse({ content: 'normal reply' }, null)).toBe(false);
  });

  it('prefers the explicit final-message receipt and hides presentation sidecars', () => {
    expect(source).toContain('function _projectionReceiptForMessage');
    expect(source).toContain("message?.projection_receipt?.authorization === 'model_selected'");
    expect(source).toContain("message?.recall_projection_card?.presentation === 'sidecar'");
    expect(source).toContain('msgDiv.hidden = true;');
    expect(source).toContain("if (message.recall_projection_card) host.dataset.recallProjectionTransport = 'sidecar';");
    expect(source).toContain('const projectionCardForBubble = _projectionReceiptForMessage(message)');
  });

  it('accepts only model-selected final receipts', () => {
    const { _projectionReceiptForMessage } = loadHelpers();
    const receipt = { projectionId: 'proj-a', authorization: 'model_selected' };
    expect(_projectionReceiptForMessage({ projection_receipt: receipt })).toEqual(receipt);
    expect(_projectionReceiptForMessage({
      projection_receipt: { projectionId: 'proj-a', authorization: 'user_confirmed' },
    })).toBeNull();
    expect(_projectionReceiptForMessage({})).toBeNull();
  });

  it('renders one card on the final reply, replaces the citation footer, and hides the standalone reply', () => {
    expect(source).toContain('const coalescedProjectionMatch = role === \'assistant\'');
    expect(source).toContain('const coalescedProjectionSidecar = coalescedProjectionMatch?.sidecar || null');
    expect(source).toContain('_findProjectionSidecar(container, message)');
    expect(source).toContain("projectionId: coalescedProjectionMatch.projectionId");
    expect(source).toContain('const projectionCardForBubble = _projectionReceiptForMessage(message)');
    expect(source).toContain("const recallCitationsHtml = role === 'assistant' && !hasProjectionCard");
    expect(source).toContain('const contentHtml = suppressProjectionTransportProse');
    expect(source).toContain('coalescedProjectionSidecar.hidden = true;');
    expect(source).toContain('window.mountRecallProjectionCard(host, projectionCardForBubble, {');
    expect(source).toContain('if (message.recall_projection_card?.projectionId) {');
    expect(source).toContain('msgDiv.dataset.recallProjectionId');
  });
});

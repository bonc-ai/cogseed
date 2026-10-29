import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function escape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function button({ label, attrs }: { label: string; attrs?: Record<string, string> }): string {
  const renderedAttrs = Object.entries(attrs || {}).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
  return `<button class="ui-button"${renderedAttrs}>${escape(label)}</button>`;
}

const translations: Record<string, string> = {
  'chat.proposal_citation_open': '查看变更提议',
  'chat.ontology_citation_open': '查看本体依据',
};

type Replaced = { children: any[]; replaced: boolean };

function replaceMarker(fnName: string, marker: string, values: unknown[], insideCode = false): Replaced {
  const node: any = {
    nodeValue: marker,
    parentElement: { closest: (selector: string) => (insideCode && selector === 'pre, code' ? {} : null) },
    parentNode: { replaceChild: (fragment: any) => { result.children = fragment.children; result.replaced = true; } },
  };
  const result: Replaced = { children: [], replaced: false };
  let visited = false;
  const context: any = {
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1 },
    document: {
      createTreeWalker: () => ({
        currentNode: null as unknown,
        nextNode() {
          if (visited) return false;
          visited = true;
          this.currentNode = node;
          return true;
        },
      }),
      createDocumentFragment: () => ({
        children: [] as unknown[],
        appendChild(child: unknown) { this.children.push(child); },
      }),
      createTextNode: (text: string) => ({ kind: 'text', text }),
      createElement: (name: string) => {
        if (name !== 'template') throw new Error(`unexpected element ${name}`);
        let html = '';
        return {
          set innerHTML(value: string) { html = value; },
          content: { cloneNode: () => ({ kind: 'html', html }) },
        };
      },
    },
    t: (key: string) => translations[key] || key,
    uiButton: button,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(fnName)}\nthis.replaceMarker = ${fnName};`, context);
  context.replaceMarker({}, values);
  return result;
}

function renderedHtml(replaced: Replaced): string {
  return replaced.children
    .map((child: any) => (child.kind === 'text' ? child.text : child.html))
    .join('');
}

type CitationClickRun = {
  opened: unknown[][];
  loadedFeatures: string[];
  finishFeatureLoad: () => Promise<void>;
};

function clickCitation(
  markerComment: string,
  selector: string,
  dataset: Record<string, string>,
  openerName: string,
  options: { lazyOpener?: boolean } = {},
): CitationClickRun {
  const start = source.indexOf(markerComment);
  const end = source.indexOf('\n});', start);
  if (start < 0 || end < 0) throw new Error(`click handler not found: ${markerComment}`);
  const opened: unknown[][] = [];
  const loadedFeatures: string[] = [];
  let releaseFeatureLoad: () => void = () => {};
  const featureLoad = new Promise<void>((resolve) => { releaseFeatureLoad = resolve; });
  const mockWindow: any = {
    loadRendererFeature: (name: string) => {
      loadedFeatures.push(name);
      return featureLoad.then(() => {
        mockWindow[openerName] = (...args: unknown[]) => { opened.push(args); };
      });
    },
  };
  if (!options.lazyOpener) mockWindow[openerName] = (...args: unknown[]) => { opened.push(args); };
  let clickHandler: ((event: any) => void) | null = null;
  const context: any = {
    document: {
      addEventListener(type: string, handler: (event: any) => void) {
        if (type === 'click') clickHandler = handler;
      },
    },
    window: mockWindow,
  };
  vm.runInNewContext(source.slice(start, end + '\n});'.length), context);
  if (!clickHandler) throw new Error('click handler was not registered');
  clickHandler({
    target: {
      closest: (wanted: string) => (wanted === selector ? { dataset } : null),
    },
  });
  return {
    opened,
    loadedFeatures,
    finishFeatureLoad: async () => {
      releaseFeatureLoad();
      await featureLoad;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

type MarkdownRun = {
  markdown: string;
  proposalIds: string[] | null;
  ontologyRefs: unknown[] | null;
  candidateIds: string[] | null;
  refreshes: number;
};

function renderMessageMarkdown(text: string): MarkdownRun {
  const run: MarkdownRun = { markdown: '', proposalIds: null, ontologyRefs: null, candidateIds: null, refreshes: 0 };
  const context: any = {
    _skillsForDisplayNameRewrite: () => [],
    renderMarkdownFull: (input: string) => { run.markdown = input; return `<p>${input}</p>`; },
    _htmlMayContainKnownSkillIdForDisplay: () => false,
    _replaceKnownSkillIdsIn: () => {},
    _highlightMentionsIn: () => {},
    _replaceAssetCitationsIn: () => {},
    _replaceCandidateCitationsIn: (_tmp: unknown, ids: string[]) => { run.candidateIds = ids; },
    _replaceProposalCitationsIn: (_tmp: unknown, ids: string[]) => { run.proposalIds = ids; },
    _replaceOntologyCitationsIn: (_tmp: unknown, refs: unknown[]) => { run.ontologyRefs = refs; },
    document: { createElement: () => ({ innerHTML: '' }) },
    window: { ChatAssetApproval: { refreshVisible: () => { run.refreshes += 1; } } },
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction('_renderMessageMarkdown')}\nthis.render = _renderMessageMarkdown;`, context);
  context.render(text);
  return run;
}

describe('conversation proposal and ontology citations', () => {
  it('protects both markers through markdown and refreshes approval state after rendering', async () => {
    const run = renderMessageMarkdown('见 [proposal:ap-42] 与 [[ontology:personal/def-project@3]]，另 [candidate:cand-1]');
    // 原始标记必须先变占位符，否则 markdown/autolink 会把它们拆散。
    expect(run.markdown).toContain('\uE000PROPOSALREF0\uE001');
    expect(run.markdown).toContain('\uE000ONTOLOGYREF0\uE001');
    expect(run.markdown).not.toContain('[proposal:');
    expect(run.markdown).not.toContain('[[ontology:');
    expect(run.proposalIds).toEqual(['ap-42']);
    expect(run.ontologyRefs).toEqual([{ moduleId: 'personal', recordId: 'def-project', version: 3 }]);
    expect(run.candidateIds).toEqual(['cand-1']);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(run.refreshes).toBe(1);
  });

  it('turns a proposal placeholder into a button that names the governed decision', () => {
    const replaced = replaceMarker('_replaceProposalCitationsIn', '见 \uE000PROPOSALREF0\uE001', ['ap-42']);
    expect(replaced.replaced).toBe(true);
    expect(renderedHtml(replaced)).toContain('data-proposal-citation="ap-42"');
    expect(renderedHtml(replaced)).toContain('查看变更提议');
    expect(renderedHtml(replaced)).not.toContain('PROPOSALREF');
  });

  it('keeps the raw proposal marker inside code blocks', () => {
    const replaced = replaceMarker('_replaceProposalCitationsIn', '\uE000PROPOSALREF0\uE001', ['ap-42'], true);
    expect(renderedHtml(replaced)).toBe('[proposal:ap-42]');
    expect(renderedHtml(replaced)).not.toContain('<button');
  });

  it('turns an ontology placeholder into a version-pinned record button', () => {
    const replaced = replaceMarker('_replaceOntologyCitationsIn', '依据 \uE000ONTOLOGYREF0\uE001', [
      { moduleId: 'personal', recordId: 'def-project', version: 3 },
    ]);
    const html = renderedHtml(replaced);
    expect(html).toContain('data-ontology-citation="def-project"');
    expect(html).toContain('data-ontology-module="personal"');
    expect(html).toContain('data-ontology-version="3"');
    expect(html).toContain('查看本体依据 · v3');
  });

  it('keeps the raw ontology marker inside code blocks', () => {
    const replaced = replaceMarker('_replaceOntologyCitationsIn', '\uE000ONTOLOGYREF0\uE001', [
      { moduleId: 'personal', recordId: 'def-project', version: 3 },
    ], true);
    expect(renderedHtml(replaced)).toBe('[[ontology:personal/def-project@3]]');
  });

  it('opens the exact proposal from its citation button', () => {
    const run = clickCitation(
      '// [proposal:<id>] opens an existing governed decision',
      '[data-proposal-citation]',
      { proposalCitation: 'ap-42' },
      'openCognitionApprovalById',
    );
    expect(run.opened).toEqual([['ap-42']]);
    expect(run.loadedFeatures).toEqual([]);
  });

  it('lazy-loads the recall feature before opening a proposal citation', async () => {
    const run = clickCitation(
      '// [proposal:<id>] opens an existing governed decision',
      '[data-proposal-citation]',
      { proposalCitation: 'ap-42' },
      'openCognitionApprovalById',
      { lazyOpener: true },
    );
    expect(run.opened).toEqual([]);
    expect(run.loadedFeatures).toEqual(['recall']);
    await run.finishFeatureLoad();
    expect(run.opened).toEqual([['ap-42']]);
  });

  it('opens the pinned ontology record version from its citation button', () => {
    const run = clickCitation(
      '// [[ontology:module/record@version]] → 同一权威记录的只读历史版本。',
      '[data-ontology-citation]',
      { ontologyCitation: 'def-project', ontologyModule: 'personal', ontologyVersion: '3' },
      'openCognitionOntologyRecord',
    );
    expect(run.opened).toEqual([['personal', 'def-project', 3]]);
  });

  it('rejects an ontology citation whose version is not a positive integer', () => {
    const run = clickCitation(
      '// [[ontology:module/record@version]] → 同一权威记录的只读历史版本。',
      '[data-ontology-citation]',
      { ontologyCitation: 'def-project', ontologyModule: 'personal', ontologyVersion: '0' },
      'openCognitionOntologyRecord',
    );
    expect(run.opened).toEqual([]);
    expect(run.loadedFeatures).toEqual([]);
  });
});

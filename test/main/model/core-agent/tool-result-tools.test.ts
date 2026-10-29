import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTool, ToolContext } from '#core-agent';
import {
  esticogseedToolResultTokens,
  persistToolResult,
  toolResultRefForPath,
} from '../../../../src/main/util/tool-result-cap';
import {
  TOOL_RESULT_ROUND_MAX_TOKENS,
  TOOL_RESULT_SEARCH_MAX_TOKENS,
  createToolResultTools,
  resolveToolResultRef,
} from '../../../../src/main/model/core-agent/tool-result-tools';

function getTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('persisted tool-result retrieval', () => {
  let dir: string;
  let ref: string;
  let tools: AgentTool[];
  let ctx: ToolContext;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-result-tools-'));
    const content = [
      'alpha preface',
      'needle first important observation',
      'x'.repeat(12_000),
      'needle second important observation',
      'omega ending',
    ].join('\n');
    ref = toolResultRefForPath(persistToolResult(dir, 'web_fetch', content));
    tools = createToolResultTools({ toolResultsDir: dir });
    ctx = {
      state: {
        toolResultReadLedger: {
          epoch: 0,
          remainingTokens: TOOL_RESULT_ROUND_MAX_TOKENS,
          readKeys: new Set<string>(),
        },
      },
    };
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resolves only valid refs inside the active session', () => {
    expect(ref).toMatch(/^web_fetch\.[a-f0-9]{64}$/);
    expect(resolveToolResultRef(dir, ref)).toMatchObject({ ok: true });
    expect(resolveToolResultRef(dir, '../secret')).toMatchObject({ ok: false, code: 'E_RESULT_REF_INVALID' });
    expect(resolveToolResultRef(dir, 'web_fetch.0000000000000000')).toMatchObject({ ok: false, code: 'E_RESULT_REF_MISSING' });
  });

  it('keeps legacy 16-hex refs readable while new writes use full SHA-256 refs', () => {
    const legacyRef = 'bash.1111111111111111';
    fs.writeFileSync(path.join(dir, `${legacyRef}.txt`), 'legacy result');
    expect(resolveToolResultRef(dir, legacyRef)).toMatchObject({ ok: true });
    expect(TOOL_RESULT_SEARCH_MAX_TOKENS).toBe(2_000);
  });

  it('requires fresh domain reads for historical governed results and their explicit chunk/search descendants without blocking ordinary results', async () => {
    const original = toolResultRefForPath(persistToolResult(dir, 'cognition_ontology_query', 'WITHDRAWN_PRIVATE_BODY'));
    const descendant = toolResultRefForPath(persistToolResult(dir, 'tool_result_read_chunk', `<tool-result-chunk ref="${original}" total_chars="22" covered="0-22" next_cursor="done">\nWITHDRAWN_PRIVATE_BODY\n</tool-result-chunk>`));
    const nested = toolResultRefForPath(persistToolResult(dir, 'tool_result_search', `<tool-result-search ref="${descendant}" query="body">\nWITHDRAWN_PRIVATE_BODY\n</tool-result-search>`));
    for (const blocked of [original, descendant, nested, 'read_ability_asset.1111111111111111']) {
      for (const name of ['tool_result_search', 'tool_result_read_chunk']) {
        const result = await getTool(tools, name).execute({ ref: blocked, query: 'PRIVATE', cursor: 0 }, ctx);
        expect(result.isError).toBe(true); expect(result.content).toContain('E_RESULT_SOURCE_RECHECK_REQUIRED');
        expect(result.content).not.toContain('WITHDRAWN_PRIVATE_BODY');
      }
    }
    expect((await getTool(tools, 'tool_result_read_chunk').execute({ ref, cursor: 0 }, ctx)).isError).toBeFalsy();
    expect(fs.existsSync(path.join(dir, original + '.txt'))).toBe(true);
  });

  it('searches for narrow excerpts without returning the whole result', async () => {
    const result = await getTool(tools, 'tool_result_search').execute({ ref, query: 'needle important' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<tool-result-search');
    expect(result.content).toContain('needle first important observation');
    expect(result.content).toContain('</tool-result-search>');
    expect(result.content.length).toBeLessThan(12_000);
  });

  it('reads an exact bounded chunk and returns a continuation cursor', async () => {
    const result = await getTool(tools, 'tool_result_read_chunk').execute({ ref, cursor: 0, maxTokens: 9_000 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('covered="0-');
    expect(result.content).toMatch(/next_cursor="\d+"/);
    expect(result.content).toContain('</tool-result-chunk>');
    expect(esticogseedToolResultTokens(result.content)).toBeLessThanOrEqual(2_000);
  });

  it('searches and reads correctly across a 64KB UTF-8 scan boundary', async () => {
    const content = `${'a'.repeat(65_535)}界needle-after-boundary\nomega`;
    const boundaryRef = toolResultRefForPath(persistToolResult(dir, 'bash', content));
    const search = await getTool(tools, 'tool_result_search').execute({
      ref: boundaryRef,
      query: '界needle',
    }, ctx);
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('界needle-after-boundary');
    expect(search.content).toContain(`total_chars="${content.length}"`);

    const chunk = await getTool(tools, 'tool_result_read_chunk').execute({
      ref: boundaryRef,
      cursor: 65_534,
      maxTokens: 256,
    }, ctx);
    expect(chunk.isError).toBeFalsy();
    expect(chunk.content).toContain('a界needle-after-boundary');
    expect(chunk.content).toContain(`total_chars="${content.length}"`);
  });

  it('suppresses duplicate reads in the same compaction epoch', async () => {
    const tool = getTool(tools, 'tool_result_read_chunk');
    await tool.execute({ ref, cursor: 0, maxTokens: 300 }, ctx);
    const duplicate = await tool.execute({ ref, cursor: 0, maxTokens: 300 }, ctx);
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain('E_RESULT_CHUNK_ALREADY_READ');
  });

  it('enforces the aggregate per-round read budget', async () => {
    const ledger = ctx.state.toolResultReadLedger as { remainingTokens: number };
    ledger.remainingTokens = 100;
    const result = await getTool(tools, 'tool_result_read_chunk').execute({ ref, cursor: 0, maxTokens: 300 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_RESULT_READ_BUDGET');
  });
});

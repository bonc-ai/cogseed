import { describe, expect, it } from 'vitest';
import { parseTextToolCalls } from '../../../../../src/main/features/cogseed_runtime/kernel/text-tool-calls';

const known = new Set(['read_file', 'write_file']);

describe('parseTextToolCalls', () => {
  it('recovers the XML parameter form the model leaked into content', () => {
    const text = '<tool_calls>\n<tool_call name="read_file">\n<parameter name="path">/w/a.json</parameter>\n</tool_call>\n'
      + '<tool_call name="write_file">\n<parameter name="path">/w/b.md</parameter>\n<parameter name="content"># 标题\n正文</parameter>\n</tool_call>\n</tool_calls>';
    expect(parseTextToolCalls(text, known, 't')).toEqual([
      { id: 't-0', name: 'read_file', arguments: { path: '/w/a.json' } },
      { id: 't-1', name: 'write_file', arguments: { path: '/w/b.md', content: '# 标题\n正文' } },
    ]);
  });

  it('recovers the JSON form and typed values', () => {
    expect(parseTextToolCalls('<tool_call>{"name":"read_file","arguments":{"path":"/a","charEnd":200}}</tool_call>', known, 'j'))
      .toEqual([{ id: 'j-0', name: 'read_file', arguments: { path: '/a', charEnd: 200 } }]);
  });

  it('leaves prose, unknown tools and malformed JSON untouched', () => {
    expect(parseTextToolCalls('纪要已确认。', known, 'x')).toBeNull();
    expect(parseTextToolCalls('<tool_call name="rm_rf"><parameter name="path">/</parameter></tool_call>', known, 'x')).toBeNull();
    expect(parseTextToolCalls('<tool_call>{not json}</tool_call>', known, 'x')).toBeNull();
  });
});

/**
 * transcript_doc_tags — 转写文档的「场景标签」存储与建议
 *
 * 这一层补的是「仅本场景」作用域的前置数据：词条能按场景生效，但此前没有任何
 * 来源能给"这份稿子属于哪个场景"，于是那个选项永远点不动、带场景标签的词条也
 * 永远命中不了。这里覆盖：归一规则、读写往返、坏档降级、建议 best-effort。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  loadDocTags,
  normalizeTags,
  readTagsForDoc,
  setTagsForDoc,
  suggestScenarioTags,
} from '../../../src/main/features/transcript_doc_tags';
import { userTranscriptDocTagsFile } from '../../../src/main/paths';

let uid = '';
beforeEach(() => {
  uid = `u_doctags_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
});

describe('标签归一（与渲染层同规则）', () => {
  it('NFKC + 去首尾空白 + 折叠内部空白', () => {
    expect(normalizeTags(['  英语演讲课  '])).toEqual(['英语演讲课']);
    expect(normalizeTags(['英语  演讲\t课'])).toEqual(['英语 演讲 课']);
    // 全角字母/数字折叠成半角，避免"看起来一样但存了两种"
    expect(normalizeTags(['ＥＣＳ１'])).toEqual(['ECS1']);
  });

  it('去重按大小写不敏感，保留先出现的写法', () => {
    expect(normalizeTags(['Cogseed', 'cogseed', 'COGSEED'])).toEqual(['Cogseed']);
  });

  it('空值/非数组一律当空；超长截断、超量截断', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags('英语演讲课')).toEqual([]); // 字符串不是数组：不给"猜"的机会
    expect(normalizeTags(['', '   ', null])).toEqual([]);
    const long = '一'.repeat(40);
    expect(normalizeTags([long])[0]).toHaveLength(24);
    const many = Array.from({ length: 20 }, (_, i) => `场景${i}`);
    expect(normalizeTags(many)).toHaveLength(8);
  });
});

describe('读写往返', () => {
  it('写入后可读回；重写为空即清除', () => {
    expect(setTagsForDoc(uid, 'doc-1', ['英语演讲课', '期末'])).toEqual({ ok: true, tags: ['英语演讲课', '期末'] });
    expect(readTagsForDoc(uid, 'doc-1')).toEqual(['英语演讲课', '期末']);
    // 落盘了（换一次读盘路径也要能看到）
    expect(loadDocTags(uid).docs['doc-1'].tags).toHaveLength(2);

    expect(setTagsForDoc(uid, 'doc-1', [])).toEqual({ ok: true, tags: [] });
    expect(readTagsForDoc(uid, 'doc-1')).toEqual([]);
    expect(loadDocTags(uid).docs['doc-1']).toBeUndefined();
  });

  it('文档之间互不影响；没标过的文档返回空数组', () => {
    setTagsForDoc(uid, 'doc-a', ['组会']);
    expect(readTagsForDoc(uid, 'doc-b')).toEqual([]);
    expect(readTagsForDoc(uid, '')).toEqual([]);
  });

  it('缺 docId / docId 过长一律拒绝（不写脏档）', () => {
    expect(setTagsForDoc(uid, '  ', ['x']).ok).toBe(false);
    expect(setTagsForDoc(uid, 'd'.repeat(201), ['x']).ok).toBe(false);
  });

  it('坏档（非法 JSON / 结构不对）降级为空，不抛错', () => {
    const abs = userTranscriptDocTagsFile(uid);
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '{ this is not json', 'utf8');
    expect(loadDocTags(uid)).toEqual({ version: 1, docs: {} });
    expect(readTagsForDoc(uid, 'doc-1')).toEqual([]);

    // 结构不对（docs 是数组）同样降级，并且顺手把脏条目滤掉
    fs.writeFileSync(abs, JSON.stringify({ version: 1, docs: ['nope'] }), 'utf8');
    expect(loadDocTags(uid).docs).toEqual({});

    fs.writeFileSync(abs, JSON.stringify({ version: 1, docs: { 'doc-1': { tags: ['', '嗯', '组会', '组会'], updatedAt: 1 } } }), 'utf8');
    expect(readTagsForDoc(uid, 'doc-1')).toEqual(['嗯', '组会']);
  });
});

describe('场景建议（best-effort）', () => {
  it('读不到本体分组时给空数组，且不抛错', async () => {
    // 本机/测试环境没有分组数据（或路径不可读）：建议为空，由用户自己命名
    await expect(suggestScenarioTags(`u_isolated_${Date.now()}`)).resolves.toEqual([]);
  });
});

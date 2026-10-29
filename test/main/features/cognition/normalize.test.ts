import { describe, it, expect } from 'vitest';

/** normalize 只公开仍被消费的辅助函数；已退役的引用、分页与候选动作
 * 死导出不得恢复。兼容回执引用方言与 Unicode 安全截断保持原契约。 */
describe('cognition/normalize › 导出面', () => {
  it('恰好只导出四个在用符号，不含已删除的死代码', async () => {
    const mod = await import('../../../../src/main/features/cognition/normalize');
    expect(Object.keys(mod).sort()).toEqual(
      ['personalOntologyCandidateActions', 'refMatchesAsset', 'relationRef', 'titleFromText'].sort(),
    );
  });

  it('保留函数行为不受删除影响', async () => {
    const { titleFromText, relationRef, personalOntologyCandidateActions, refMatchesAsset } =
      await import('../../../../src/main/features/cognition/normalize');
    expect(titleFromText('  hello   world  ', 'fb')).toBe('hello world');
    expect(titleFromText('', 'fb')).toBe('fb');
    expect(relationRef('conversation', 'c1')).toEqual({ type: 'conversation', id: 'c1', title: undefined });
    expect(personalOntologyCandidateActions).toEqual(['open_personal_ontology', 'import_to_recall']);
    expect(refMatchesAsset('skill:s1', 'skill', 's1')).toBe(true);
    expect(refMatchesAsset('note:n1', 'note', 'n1')).toBe(true);
    expect(refMatchesAsset('note:other', 'note', 'n1')).toBe(false);
  });

  it('兼容回执侧持久化的四种 ref 方言，复用计数不再对真实回执恒 0', async () => {
    const { refMatchesAsset } = await import('../../../../src/main/features/cognition/normalize');
    // asset-reference.ts parseAbilityAssetReference 支持的四种方言，
    // 与 inherited-cognition-prompt.ts assetRef() 的真实写入格式一致。
    expect(refMatchesAsset('aa-x1', 'domain_knowledge', 'aa-x1')).toBe(true);
    expect(refMatchesAsset('asset:aa-x1', 'domain_knowledge', 'aa-x1')).toBe(true);
    expect(refMatchesAsset('asset:aa-x1@v3', 'domain_knowledge', 'aa-x1')).toBe(true);
    expect(refMatchesAsset('asset:aa-x1@v3:scope_mismatch', 'domain_knowledge', 'aa-x1')).toBe(true);
    // 版本不同的回执也指向同一条资产，计入复用（回执方言里版本是描述不是身份）。
    expect(refMatchesAsset('asset:aa-x1@v9', 'domain_knowledge', 'aa-x1')).toBe(true);
    // 别的资产 id 不误配。
    expect(refMatchesAsset('asset:aa-x2@v3', 'domain_knowledge', 'aa-x1')).toBe(false);
  });

  it('endsWith 兜底收窄到 asset: scheme，任意前缀不再误配', async () => {
    const { refMatchesAsset } = await import('../../../../src/main/features/cognition/normalize');
    // 旧实现对 ":<id>" 结尾一律成立——"evil:<id>" 这类未知 scheme 曾被计入复用。
    expect(refMatchesAsset('evil:aa-x1', 'domain_knowledge', 'aa-x1')).toBe(false);
    expect(refMatchesAsset('random://host/aa-x1', 'domain_knowledge', 'aa-x1')).toBe(false);
    // asset: scheme 的自由拼接写法仍兜得住。
    expect(refMatchesAsset('asset://domain_knowledge/aa-x1', 'domain_knowledge', 'aa-x1')).toBe(true);
    expect(refMatchesAsset('asset:domain_knowledge:aa-x1', 'domain_knowledge', 'aa-x1')).toBe(true);
    // skill 特例方言不受影响。
    expect(refMatchesAsset('custom_skill:sk-1', 'skill', 'sk-1')).toBe(true);
  });

  it('80 码元截断不劈代理对——末位高代理砍 1 码元，UTF-8 往返无 U+FFFD', async () => {
    const { titleFromText } = await import('../../../../src/main/features/cognition/normalize');
    // 79 个 'a' + emoji（代理对占 2 码元）+ 尾巴：slice(0,80) 末码元恰是孤立高代理。
    const emoji = '\u{1F600}';
    const out1 = titleFromText('a'.repeat(79) + emoji + 'b'.repeat(5), 'fb');
    expect(out1.endsWith('…')).toBe(true);
    expect(out1.charCodeAt(out1.length - 2)).toBe('a'.charCodeAt(0)); // 高代理被砍，末字符回到 'a'
    expect(Buffer.from(out1, 'utf8').toString('utf8')).toBe(out1); // UTF-8 往返不变（无 U+FFFD）
    // 第 80 码元是完整 BMP 字符（emoji 从第 81 码元起）：正常截断，不触发砍位。
    const out2 = titleFromText('a'.repeat(79) + '汉' + emoji + 'b'.repeat(5), 'fb');
    expect(out2).toBe('a'.repeat(79) + '汉…');
    // 两个代理对连排：第 80 码元仍可能是第二个代理对的高代理，同样被砍。
    const out3 = titleFromText('a'.repeat(77) + emoji + emoji + 'b'.repeat(5), 'fb');
    expect(Buffer.from(out3, 'utf8').toString('utf8')).toBe(out3);
    expect([...out3].length).toBe(79); // 77a + 完整 emoji + 省略号 = 79 码点
  });
});

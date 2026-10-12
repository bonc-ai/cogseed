/**
 * 声明门的贡献侧语义。
 *
 * 复用的是 `skill_reverify.checkDeclaration`，它的 6 种状态在**安装侧**只进 receipt 供展示；
 * 贡献侧要据此决定内容能不能离开本机。这套用例锁住的是这层翻译——尤其 `absent`：
 * 安装侧不拦（迭代一官方内容本就不强制带声明），贡献侧必须拦（Hub `FR-010` 明写
 * 社区安全声明随包必需）。
 *
 * 不 mock 引擎：`gateDeclaration` 本身只是状态翻译，真正的引擎行为由
 * `security/skill-declaration-adapter.test.ts` 覆盖，这里重复一遍只会把翻译层的
 * bug 藏在一个假的引擎后面。
 */
import { describe, expect, it } from 'vitest';

import { readOntologyVersion, componentsReady } from '../../../../src/main/features/contribution/components';

describe('本体版本与引擎版本是两个独立版本号', () => {
  /**
   * `guardrailStatus().declarationEngineVersion` 读的是 `skill-declaration-core/VERSION`
   * （引擎，实测 1.3.0）；引擎加载的本体是 `cogseed.security.skill@1.1.1`。跨端已确认
   * 口径：报告与上行都不得以其一冒充另一。
   */
  it('能从随仓本体目录读出本体版本', () => {
    const v = readOntologyVersion();
    // 随仓存在时应读到形如 `1.1.1` 的版本；不存在时为 null，但不得抛错。
    if (v !== null) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('本体版本读不出时判为组件未就绪，而不是沿用引擎版本', () => {
    const fake = {
      ruleset: { name: 'ruleset' as const, version: 'v1.0.0', ready: true },
      sentry: { name: 'skill-sentry' as const, version: '2.1.0', ready: true },
      declaration: { name: 'declaration-core' as const, version: '1.3.0', ready: true },
      ontologyVersion: null,
      guardrail: {} as never,
    };
    const r = componentsReady(fake);
    expect(r.ready).toBe(false);
    expect(r.blocking).toContain('ontology:unreadable');
  });
});
describe('组件未就绪即不开始检查', () => {
  /**
   * 任一组件缺失 / 被篡改 / pin 不符时，后续每一步的结论都不可采信，而贡献者会把它
   * 读成"检查过了"。宁可不开始，也不给一个看起来像通过的结果。
   */
  it('扫描器未就绪 → 阻塞项含 skill-sentry', () => {
    const r = componentsReady({
      ruleset: { name: 'ruleset', version: 'v1.0.0', ready: false, reason: 'tampered' },
      sentry: { name: 'skill-sentry', version: '2.1.0', ready: false, reason: 'tampered' },
      declaration: { name: 'declaration-core', version: '1.3.0', ready: true },
      ontologyVersion: '1.1.1',
      guardrail: {} as never,
    });
    expect(r.ready).toBe(false);
    expect(r.blocking.some((b) => b.startsWith('skill-sentry:'))).toBe(true);
  });

  it('声明引擎 pin 不符 → 阻塞项含 declaration-core', () => {
    const r = componentsReady({
      ruleset: { name: 'ruleset', version: 'v1.0.0', ready: true },
      sentry: { name: 'skill-sentry', version: '2.1.0', ready: true },
      declaration: { name: 'declaration-core', version: '1.3.0', ready: false, reason: 'unpinned' },
      ontologyVersion: '1.1.1',
      guardrail: {} as never,
    });
    expect(r.ready).toBe(false);
    expect(r.blocking).toContain('declaration-core:unpinned');
  });

  it('三者齐备且本体可读 → 就绪', () => {
    const r = componentsReady({
      ruleset: { name: 'ruleset', version: 'v1.0.0', ready: true },
      sentry: { name: 'skill-sentry', version: '2.1.0', ready: true },
      declaration: { name: 'declaration-core', version: '1.3.0', ready: true },
      ontologyVersion: '1.1.1',
      guardrail: {} as never,
    });
    expect(r).toEqual({ ready: true, blocking: [] });
  });
});

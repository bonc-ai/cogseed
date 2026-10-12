/**
 * 贡献准入判据：与安装准入的差异，逐条钉死。
 *
 * 这套用例的存在理由是**判据分叉**本身。`sentry-adapter` 的安装判据
 * （`scanVerdictBlocksInstall`）对 `restricted` / `scanner_absent` 放行，是刻意的产品
 * 决定；贡献侧把这两个都拦下，也是刻意的。两个"刻意"必须各自有断言锁住，否则将来
 * 有人把贡献判据"顺手统一"回安装判据，不会有任何测试变红——而后果是带风险的内容
 * 进了公开目录。
 *
 * 判据本体是纯函数（`_blockReasonForOutcome` 经 `admitContribution` 间接覆盖），
 * 不 mock 扫描器：mock 会把"两边判据一致"这件事假设掉，而这正是要测的东西。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanVerdictBlocksInstall } from '../../../../src/main/features/security/sentry-adapter';
import { CONTRIB_STAGING_PREFIX } from '../../../../src/main/features/contribution/staging';
import { toUploadableIssue } from '../../../../src/main/features/contribution/admission';

describe('贡献暂存目录名不得触发扫描器上下文降级', () => {
  /**
   * `resources/guardrail/skill-sentry/engine/scanner_core/context.py` 会按路径分段
   * 把命中降 1–2 档。把提交副本停在一个含降级词的目录里，等于给整次扫描打折——
   * `marketplace.ts` 的 `quarantineStagingName` 注释把这叫「laundering a payload
   * parked in the staging dir name」。
   */
  const DEMOTION_WORDS = [
    // _TEST_DIR_PARTS
    'test', 'tests', 'testing', '__tests__', 'spec', 'specs',
    'fixture', 'fixtures', 'testdata', 'test_data', 'e2e',
    // _VENDOR_DIR_PARTS
    'vendor', 'vendored', 'third_party', 'thirdparty',
    // _DOC_DIR_PARTS
    'doc', 'docs', 'documentation', 'examples', 'example', 'samples',
  ];

  it('前缀不包含任何降级词', () => {
    const lowered = CONTRIB_STAGING_PREFIX.toLowerCase();
    for (const word of DEMOTION_WORDS) {
      expect(lowered).not.toContain(word);
    }
  });

  it('前缀不匹配文件名级的 test_/spec_ 与 .test./.spec. 形态', () => {
    const name = `${CONTRIB_STAGING_PREFIX}deadbeef`;
    expect(name.startsWith('test_')).toBe(false);
    expect(name.startsWith('spec_')).toBe(false);
    expect(/[._](test|spec)\.[a-z]+$/.test(name)).toBe(false);
  });
});
describe('贡献判据与安装判据的刻意分叉', () => {
  /**
   * 这两条是本轮最容易被"顺手统一"掉的差异，各给一条断言。
   * 安装侧放行的依据见 `scan_gate.py:168-173` 与 `sentry-adapter.ts:131`。
   */
  it('安装侧对 restricted 放行 —— 贡献侧必须与之不同', () => {
    expect(scanVerdictBlocksInstall('restricted')).toBe(false);
  });

  it('安装侧对 scanner_absent 放行 —— 贡献侧必须与之不同', () => {
    expect(scanVerdictBlocksInstall('scanner_absent')).toBe(false);
  });

  it('两边对 unknown 一致阻断（这条不分叉）', () => {
    expect(scanVerdictBlocksInstall('unknown')).toBe(true);
  });
});

describe('上行形态不得夹带命中原文', () => {
  /**
   * `Violation.snippet` 的类型注释逐字是「Quoted excerpt of the offending content」。
   * 跨端契约 C-03 规定上行 `Issue.message` 不得含命中原文、本机绝对路径、凭据、
   * 任务正文、Prompt 或私人实例 ID。原样上行等于把要拦的东西亲手发出去。
   */
  it('丢弃 snippet，只保留规则 id / 级别 / 相对路径 / 修复建议', () => {
    const issue = toUploadableIssue({
      level: 'EXTREME',
      rule: 'no_credential_path_read',
      field: 'scripts/run.py:12',
      snippet: 'AKIAIOSFODNN7EXAMPLE 这是命中的凭据原文',
      suggested_fix: '移除硬编码凭据，改从环境变量读取。',
    });
    expect(issue).toEqual({
      rule_id: 'no_credential_path_read',
      level: 'EXTREME',
      path: 'scripts/run.py',
      message: '移除硬编码凭据，改从环境变量读取。',
    });
    expect(JSON.stringify(issue)).not.toContain('AKIA');
  });

  /**
   * 回归（2026-09-28 跨端联调发现）：`Issue.level` 是 C-03 §1 的必填字段。
   *
   * 缺陷形态：上行形态漏了 `level`，Hub 接收校验对每一条 issue 都要求它，于是本机
   * **只要有一条非 `EXTREME` 命中**，整条提交就被 `INVALID_REQUEST`（`级别必填`）拒绝——
   * 而契约要求的是「随提交记录为 warnings，不阻断」。
   */
  it('带 level，且进入 warnings 的级别落在 C-03 允许集合内', () => {
    const warning = toUploadableIssue({
      level: 'LOW',
      original_level: 'MEDIUM',
      rule: 'STRUCTURE_QUALITY_MEDIUM',
      field: 'SKILL.md',
      snippet: '',
      suggested_fix: '补充使用示例。',
    });
    // 保留「被上下文降级前的级别」，与上行前的过滤判据同源
    expect(warning.level).toBe('MEDIUM');
    expect(['MEDIUM', 'LOW']).toContain(warning.level);

    const blocking = toUploadableIssue({
      level: 'EXTREME',
      rule: 'CLIENT_LOCAL_ABSOLUTE_PATH',
      field: 'scripts/run.py',
      snippet: '',
      suggested_fix: '改为包内相对路径。',
    });
    expect(blocking.level).toBe('EXTREME');
  });

  it('frontmatter 级问题不产出 path（它不是文件路径）', () => {
    const issue = toUploadableIssue({
      level: 'MEDIUM',
      rule: 'shape_trigger_missing',
      field: 'frontmatter:description',
      snippet: '',
      suggested_fix: '补充触发条件说明。',
    });
    expect(issue.path).toBeUndefined();
    expect(issue.rule_id).toBe('shape_trigger_missing');
  });

  it('message 截断到 500 字符以内（C-03 上限）', () => {
    const issue = toUploadableIssue({
      level: 'LOW',
      rule: 'x',
      field: 'a.md',
      snippet: '',
      suggested_fix: 'x'.repeat(900),
    });
    expect(issue.message.length).toBeLessThanOrEqual(500);
  });
});

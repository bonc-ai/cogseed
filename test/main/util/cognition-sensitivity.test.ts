import { describe, expect, it } from 'vitest';

import {
  assertNotForbiddenToPersist,
  classifyCognitionSensitivity,
} from '../../../src/main/util/cognition-sensitivity';

describe('L3 认定：真凭证必须拦下', () => {
  const forbidden: Array<[string, string, string]> = [
    ['PEM 私钥块', '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n', 'private_key_block'],
    ['OpenSSH 私钥', '备份里有 -----BEGIN OPENSSH PRIVATE KEY----- 这段', 'private_key_block'],
    ['AWS access key', '用 AKIAIOSFODNN7EXAMPLE 这个账号跑', 'known_credential_prefix'],
    ['GitHub token', 'token 是 ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'known_credential_prefix'],
    ['GitHub 细粒度 PAT', 'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz', 'known_credential_prefix'],
    ['GitLab PAT', '内网仓库用 glpat-abcdefghij1234567890 拉', 'known_credential_prefix'],
    ['Google API key', 'AIzaSyD-abcdefghijklmnopqrstuvwxyz12', 'known_credential_prefix'],
    ['URL 内嵌口令', '连 postgres://admin:hunter2@db.internal:5432/app', 'credential_in_url'],
    ['Bearer token', 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'bearer_token'],
    ['键值赋值', 'api_key = sk_live_9f8e7d6c5b4a3210', 'credential_assignment'],
    ['JSON 形态', '{"password": "correct-horse-battery"}', 'credential_assignment'],
  ];

  for (const [name, text, reason] of forbidden) {
    it(`拦下：${name}`, () => {
      const verdict = classifyCognitionSensitivity(text);
      expect(verdict.level).toBe('L3');
      expect(verdict.reason).toBe(reason);
    });
  }

  it('原因里不带命中的原文，避免解释时二次泄露', () => {
    const verdict = classifyCognitionSensitivity('api_key = sk_live_9f8e7d6c5b4a3210');
    expect(verdict.reason).not.toContain('sk_live');
    expect(verdict.reason).not.toContain('9f8e7d');
  });
});

describe('L3 认定：正常判断不该被误伤', () => {
  const allowed = [
    '写接口先定好错误码再动手，别等联调时才补。',
    '评审时先看接口契约，再看实现。',
    // 只提到「密码」这个词但没有赋值，是在讲做法，不是凭证本身。
    '密码字段在日志里必须脱敏。',
    '任何 token 都不要写进代码库。',
    '动手前先把验收标准写成可勾选的清单。',
    'Use environment variables for secrets rather than committing them.',
  ];

  for (const text of allowed) {
    it(`放行：${text.slice(0, 24)}…`, () => {
      expect(classifyCognitionSensitivity(text).level).toBe('unclassified');
    });
  }

  it('空值与非字符串不判定', () => {
    expect(classifyCognitionSensitivity('').level).toBe('unclassified');
    expect(classifyCognitionSensitivity(undefined).level).toBe('unclassified');
    expect(classifyCognitionSensitivity(123).level).toBe('unclassified');
  });
});

describe('多段一起过闸', () => {
  it('凭证藏在次要字段里也拦得住', () => {
    // 把凭证写在 summary 之类的次要字段里绕过主字段检查，是最容易想到的规避方式。
    expect(() => assertNotForbiddenToPersist([
      '一条看起来很正常的判断。',
      'api_key = sk_live_9f8e7d6c5b4a3210',
    ])).toThrow('forbidden to persist');
  });

  it('全部正常时放行', () => {
    expect(() => assertNotForbiddenToPersist(['正常判断', '正常摘要', undefined])).not.toThrow();
  });

  it('断言抛错且原因可展示，不静默丢弃', () => {
    // 规范 16.1 要求「不形成候选…提示处理」，静默丢弃会违反「无需更新也要透明」。
    expect(() => assertNotForbiddenToPersist(['-----BEGIN CERTIFICATE-----']))
      .toThrow('forbidden to persist: private_key_block');
    expect(() => assertNotForbiddenToPersist(['正常判断'])).not.toThrow();
  });
});

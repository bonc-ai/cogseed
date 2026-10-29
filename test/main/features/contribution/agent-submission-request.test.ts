/**
 * Agent 上行请求体：白名单形态 + 与真实暂存副本/打包的端到端一致。
 * Hub 对 manifest 是「拒绝而非忽略」，所以这里钉死的是**不多带一个字段**。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  agentDescription, agentSubmissionMetadata, buildAgentSubmissionManifest,
} from '../../../../src/main/features/contribution/agent-submission-request';
import { checkPackageLimits, DEFAULT_PACKAGE_LIMITS } from '../../../../src/main/features/contribution/agent-package-rules';
import { stageAgent } from '../../../../src/main/features/contribution/agent-staging';
import { buildPackage } from '../../../../src/main/features/contribution/package';
import { buildPreview } from '../../../../src/main/features/contribution/preview';

describe('metadata 映射', () => {
  it('description 取 description_zh，缺省取 description_en', () => {
    expect(agentDescription({ description_zh: '中文', description_en: 'EN' })).toBe('中文');
    expect(agentDescription({ description_en: 'EN only' })).toBe('EN only');
    expect(agentDescription({ description_zh: '  ', description_en: 'EN' })).toBe('EN');
    expect(agentDescription(null)).toBe('');
  });

  it('只投影 name / description / version，超集字段不外泄', () => {
    const meta = agentSubmissionMetadata({ name: 'a', description_zh: 'd', workflow: 'SECRET', security_manifest: 'x' } as never, '1.0.0');
    expect(meta).toEqual({ name: 'a', description: 'd', version: '1.0.0' });
  });
});

describe('manifest 白名单', () => {
  const input = {
    agent: { name: '报销助手', description_zh: '核对材料', workflow: '内部流程不应上行' },
    declarations: { origin: { type: 'original' } },
    fileList: [{ path: 'agent.json', sha256: 'a'.repeat(64), size: 10 }],
    localAgentId: '00000000-0000-4000-8000-000000000000',
    localCheck: { blocking: [], checker: { side: 'client', version: '1.2.0' }, warnings: [] },
    packageDigest: 'b'.repeat(64),
    packageSize: 128,
    targetContentId: null,
    version: '1.0.0',
  };

  it('字段集逐字对应提案 §5，且是 agent 而非 skill', () => {
    const m = buildAgentSubmissionManifest(input);
    expect(Object.keys(m).sort()).toEqual([
      'content_type', 'declarations', 'file_list', 'local_agent_id', 'local_check', 'metadata',
      'package_digest', 'package_size', 'target_content_id',
    ]);
    expect(m.content_type).toBe('agent');
    expect(m).not.toHaveProperty('local_skill_id');
    expect(JSON.stringify(m)).not.toContain('内部流程不应上行');
  });

  it('file_list 是拷贝，不与入参共享引用', () => {
    const m = buildAgentSubmissionManifest(input);
    expect(m.file_list).not.toBe(input.fileList);
  });
});

describe('端到端：暂存 → 预览 → 打包 → manifest', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-req-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const write = (rel: string, c: string): void => {
    const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c);
  };

  async function stage() {
    write('cloud/agents/a1/agent.json', JSON.stringify({
      agent_id: 'a1', name: '报销助手', description_zh: '核对', workflow: '1. 读', category: 'office',
      created_at: 'x', skill_list: ['a3f09c21b7e4', 'ocr'],
    }));
    write('cloud/skills/ocr/SKILL.md', '---\nname: ocr\ndescription: d\n---\nbody\n');
    return stageAgent('a1', { agentDir: path.join(root, 'cloud/agents/a1'), userSkillsDir: path.join(root, 'cloud/skills'), stagingRoot: path.join(root, 'cache') });
  }

  it('包内文件恰为预览清单；manifest 的摘要与大小是真实打包结果；包里没有 _meta.json', async () => {
    const s = await stage();
    const preview = buildPreview(s);
    const pkg = buildPackage(s, preview);
    const names = new AdmZip(pkg.bytes).getEntries().map((e) => e.entryName).sort();
    expect(names).toEqual(preview.files.map((f) => f.path).sort());
    expect(names).toContain('skills/ocr/SKILL.md');
    expect(names.some((n) => n.endsWith('_meta.json'))).toBe(false);

    const m = buildAgentSubmissionManifest({
      agent: JSON.parse(fs.readFileSync(path.join(s.dir, 'agent.json'), 'utf8')) as Record<string, unknown>,
      declarations: {}, fileList: pkg.fileList, localAgentId: 'u', localCheck: { blocking: [], checker: { side: 'client', version: '1' }, warnings: [] },
      packageDigest: pkg.digest, packageSize: pkg.size, targetContentId: null, version: '1.0.0',
    });
    expect(m.package_size).toBe(pkg.bytes.length);
    expect(m.file_list.map((f) => f.path)).toEqual(preview.files.map((f) => f.path));
    expect(m.metadata).toEqual({ name: '报销助手', description: '核对', version: '1.0.0' });
  });

  it('打包后给出四段上限所需的实测数据，正常包不触发任何违规', async () => {
    const s = await stage();
    const pkg = buildPackage(s, buildPreview(s));
    expect(pkg.stats.fileCount).toBe(buildPreview(s).files.length);
    expect(pkg.stats.compressedBytes).toBe(pkg.bytes.length);
    expect(checkPackageLimits(pkg.stats, DEFAULT_PACKAGE_LIMITS)).toEqual([]);
  });

  it('高压缩比内容被识别（防解压炸弹），压缩后上限可由契约覆盖', async () => {
    const s = await stage();
    fs.writeFileSync(path.join(s.dir, 'bomb.txt'), 'A'.repeat(1_000_000));
    const pkg = buildPackage(s, buildPreview(s));
    expect(pkg.stats.maxEntryCompressionRatio).toBeGreaterThan(100);
    expect(checkPackageLimits(pkg.stats).map((v) => v.kind)).toContain('compression_ratio_too_high');
    expect(() => buildPackage(s, buildPreview(s), { maxCompressedBytes: 10 })).toThrow('package_too_large');
  });
});

import { describe, expect, it } from 'vitest';

import {
  buildSubmissionUploadManifest, submissionMetadata,
} from '../../../../src/main/features/contribution/upload-manifest';

/**
 * 上行请求体的白名单（C02 §1）。
 *
 * 回归背景（2026-09-28 桌面端真机联调发现）：`inspectCompletion().present` 是**超集**，
 * 有安全声明时会带 `security_manifest`；Hub 对 `manifest.metadata` 是白名单校验
 * （多余字段拒绝而非忽略）。原实现用类型断言把 `present` 当 metadata 发出去，
 * 于是**每一个带安全声明的提交（所有合法社区贡献）都被 `UNEXPECTED_FIELD` 拒掉**。
 * 声明是必需项，所以这条路径没有例外。
 */
describe('上行 manifest 组装', () => {
  const input = {
    declarations: { origin: { type: 'original' } },
    fileList: [{ path: 'SKILL.md', sha256: 'a'.repeat(64), size: 12 }],
    localCheck: { blocking: [], checker: { side: 'client', version: '1.2.0' }, warnings: [] },
    localSkillId: '00000000-0000-4000-8000-000000000000',
    packageDigest: 'b'.repeat(64),
    packageSize: 128,
    present: {
      name: 'sample-local-format-ui-demo',
      description: '说明',
      version: '1.0.0',
      // 超集字段：绝不能进 metadata
      security_manifest: 'manifest_version: "1.1.1"\n',
    },
    targetContentId: null,
  };

  it('metadata 只投影 name / description / version，丢掉 security_manifest', () => {
    const metadata = submissionMetadata(input.present);
    expect(Object.keys(metadata).sort()).toEqual(['description', 'name', 'version']);
    expect(metadata).toEqual({
      name: 'sample-local-format-ui-demo', description: '说明', version: '1.0.0',
    });
    expect(JSON.stringify(metadata)).not.toContain('manifest_version');
  });

  it('缺项投影为空串，而不是 undefined（不发出未定义字段）', () => {
    expect(submissionMetadata({ name: '只有名字' })).toEqual({ name: '只有名字', description: '', version: '' });
    expect(submissionMetadata(null)).toEqual({ name: '', description: '', version: '' });
  });

  it('manifest 字段集与 C02 白名单逐字一致', () => {
    const manifest = buildSubmissionUploadManifest(input);
    expect(Object.keys(manifest).sort()).toEqual([
      'content_type', 'declarations', 'file_list', 'local_check', 'local_skill_id',
      'metadata', 'package_digest', 'package_size', 'target_content_id',
    ]);
    expect(Object.keys(manifest.metadata).sort()).toEqual(['description', 'name', 'version']);
    expect(JSON.stringify(manifest)).not.toContain('security_manifest');
    expect(manifest.package_size).toBe(128);
    expect(manifest.file_list).toHaveLength(1);
  });
});

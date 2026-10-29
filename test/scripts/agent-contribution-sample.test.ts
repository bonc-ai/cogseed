/**
 * 联调样例生成器：产出的就是客户端真实会发出的字节，所以要钉住它的形态——
 * manifest 与包一致、剥掉本机字段、私有 Skill 带归属、没有 Hub 才写的文件、两类引用各一个。
 *
 * 样例刻意**不带** `builtin:` 引用：Hub 侧清单已清空（`DEC-HUB-OPEN3-ALIGN-001`），
 * 空清单下任何内置引用都在导入期被拒，带它的样例走不到提交成功。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAgentContributionSample } from '../../scripts/agent-contribution-sample';
import { validateAgentJson } from '../../src/main/features/contribution/agent-package-rules';

let out: string;
beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sample-out-')); });
afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

describe('buildAgentContributionSample', () => {
  it('manifest 的摘要、大小、文件清单与 agent.zip 逐项一致', async () => {
    const r = await buildAgentContributionSample({ outDir: out, hubSkillId: '5e1c8a02d9b3' });
    const bytes = fs.readFileSync(r.packagePath);
    const manifest = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as Record<string, any>;

    expect(manifest.content_type).toBe('agent');
    expect(manifest.package_size).toBe(bytes.length);
    expect(manifest.package_digest).toBe(createHash('sha256').update(bytes).digest('hex'));
    const zipNames = new AdmZip(bytes).getEntries().map((e) => e.entryName).sort();
    expect(manifest.file_list.map((f: { path: string }) => f.path).sort()).toEqual(zipNames);
    expect(Object.keys(manifest).sort()).toEqual([
      'content_type', 'declarations', 'file_list', 'local_agent_id', 'local_check', 'metadata',
      'package_digest', 'package_size', 'target_content_id',
    ]);
  });

  it('包内 agent.json 通过客户端的严格校验，且不含本机字段与生命周期字段', async () => {
    const r = await buildAgentContributionSample({ outDir: out, hubSkillId: '5e1c8a02d9b3' });
    const zip = new AdmZip(fs.readFileSync(r.packagePath));
    const agent = JSON.parse(zip.readAsText('agent.json')) as Record<string, unknown>;
    expect(validateAgentJson(agent).ok).toBe(true);
    for (const k of ['created_at', 'updated_at', 'version', 'enabled_connectors', 'default_model']) expect(agent).not.toHaveProperty(k);
  });

  it('两类引用各一个：Hub Skill、随包私有 Skill（不带内置能力）', async () => {
    const r = await buildAgentContributionSample({ outDir: out, hubSkillId: '5e1c8a02d9b3' });
    const agent = JSON.parse(new AdmZip(fs.readFileSync(r.packagePath)).readAsText('agent.json')) as { skill_list: string[] };
    expect(agent.skill_list).toEqual(['5e1c8a02d9b3', 'sample-local-format']);
  });

  it('样例 Agent 名可由 COGSEED_AGENT_SAMPLE_NAME / name 覆盖，缺省回到「联调样例Agent」', async () => {
    const readName = (p: string) =>
      (JSON.parse(new AdmZip(fs.readFileSync(p)).readAsText('agent.json')) as { name: string }).name;
    const prev = process.env.COGSEED_AGENT_SAMPLE_NAME;
    try {
      process.env.COGSEED_AGENT_SAMPLE_NAME = '联调样例Agent-env';
      expect(readName((await buildAgentContributionSample({ outDir: out })).packagePath)).toBe('联调样例Agent-env');
      expect(readName((await buildAgentContributionSample({ outDir: out, name: '联调样例Agent-opt' })).packagePath))
        .toBe('联调样例Agent-opt');
      delete process.env.COGSEED_AGENT_SAMPLE_NAME;
      expect(readName((await buildAgentContributionSample({ outDir: out })).packagePath)).toBe('联调样例Agent');
    } finally {
      if (prev === undefined) delete process.env.COGSEED_AGENT_SAMPLE_NAME;
      else process.env.COGSEED_AGENT_SAMPLE_NAME = prev;
    }
  });

  it('私有 Skill 随包、带归属与安全声明；包里没有 Hub 才写的 _meta.json', async () => {
    const r = await buildAgentContributionSample({ outDir: out });
    const zip = new AdmZip(fs.readFileSync(r.packagePath));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain('skills/sample-local-format/references/security-manifest.yaml');
    expect(names.some((n) => n.endsWith('_meta.json'))).toBe(false);
    expect(zip.readAsText('skills/sample-local-format/SKILL.md')).toContain('ownerAgent: sample-joint-test-agent');
  });

  it('不传 Hub Skill 时样例里没有十六进制依赖', async () => {
    const r = await buildAgentContributionSample({ outDir: out });
    const agent = JSON.parse(new AdmZip(fs.readFileSync(r.packagePath)).readAsText('agent.json')) as { skill_list: string[] };
    expect(agent.skill_list).toEqual(['sample-local-format']);
  });

  it('Hub Skill ID 形态不对 → 直接报错，不生成半成品', async () => {
    await expect(buildAgentContributionSample({ outDir: out, hubSkillId: 'NOT-HEX' })).rejects.toThrow('12-character');
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('版本号写进 manifest.metadata，不写进 agent.json', async () => {
    const r = await buildAgentContributionSample({ outDir: out, version: '2.3.4' });
    const manifest = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8')) as { metadata: { version: string } };
    expect(manifest.metadata.version).toBe('2.3.4');
    expect(new AdmZip(fs.readFileSync(r.packagePath)).readAsText('agent.json')).not.toContain('2.3.4');
  });

  it('同样的输入两次生成，包摘要一致（确定性，联调时双方能对账）', async () => {
    const a = await buildAgentContributionSample({ outDir: out });
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sample-out2-'));
    try {
      const b = await buildAgentContributionSample({ outDir: out2 });
      expect(b.digest).toBe(a.digest);
    } finally {
      fs.rmSync(out2, { recursive: true, force: true });
    }
  });

  it('curl 示例的请求头与真实客户端一致（含通道头），两个 part 的顺序是 manifest 在前', async () => {
    const r = await buildAgentContributionSample({ outDir: out });
    const curl = fs.readFileSync(r.curlPath, 'utf8');
    for (const h of ['Idempotency-Key', 'X-CogSeed-Client-Version', 'X-CogSeed-Platform', 'X-CogSeed-Request-ID', 'CogSeed-Channel: open']) {
      expect(curl).toContain(h);
    }
    expect(curl.indexOf('manifest=@')).toBeLessThan(curl.indexOf('package=@'));
  });
});

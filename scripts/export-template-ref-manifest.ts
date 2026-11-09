/**
 * 导出 S5 内置清单（Hub 模板引用的发布校验用），见 `src/main/features/template_ref_manifest.ts`。
 *
 *   npm run template-refs:manifest          写入 build/hub-export/（不入库、不进安装包）和 specs 里的入库副本
 *   npm run template-refs:manifest:check    入库副本过期时失败并列出差异项
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildTemplateRefManifest, type TemplateRefManifest } from '../src/main/features/template_ref_manifest';
import { BUILTIN_CAPABILITIES_ENABLE_ENV } from '../src/main/features/agent_builtin_capabilities';

// 内置能力的开放清单由环境变量开关，发布的客户端默认关闭。清单按发布默认导出：
// 关着的能力用户端用不了，模板不该引用；也避免本机开着开关时 --check 结果随环境变化。
delete process.env[BUILTIN_CAPABILITIES_ENABLE_ENV];

const root = path.resolve(__dirname, '..');
const exportFile = path.join(root, 'build', 'hub-export', 'builtin-template-refs.json');
const trackedFile = path.join(root, 'specs', '010-hub-workspace-task-templates', 'contracts', 'builtin-template-refs.json');
const rel = (p: string) => path.relative(root, p);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'builtin', '_manifest.json'), 'utf8')).inventory;
const manifest = buildTemplateRefManifest({ clientVersion: pkg.version, inventory });
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

const SECTIONS = ['role_templates', 'agents', 'skills', 'builtin_capabilities', 'connector_types'] as const;

/** 按节列出新增 / 删除 / 变化的条目，过期时告诉人改了哪里，而不是只说「不一致」。 */
function describeDrift(current: TemplateRefManifest, next: TemplateRefManifest): string[] {
  const out: string[] = [];
  if (current.client_version !== next.client_version) out.push(`client_version: ${current.client_version} → ${next.client_version}`);
  for (const section of SECTIONS) {
    const key = (x: Record<string, string>) => x.template_id ?? x.id;
    const before = new Map((current[section] ?? []).map((x) => [key(x as never), JSON.stringify(x)]));
    const after = new Map(next[section].map((x) => [key(x as never), JSON.stringify(x)]));
    for (const [id, v] of after) {
      if (!before.has(id)) out.push(`${section}: + ${id}`);
      else if (before.get(id) !== v) out.push(`${section}: ~ ${id}`);
    }
    for (const id of before.keys()) if (!after.has(id)) out.push(`${section}: - ${id}`);
  }
  return out;
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(trackedFile) ? fs.readFileSync(trackedFile, 'utf8') : '';
  if (current === serialized) {
    console.log(`[template-refs] current: ${rel(trackedFile)}`);
  } else {
    console.error(`[template-refs] stale; run npm run template-refs:manifest and commit ${rel(trackedFile)}`);
    if (current) {
      for (const line of describeDrift(JSON.parse(current), manifest)) console.error(`  ${line}`);
    }
    process.exitCode = 1;
  }
} else {
  for (const file of [exportFile, trackedFile]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serialized, 'utf8');
  }
  const n = SECTIONS.map((s) => `${s}=${manifest[s].length}`).join(' ');
  console.log(`[template-refs] wrote ${rel(exportFile)} and ${rel(trackedFile)} (${n})`);
}

/**
 * 提交资料补齐与冲突检出。
 *
 * ## 两条不变量
 *
 * 1. `C-FR-004b`：补齐**只作用于提交副本**，不静默修改本机原 Skill。本模块的所有写入
 *    都以 `ContributionStaging.dir` 为根，不接受任意目录参数——避免调用方传错把原件改了。
 * 2. 补齐的值必须**写进包内规范位置**，不能只在上传请求里另带一份。Hub `c02` 的字段表
 *    逐字：「服务端从规范化后的包内 `SKILL.md` 的 `name`/`description` 解析真值并校验一致，
 *    **只补 manifest 而不补包，不能通过**」。所以名称与说明写 frontmatter，不写别处。
 *
 * ## 版本为什么必须问贡献者
 *
 * `CustomSkill` 类型（`skills.ts`）的字段是 `{ id, name, description_zh, description_en,
 * category, status?, source, dir }`——**没有 `version`**。`SkillListing.version?` 的注释
 * 写明它只对 `source === 'marketplace'` 从 `_install.json` 读。所以本机自定义 Skill
 * 没有版本不是边缘情况，是**必经路径**：每一次首投都要贡献者填。
 *
 * ## 冲突为什么不自动取一个值
 *
 * `C-FR-004b`：「不得静默取一个值覆盖另一个值」。包内 `_meta.json.version`、安全声明里的
 * `skill.version`、贡献者填写的版本三处可能不一致，自动挑一个会让贡献者以为自己发的是
 * A 而实际发了 B。全部列成冲突交回给人。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';

import { parseSkillFrontmatter } from '../skills';
import type { ContributionStaging } from './staging';

/** 提交必需的元信息。全部来自包内或贡献者填写，**不接受**账号/条款等不可手填项。 */
export interface SubmissionMeta {
  name: string;
  description: string;
  /** 标准 SemVer。本机自定义 Skill 无此字段，首投必填。 */
  version: string;
  /** 完整安全声明 YAML；只写入暂存副本的规范路径。 */
  security_manifest: string;
}

export type SecurityNetworkAccess = 'none' | 'restricted';
export type SecurityFileAccess = 'none' | 'read_selected' | 'read_write_selected';
export type SecurityCommandAccess = 'none' | 'declared_tools';
export type SecuritySensitiveData = 'none' | 'personal' | 'credentials';

/**
 * 用户确认的是可理解的能力事实，不是 Security Manifest 的序列化格式。
 * YAML 及声明引擎所需的技术引用由主进程生成，Renderer 无权拼装安全协议。
 */
export interface SecurityQuestionnaire {
  network_access: SecurityNetworkAccess;
  network_allowlist: string;
  file_access: SecurityFileAccess;
  command_access: SecurityCommandAccess;
  external_tools: string;
  sensitive_data: SecuritySensitiveData;
}

export type MissingField = 'name' | 'description' | 'version' | 'skill_md' | 'security_manifest';

export interface FieldConflict {
  field: 'name' | 'description' | 'version';
  /** 各来源给出的不同取值，供贡献者选择。 */
  values: Array<{ source: string; value: string }>;
}

export interface CompletionState {
  /** 从副本解析出的现有值。缺失项不出现在这里。 */
  present: Partial<SubmissionMeta>;
  /** 必须补齐的字段。 */
  missing: MissingField[];
  /** 多来源取值不一致，须贡献者明确修正。 */
  conflicts: FieldConflict[];
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 标准 SemVer 校验。空串与非法形态都返回 false。 */
export function isSemver(value: string): boolean {
  return SEMVER.test(String(value || '').trim());
}

const NETWORK_ACCESS = new Set<SecurityNetworkAccess>(['none', 'restricted']);
const FILE_ACCESS = new Set<SecurityFileAccess>(['none', 'read_selected', 'read_write_selected']);
const COMMAND_ACCESS = new Set<SecurityCommandAccess>(['none', 'declared_tools']);
const SENSITIVE_DATA = new Set<SecuritySensitiveData>(['none', 'personal', 'credentials']);

function _lines(value: unknown, max: number): string[] {
  const rows = String(value || '').split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
  if (rows.length > max || rows.some((line) => line.length > 200)) throw new Error('security_declaration_value_invalid');
  return [...new Set(rows)];
}

function _validNetworkEntry(value: string): boolean {
  if (value.includes('*') || /\s/.test(value)) return false;
  if (value.startsWith('https://')) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && !parsed.username && !parsed.password && Boolean(parsed.hostname);
    } catch { return false; }
  }
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value);
}

function _writeGeneratedIfMissing(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

/**
 * 把六个通俗答案生成声明引擎需要的技术文件。
 *
 * 所有文件只写进 contribution staging。四个权限事实都必须显式选择；受限网络和
 * 外部工具还必须给出具体对象，不能把空值解释为“没有”。
 */
export function applySecurityQuestionnaire(
  staging: ContributionStaging,
  raw: Partial<SecurityQuestionnaire>,
  contributorDisplayName: string,
): void {
  const networkAccess = raw.network_access;
  const fileAccess = raw.file_access;
  const commandAccess = raw.command_access;
  const sensitiveData = raw.sensitive_data;
  if (!NETWORK_ACCESS.has(networkAccess as SecurityNetworkAccess)
    || !FILE_ACCESS.has(fileAccess as SecurityFileAccess)
    || !COMMAND_ACCESS.has(commandAccess as SecurityCommandAccess)
    || !SENSITIVE_DATA.has(sensitiveData as SecuritySensitiveData)) {
    throw new Error('security_declaration_incomplete');
  }
  const owner = String(contributorDisplayName || '').trim();
  if (!owner) throw new Error('security_declaration_owner_missing');

  const allowlist = _lines(raw.network_allowlist, 30);
  if (networkAccess === 'restricted' && allowlist.length === 0) throw new Error('network_allowlist_required');
  if (networkAccess === 'none' && allowlist.length > 0) throw new Error('network_allowlist_conflict');
  if (allowlist.some((entry) => !_validNetworkEntry(entry))) throw new Error('network_allowlist_invalid');

  const externalTools = _lines(raw.external_tools, 30);
  if (commandAccess === 'declared_tools' && externalTools.length === 0) throw new Error('external_tools_required');
  if (commandAccess === 'none' && externalTools.length > 0) throw new Error('external_tools_conflict');
  if (externalTools.some((tool) => !/^[A-Za-z0-9@._+-]{1,80}$/.test(tool))) throw new Error('external_tools_invalid');

  const current = inspectCompletion(staging).present;
  const skillId = String(staging.sourceSkillId || '').trim();
  const name = String(current.name || '').trim();
  const description = String(current.description || '').trim();
  const version = String(current.version || '').trim();
  if (!skillId || !name || !description || !isSemver(version)) throw new Error('security_declaration_metadata_incomplete');

  const permissions: Array<Record<string, unknown>> = [];
  const resources: Array<Record<string, unknown>> = [];
  const actions: Array<Record<string, unknown>> = [];
  const prohibitedPermissions: string[] = [];

  if (networkAccess === 'restricted') {
    permissions.push({ id: 'network-egress', actions: ['READ'], resource: 'network-allowlist' });
    resources.push({ id: 'network-allowlist', type: 'network', values: allowlist });
    actions.push({ id: 'network-request', permission_id: 'network-egress', external_network: true });
  } else prohibitedPermissions.push('network.*');

  if (fileAccess !== 'none') {
    const writeAllowed = fileAccess === 'read_write_selected';
    permissions.push({
      id: writeAllowed ? 'user-file-read-write' : 'user-file-read',
      actions: writeAllowed ? ['READ', 'WRITE'] : ['READ'],
      resource: 'user-selected-files',
    });
    resources.push({ id: 'user-selected-files', type: 'file', scope: 'user_selected' });
    actions.push({ id: 'read-user-selected-file', permission_id: writeAllowed ? 'user-file-read-write' : 'user-file-read' });
    if (writeAllowed) actions.push({ id: 'write-user-selected-file', permission_id: 'user-file-read-write' });
  } else prohibitedPermissions.push('filesystem.*');

  if (commandAccess === 'declared_tools') {
    permissions.push({ id: 'external-tool-execution', actions: ['EXECUTE'], resource: 'declared-tools' });
    resources.push({ id: 'declared-tools', type: 'tool', values: externalTools });
    actions.push({ id: 'execute-declared-tool', permission_id: 'external-tool-execution' });
  } else prohibitedPermissions.push('command.*');

  const personal = sensitiveData === 'personal' || sensitiveData === 'credentials';
  const credentials = sensitiveData === 'credentials';
  const classification = credentials ? 'RESTRICTED' : personal ? 'CONFIDENTIAL' : 'PUBLIC';
  const manifest = {
    manifest_version: '1.1.1',
    security_ontology: { id: 'cogseed.security.skill', version: '1.1.1' },
    skill: {
      id: skillId, name, version, description, environment: 'development',
      artifact_manifest_ref: 'artifact.yaml',
      skill_spec_ref: 'SKILL.md',
      business_ontology_ref: 'references/business-ontology.yaml',
    },
    ownership: { human_owner: owner, organization: 'Community', role: 'Contributor', technical_owner: null },
    provenance: {
      source_type: 'generated', source_uri: `cogseed://skill/${encodeURIComponent(skillId)}`,
      author: owner, checksum: 'DEFERRED_UNTIL_FREEZE', signature: null,
    },
    permissions: { required: permissions, prohibited: prohibitedPermissions },
    resources: { allowed: resources, denied: [] },
    actions: { allowed: actions, prohibited: [] },
    data_security: {
      input_classification: [classification], output_classification: [classification],
      external_transmission: networkAccess === 'restricted', pii_allowed: personal,
      secrets_allowed: credentials, retention_days: 0,
    },
    network: {
      enabled: networkAccess === 'restricted', allowlist,
      deny_private_network: true, allow_dynamic_download: false,
    },
    runtime_boundary: {
      runtime_contracts_ref: 'schemas.json#/runtime_contracts', direct_resource_access: false,
      access_via_gateway_only: true, binding_resolved_by: 'agent_layer', audit_emitted_by: 'runtime',
    },
    risk: {
      risk_level: null, trust_level: null, risk_reasons: [], maximum_impact: null,
      calculated_risk_level: null, effective_risk_level: null, calculation_rule_version: null,
      calculation_factors: null, triggered_rule_ids: [],
    },
    approval: { required: false, mode: 'none', required_for_actions: [], approver_roles: [] },
    audit: {
      enabled: true, events: commandAccess === 'declared_tools' ? ['tool_call', 'result'] : ['result'],
      include_input: false, include_output: false,
      include_tool_calls: commandAccess === 'declared_tools', include_policy_decision: false,
      retention_days: 30,
    },
    rollback: {
      supported: true, type: 'disable_skill', procedure: 'Disable the contributed Skill in Hub.',
      maximum_recovery_time_minutes: 5,
    },
    dependencies: { packages: [], external_tools: externalTools },
    tests: {
      evals_ref: 'evals/evals.json',
      validation_contract_ref: 'references/validation-contract.yaml', minimum_test_cases: 1,
    },
  };

  const artifact = {
    api_version: 'cogseed.security/v1', kind: 'SkillArtifact',
    metadata: { id: skillId, name, version, description, owner },
    spec: {
      entrypoint: 'SKILL.md',
      implementation: { language: 'markdown', scripts: [] },
      security: { ontology: 'cogseed.security.skill@1.1.1', manifest_ref: 'references/security-manifest.yaml' },
      contracts: {
        schemas: 'schemas.json', skill_spec: 'SKILL.md',
        validation_contract: 'references/validation-contract.yaml',
      },
      tests: { evals: 'evals/evals.json' },
      lifecycle: { status: 'development', rollback_ref: null },
    },
  };
  const boundary = { network_access: networkAccess, network_allowlist: allowlist, file_access: fileAccess,
    command_access: commandAccess, external_tools: externalTools, sensitive_data: sensitiveData };

  _writeGeneratedIfMissing(staging.dir, 'artifact.yaml', YAML.stringify(artifact, { lineWidth: 0 }));
  _writeGeneratedIfMissing(staging.dir, 'schemas.json', `${JSON.stringify({ runtime_contracts: boundary }, null, 2)}\n`);
  _writeGeneratedIfMissing(staging.dir, 'references/business-ontology.yaml', YAML.stringify({
    id: `community.skill.${skillId}`, version, name, description,
  }, { lineWidth: 0 }));
  _writeGeneratedIfMissing(staging.dir, 'references/validation-contract.yaml', YAML.stringify({
    kind: 'community-contribution-security-boundary', confirmed_by: owner, boundary,
  }, { lineWidth: 0 }));
  _writeGeneratedIfMissing(staging.dir, 'evals/evals.json', `${JSON.stringify({ cases: [{
    id: 'contribution-security-boundary',
    description: 'Verify the Skill stays within the contributor-confirmed security boundary.',
    expected: boundary,
  }] }, null, 2)}\n`);

  const declarationDir = path.join(staging.dir, 'references');
  fs.mkdirSync(declarationDir, { recursive: true });
  fs.writeFileSync(path.join(declarationDir, 'security-manifest.yaml'), YAML.stringify(manifest, { lineWidth: 0 }), 'utf8');
}

function _readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function _str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 盘点提交副本的元信息现状。
 *
 * 只读，不写。UI 据此渲染补齐表单；补齐后调 `applyCompletion` 再调 `inspectCompletion`
 * 复核，而不是在同一次调用里边判边写——那样一旦写失败，返回的状态与盘上不符。
 */
export function inspectCompletion(staging: ContributionStaging): CompletionState {
  const skillMd = path.join(staging.dir, 'SKILL.md');
  const hasSkillMd = fs.existsSync(skillMd);
  const fm = hasSkillMd ? parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf8')) : {};
  const meta = _readJson(path.join(staging.dir, '_meta.json')) ?? {};

  const fmName = _str(fm.name);
  // 说明允许 frontmatter 的 description 或双语字段之一。
  const fmDesc = _str(fm.description) || _str(fm.description_zh) || _str(fm.description_en);
  const metaVersion = _str(meta.version);
  const declarationFile = path.join(staging.dir, 'references', 'security-manifest.yaml');
  const securityManifest = fs.existsSync(declarationFile) ? fs.readFileSync(declarationFile, 'utf8') : '';

  const present: Partial<SubmissionMeta> = {};
  const missing: MissingField[] = [];
  if (!hasSkillMd) missing.push('skill_md');
  if (fmName) present.name = fmName; else missing.push('name');
  if (fmDesc) present.description = fmDesc; else missing.push('description');
  if (metaVersion) present.version = metaVersion; else missing.push('version');
  if (securityManifest.trim()) present.security_manifest = securityManifest;
  else missing.push('security_manifest');

  // 冲突：`_meta.json` 的名称/说明若与 frontmatter 不一致，两者都有效来源，不替贡献者选。
  const conflicts: FieldConflict[] = [];
  const metaName = _str(meta.name);
  if (fmName && metaName && fmName !== metaName) {
    conflicts.push({
      field: 'name',
      values: [{ source: 'SKILL.md', value: fmName }, { source: '_meta.json', value: metaName }],
    });
  }
  const metaDesc = _str(meta.description)
    || _str((meta.descriptions as Record<string, unknown> | undefined)?.zh)
    || _str((meta.descriptions as Record<string, unknown> | undefined)?.en);
  if (fmDesc && metaDesc && fmDesc !== metaDesc) {
    conflicts.push({
      field: 'description',
      values: [{ source: 'SKILL.md', value: fmDesc }, { source: '_meta.json', value: metaDesc }],
    });
  }

  return { present, missing, conflicts };
}

/**
 * 把贡献者填写的值写进副本的**规范位置**。
 *
 * 名称与说明写 `SKILL.md` frontmatter（Hub 从包内解析真值并比对，只补 manifest 不作数）；
 * 版本写 `_meta.json`（迭代一的版本落点）。
 *
 * 写完必须重跑准入与预览（`C-FR-004c`）——本函数不代劳，因为"写"和"重判"分开才能让
 * 调用方在两者之间失败时状态仍然一致。
 */
export function applyCompletion(staging: ContributionStaging, patch: Partial<SubmissionMeta>): void {
  const name = _str(patch.name);
  const description = _str(patch.description);
  const version = _str(patch.version);
  const securityManifest = typeof patch.security_manifest === 'string' ? patch.security_manifest.trim() : '';

  if (version && !isSemver(version)) throw new Error('invalid_semver');

  if (name || description) {
    const skillMd = path.join(staging.dir, 'SKILL.md');
    const text = fs.existsSync(skillMd) ? fs.readFileSync(skillMd, 'utf8') : '';
    fs.writeFileSync(skillMd, _upsertFrontmatter(text, {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    }), 'utf8');
  }

  if (version) {
    const metaFile = path.join(staging.dir, '_meta.json');
    const meta = _readJson(metaFile) ?? {};
    fs.writeFileSync(metaFile, `${JSON.stringify({ ...meta, version }, null, 2)}\n`, 'utf8');
  }

  if (securityManifest) {
    if (Buffer.byteLength(securityManifest, 'utf8') > 128 * 1024) throw new Error('security_manifest_too_large');
    let parsed: unknown;
    try { parsed = YAML.parse(securityManifest); } catch { throw new Error('invalid_security_manifest_yaml'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_security_manifest_yaml');
    const declarationDir = path.join(staging.dir, 'references');
    fs.mkdirSync(declarationDir, { recursive: true });
    fs.writeFileSync(path.join(declarationDir, 'security-manifest.yaml'), `${securityManifest}\n`, 'utf8');
  }
}

/**
 * 在 frontmatter 中写入或替换标量键，保留其余内容与正文。
 *
 * 不用通用 YAML 序列化：副本里的 frontmatter 可能含本解析器不认识的结构（列表、嵌套），
 * 整体重写会把它们丢掉——而那是贡献者的内容。只动目标行是唯一不损失信息的做法。
 */
function _upsertFrontmatter(text: string, patch: Record<string, string>): string {
  const quote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  if (!text.startsWith('---')) {
    const head = Object.entries(patch).map(([k, v]) => `${k}: ${quote(v)}`).join('\n');
    return `---\n${head}\n---\n\n${text}`;
  }
  const end = text.indexOf('---', 3);
  if (end === -1) {
    const head = Object.entries(patch).map(([k, v]) => `${k}: ${quote(v)}`).join('\n');
    return `---\n${head}\n---\n\n${text}`;
  }

  const lines = text.slice(3, end).split('\n');
  const remaining = { ...patch };
  const out = lines.map((line) => {
    const colon = line.indexOf(':');
    if (colon <= 0 || /^\s/.test(line) || line.trim().startsWith('-') || line.startsWith('#')) return line;
    const key = line.slice(0, colon).trim();
    if (!(key in remaining)) return line;
    const value = remaining[key];
    delete remaining[key];
    return `${key}: ${quote(value)}`;
  });
  for (const [k, v] of Object.entries(remaining)) out.push(`${k}: ${quote(v)}`);

  return `---${out.join('\n')}---${text.slice(end + 3)}`;
}

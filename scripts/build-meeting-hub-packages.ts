/**
 * Two-stage author-package build, with no network or user-data writes.
 * First build independent Skills. Hub assigns their IDs on normal import.
 * Only an explicit target-Hub binding can produce an Agent archive: symbolic
 * template refs become Hub content IDs, never private Skill names or legacy IDs.
 * Bindings are environment-specific deployment receipts, not source identity.
 * Hub supplies publication metadata; input ZIP hashes are not artifact hashes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { validateAgentJson } from '../src/main/features/contribution/agent-package-rules';
import { parseMarketplaceSemver } from '../src/main/features/marketplace-update-policy';

interface ContentRelease {
  source_key: string;
  name: string;
  version: string;
  default_install: boolean;
}
export interface HubSkillBindings {
  hub_origin: string;
  skills: Record<string, { content_id: string; version: string }>;
}
export interface MeetingArchive extends ContentRelease {
  kind: 'skill' | 'agent';
  filename: string;
  bytes: Buffer;
  sha256: string;
}
function zipTree(root: string): Buffer {
  const zip = new AdmZip();
  const visit = (relative: string): void => {
    const dir = path.join(root, relative);
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name === '.DS_Store' || item.name === '__pycache__' || item.name.endsWith('.pyc')) continue;
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`Symlink is not importable: ${name}`);
      if (item.isDirectory()) { visit(name); continue; }
      if (!item.isFile()) throw new Error(`Unsupported package entry: ${name}`);
      zip.addFile(name, fs.readFileSync(path.join(root, name)));
      // ZIP timestamps must not make the receipt change between identical builds.
      zip.getEntry(name)!.header.time = new Date(2000, 0, 1);
    }
  };
  visit('');
  return zip.toBuffer();
}

export function buildMeetingHubPackages(
  sourceRoot = path.resolve(__dirname, '../distribution/meeting'),
  bindings?: HubSkillBindings,
) {
  const release = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'release.json'), 'utf8')) as {
    min_app_version: string; skills: ContentRelease[]; agent: ContentRelease;
  };
  if (!parseMarketplaceSemver(release.min_app_version)) throw new Error('Invalid minimum app version');
  const rows = [...release.skills, release.agent];
  if (new Set(rows.map((row) => row.source_key)).size !== rows.length) throw new Error('Duplicate source key');
  for (const row of rows) {
    if (!/^[a-z][a-z0-9-]*$/.test(row.source_key) || !parseMarketplaceSemver(row.version)) throw new Error('Invalid source key or version');
  }
  const archives: MeetingArchive[] = [];
  const add = (kind: 'agent' | 'skill', row: ContentRelease, bytes: Buffer) => {
    archives.push({ ...row, kind, filename: `${kind}-${row.source_key}-${row.version}.zip`, bytes,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  };
  for (const row of release.skills) {
    const dir = path.join(sourceRoot, 'skills', row.source_key);
    const markdown = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    if (!markdown.startsWith('---\n') || !markdown.includes(`\nname: ${row.name}\n`)) throw new Error('Skill identity mismatch');
    add('skill', row, zipTree(dir));
  }
  if (bindings) {
    const origin = new URL(bindings.hub_origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== bindings.hub_origin || origin.username || origin.password) {
      throw new Error('Bindings require the exact target Hub origin');
    }
    const names = release.skills.map((row) => row.source_key);
    if (Object.keys(bindings.skills).sort().join(',') !== [...names].sort().join(',')) throw new Error('Incomplete or unexpected Skill bindings');
    const ids = names.map((name) => {
      const ref = bindings.skills[name];
      if (!/^[a-f0-9]{12}$/.test(ref?.content_id) || !parseMarketplaceSemver(ref?.version ?? '')) throw new Error(`Invalid Hub binding: ${name}`);
      return ref.content_id;
    });
    if (new Set(ids).size !== ids.length) throw new Error('Different Skills must have different Hub IDs');
    const dir = path.join(sourceRoot, 'agents', release.agent.source_key);
    const template = JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8'));
    if ('agent_id' in template || template.name !== release.agent.name || JSON.stringify(template.skill_list) !== JSON.stringify(names)) {
      throw new Error('Agent template must use symbolic Skill refs and no assigned Agent ID');
    }
    if (fs.existsSync(path.join(dir, 'skills')) || fs.existsSync(path.join(dir, '_meta.json'))) throw new Error('No private Skills or publication metadata in Agent author source');
    const agent = { ...template, skill_list: ids };
    const checked = validateAgentJson(agent);
    if (checked.ok === false) throw new Error(`Invalid Agent: ${JSON.stringify(checked.issues)}`);
    const zip = new AdmZip();
    zip.addFile('agent.json', Buffer.from(`${JSON.stringify(agent, null, 2)}\n`));
    zip.getEntry('agent.json')!.header.time = new Date(2000, 0, 1);
    add('agent', release.agent, zip.toBuffer());
  }
  return { release, archives };
}

if (require.main === module) {
  const output = process.argv[2];
  const bindingsFile = process.argv[3];
  if (!output) throw new Error('Usage: node --import tsx scripts/build-meeting-hub-packages.ts <new-output-directory> [published-skill-bindings.json]');
  const bindings = bindingsFile ? JSON.parse(fs.readFileSync(bindingsFile, 'utf8')) as HubSkillBindings : undefined;
  const { release, archives } = buildMeetingHubPackages(undefined, bindings);
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target); // Never overwrite an already reviewed delivery.
  for (const archive of archives) fs.writeFileSync(path.join(target, archive.filename), archive.bytes, { flag: 'wx' });
  const manifest = {
    status: 'prepared_not_published', import_mode: 'new_content', min_app_version: release.min_app_version,
    ...(bindings ? { target_hub: bindings.hub_origin, skill_bindings: bindings.skills } : {}),
    agent_pending_skill_bindings: !bindings,
    import_order: archives.map(({ bytes, ...row }) => ({ ...row, size_bytes: bytes.length })),
  };
  fs.writeFileSync(path.join(target, 'import-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  fs.copyFileSync(path.resolve(__dirname, '../distribution/meeting/README.md'), path.join(target, 'README.md'));
  process.stdout.write(`Prepared ${archives.length} Hub import archives at ${target}\n`);
}

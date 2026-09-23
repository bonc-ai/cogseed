#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_LOGIN_RE = /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const TEXT_EXTENSIONS = new Set(['.json', '.md', '.txt', '.yaml', '.yml']);
const ALLOWED_TOP_LEVEL = new Set([
  'SKILL.md',
  'evals',
  'examples',
  'provenance.json',
  'references',
  'templates',
]);
const ALLOWED_ROOT_FILES = new Set(['README.md', 'README.zh-CN.md']);
const REQUIRED_FILES = ['SKILL.md', 'evals/evals.json', 'provenance.json'];
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;
const MAX_FILES = 30;
const PLACEHOLDER_RE = /replace-with|\bTODO\b|\bTBD\b|待填写|请填写|填写你的/i;
const MACHINE_PATH_RE = /(?:\/Users\/[^\s/]+\/|\/home\/[^\s/]+\/|[A-Za-z]:\\Users\\[^\s\\]+\\|file:\/\/)/;

function normalizeRel(value) {
  return value.split(path.sep).join('/');
}

function readRootArg(argv) {
  const index = argv.indexOf('--root');
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1]);
  return REPO_ROOT;
}

function walkPackage(packageDir, packageId, errors) {
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = normalizeRel(path.relative(packageDir, full));
      const stat = fs.lstatSync(full);

      if (stat.isSymbolicLink()) {
        errors.push(`${packageId}/${rel}: symbolic links are not allowed`);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        errors.push(`${packageId}/${rel}: only regular files are allowed`);
        continue;
      }

      files.push({ full, rel, stat });
    }
  }

  walk(packageDir);
  return files;
}

function parseFrontmatter(text, label, errors) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    errors.push(`${label}: SKILL.md must start with YAML frontmatter`);
    return null;
  }

  const fields = new Map();
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      errors.push(`${label}: unsupported frontmatter line: ${line}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (fields.has(key)) errors.push(`${label}: duplicate frontmatter field: ${key}`);
    fields.set(key, value);
  }

  const unexpected = [...fields.keys()].filter((key) => key !== 'name' && key !== 'description');
  if (unexpected.length) {
    errors.push(`${label}: community frontmatter allows only name and description; found ${unexpected.join(', ')}`);
  }
  return { fields, body: text.slice(match[0].length) };
}

function readJson(file, label, errors) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

function validateEvals(packageDir, packageId, errors) {
  const label = `${packageId}/evals/evals.json`;
  const parsed = readJson(path.join(packageDir, 'evals', 'evals.json'), label, errors);
  if (!parsed) return;
  const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
  if (cases.length < 2) errors.push(`${label}: cases must contain at least one positive and one negative case`);

  const kinds = new Set();
  const ids = new Set();
  for (const [index, item] of cases.entries()) {
    const caseLabel = `${label}: cases[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${caseLabel} must be an object`);
      continue;
    }
    if (item.kind !== 'positive' && item.kind !== 'negative') {
      errors.push(`${caseLabel}.kind must be positive or negative`);
    } else {
      kinds.add(item.kind);
    }
    for (const field of ['id', 'input', 'expected']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) {
        errors.push(`${caseLabel}.${field} must be a non-empty string`);
      }
    }
    if (typeof item.id === 'string') {
      if (ids.has(item.id)) errors.push(`${caseLabel}.id must be unique`);
      ids.add(item.id);
    }
  }
  if (!kinds.has('positive')) errors.push(`${label}: a positive case is required`);
  if (!kinds.has('negative')) errors.push(`${label}: a negative case is required`);
}

function validateProvenance(packageDir, packageId, errors) {
  const label = `${packageId}/provenance.json`;
  const parsed = readJson(path.join(packageDir, 'provenance.json'), label, errors);
  if (!parsed) return;

  if (typeof parsed.author_github !== 'string' || !GITHUB_LOGIN_RE.test(parsed.author_github)) {
    errors.push(`${label}: author_github must be a GitHub login`);
  }
  if (typeof parsed.original_work !== 'boolean') {
    errors.push(`${label}: original_work must be true or false`);
  }
  if (!Array.isArray(parsed.third_party_materials)) {
    errors.push(`${label}: third_party_materials must be an array`);
    return;
  }
  if (parsed.original_work === false && parsed.third_party_materials.length === 0) {
    errors.push(`${label}: non-original work must list its third-party materials`);
  }
  for (const [index, item] of parsed.third_party_materials.entries()) {
    const sourceLabel = `${label}: third_party_materials[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${sourceLabel} must be an object`);
      continue;
    }
    for (const field of ['name', 'url', 'license']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) {
        errors.push(`${sourceLabel}.${field} must be a non-empty string`);
      }
    }
    if (typeof item.url === 'string' && !/^https:\/\//i.test(item.url)) {
      errors.push(`${sourceLabel}.url must use https`);
    }
  }
}

function validateSkillBody(packageDir, packageId, errors) {
  const label = `${packageId}/SKILL.md`;
  const text = fs.readFileSync(path.join(packageDir, 'SKILL.md'), 'utf8');
  const parsed = parseFrontmatter(text, label, errors);
  if (!parsed) return;

  const name = parsed.fields.get('name');
  const description = parsed.fields.get('description');
  if (name !== packageId) errors.push(`${label}: frontmatter name must equal directory name ${packageId}`);
  if (typeof description !== 'string' || description.trim().length < 20) {
    errors.push(`${label}: description must contain at least 20 characters`);
  }

  const requiredPatterns = [
    [/use_when\s*:/i, 'use_when:'],
    [/do_not_use_when\s*:/i, 'do_not_use_when:'],
    [/^##\s+(输入|Input)\s*$/im, 'an Input section'],
    [/^##\s+(工作流|Workflow)\s*$/im, 'a Workflow section'],
    [/^##\s+(输出|Output)\s*$/im, 'an Output section'],
    [/^##\s+(边界|Boundaries)\s*$/im, 'a Boundaries section'],
    [/不联网|no network access/i, 'an explicit no-network boundary'],
    [/不执行脚本|does not execute scripts/i, 'an explicit no-script boundary'],
    [/不写入外部系统|does not write to external systems/i, 'an explicit no-external-write boundary'],
    [/production_release_allowed\s*:\s*false/i, 'production_release_allowed: false'],
  ];
  for (const [pattern, expectation] of requiredPatterns) {
    if (!pattern.test(parsed.body)) errors.push(`${label}: missing ${expectation}`);
  }
}

function validatePackage(packageDir, packageId) {
  const errors = [];
  if (!PACKAGE_ID_RE.test(packageId)) {
    errors.push(`${packageId}: directory name must use lowercase ASCII kebab-case`);
  }

  const files = walkPackage(packageDir, packageId, errors);
  if (files.length > MAX_FILES) errors.push(`${packageId}: package contains more than ${MAX_FILES} files`);
  const totalBytes = files.reduce((sum, file) => sum + file.stat.size, 0);
  if (totalBytes > MAX_PACKAGE_BYTES) errors.push(`${packageId}: package exceeds ${MAX_PACKAGE_BYTES} bytes`);

  const present = new Set(files.map((file) => file.rel));
  for (const required of REQUIRED_FILES) {
    if (!present.has(required)) errors.push(`${packageId}: missing required file ${required}`);
  }

  for (const file of files) {
    const top = file.rel.split('/', 1)[0];
    if (!ALLOWED_TOP_LEVEL.has(top)) {
      errors.push(`${packageId}/${file.rel}: top-level path ${top} is not allowed in the pilot`);
    }
    if (!TEXT_EXTENSIONS.has(path.extname(file.rel).toLowerCase())) {
      errors.push(`${packageId}/${file.rel}: only text-based .md/.json/.txt/.yaml/.yml files are allowed`);
    }
    if (file.stat.size > MAX_FILE_BYTES) {
      errors.push(`${packageId}/${file.rel}: file exceeds ${MAX_FILE_BYTES} bytes`);
      continue;
    }
    if ((file.stat.mode & 0o111) !== 0) {
      errors.push(`${packageId}/${file.rel}: executable files are not allowed`);
    }

    const text = fs.readFileSync(file.full, 'utf8');
    if (text.includes('\uFFFD')) errors.push(`${packageId}/${file.rel}: file is not valid UTF-8 text`);
    if (PLACEHOLDER_RE.test(text)) errors.push(`${packageId}/${file.rel}: unresolved template placeholder found`);
    if (MACHINE_PATH_RE.test(text)) errors.push(`${packageId}/${file.rel}: machine-specific absolute path found`);
  }

  if (present.has('SKILL.md')) validateSkillBody(packageDir, packageId, errors);
  if (present.has('evals/evals.json')) validateEvals(packageDir, packageId, errors);
  if (present.has('provenance.json')) validateProvenance(packageDir, packageId, errors);
  return errors;
}

export function validateCommunitySkills(repoRoot) {
  const root = path.join(repoRoot, 'community', 'skills');
  if (!fs.existsSync(root)) {
    return { packages: [], errors: ['community/skills: directory is missing'] };
  }

  const rootErrors = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      rootErrors.push(`community/skills/${entry.name}: symbolic links are not allowed`);
    } else if (entry.isFile() && !ALLOWED_ROOT_FILES.has(entry.name)) {
      rootErrors.push(`community/skills/${entry.name}: unexpected file at the Skill collection root`);
    }
  }
  const packages = entries
    .filter((entry) => entry.isDirectory() && entry.name !== '_template')
    .map((entry) => entry.name)
    .sort();
  const errors = [
    ...rootErrors,
    ...packages.flatMap((packageId) => validatePackage(path.join(root, packageId), packageId)),
  ];
  return { packages, errors };
}

function main() {
  const root = readRootArg(process.argv);
  const result = validateCommunitySkills(root);
  if (result.errors.length) {
    console.error(`Community Skill verification failed (${result.errors.length} problem(s)):`);
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Community Skill verification passed: ${result.packages.length} candidate package(s).`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();

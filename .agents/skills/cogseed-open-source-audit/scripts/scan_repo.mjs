#!/usr/bin/env node

/*
 * Local, read-only repository audit. This intentionally uses only Node built-ins
 * and Git so that running an audit never downloads code or a vulnerability DB.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const PLACEHOLDER_RE = /(synthetic-(?:secret|token)|test-token|dummy-token|fake-secret|secret-value|stored-secret|redacted|placeholder|changeme|your[-_ ]?(?:api[-_ ]?key|token|secret|password)|\[(?:token|secret|aws-key|private-key) sha256:[a-f0-9]{12}\]|<[^>]{1,80}>|\$\{[^}]+\}|\$[A-Z][A-Z0-9_]+|process\.env\b|os\.environ\b)/i;
const FIXTURE_PATH_RE = /\/(?:Users|home)\/(?:test|tester|example|runner|user)(?:\/|$)/i;
const DOC_IP_RE = /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function usage() {
  console.log('Usage: node scripts/scan_repo.mjs --mode diff|repo [--base REF] [--allow RULE[:PATH]]');
}

function parseArgs(argv) {
  const options = { mode: 'diff', allows: [] };
  const nextValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    if (arg === '--mode') options.mode = nextValue(i++, arg);
    else if (arg === '--base') options.base = nextValue(i++, arg);
    else if (arg === '--allow') options.allows.push(nextValue(i++, arg));
    else if (arg === '--report') throw new Error('--report is disabled; this audit only prints findings and never writes a report file');
    else if (arg === '--run-project-checks') throw new Error('--run-project-checks is disabled; this audit never executes repository code');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['diff', 'repo'].includes(options.mode)) throw new Error('--mode must be diff or repo');
  return options;
}

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    const detail = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout;
}

function readGitBlob(cwd, ref, rel) {
  const result = spawnSync('git', ['show', `${ref}:${rel}`], {
    cwd,
    encoding: null,
    maxBuffer: MAX_FILE_BYTES + 1,
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) return null;
  return result.stdout;
}

function splitNul(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function mask(value, label = 'value') {
  return `[${label} sha256:${sha(value)}]`;
}

function isFixtureContext(line) {
  const lower = String(line || '').toLowerCase();
  return /(?:fixture|sample|synthetic|dummy|fake|test[-_ ]data|documentation|known_credential_prefix|private_key_block|bearer_token)/i.test(lower);
}

function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(String(value || ''));
}

function redactText(input) {
  let text = String(input || '').replace(/\0/g, '');
  text = text.replace(/-----BEGIN [^-\n]{1,80}PRIVATE KEY-----.*?(?:-----END [^-\n]{1,80}PRIVATE KEY-----)?/gi, (v) => mask(v, 'private-key'));
  text = text.replace(/(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi, (_, prefix, value) => `${prefix}${mask(value, 'token')}`);
  text = text.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, (v) => mask(v, 'aws-key'));
  text = text.replace(/\b(?:ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_\-]{12,}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/\bAIza[A-Za-z0-9_-]{35}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/\bnpm_[A-Za-z0-9]{36}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/\bhf_[A-Za-z0-9]{20,}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g, (v) => mask(v, 'token'));
  text = text.replace(/((?:api[-_ ]?key|password|passwd|secret|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret)\s*[:=]\s*["']?)([^\s"',;}]{8,})/gi, (_, prefix, value) => `${prefix}${mask(value, 'secret')}`);
  text = text.replace(/\b([A-Z0-9._%+-])[A-Z0-9._%+-]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, (_, first, domain) => {
    const safeDomain = /(?:internal|intra|corp|lan|local|private)/i.test(domain) ? mask(domain, 'email-domain') : domain;
    return `${first}***@${safeDomain}`;
  });
  text = text.replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, (v) => mask(v, 'phone'));
  text = text.replace(/(?<!\d)1[3-9]\d{1}[- ]\d{4}[- ]\d{4}(?!\d)/g, (v) => mask(v, 'phone'));
  text = text.replace(/(?:\/Users\/|\/home\/)([^/\s"'`]+)/gi, (_, user) => `${text.includes('/Users/') ? '/Users/' : '/home/'}${mask(user, 'user')}`);
  text = text.replace(/([A-Za-z]:\\Users\\)([^\\\s"'`]+)/gi, (_, prefix, user) => `${prefix}${mask(user, 'user')}`);
  text = text.replace(/(https?:\/\/)([^\s/]+)([^\s]*)/gi, (full, scheme, host, rest) => {
    if (/^(?:localhost|127\.0\.0\.1|\[::1\]|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/i.test(host)) return full;
    if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(host) || /(?:\.internal|\.intra|\.corp|\.lan)$/i.test(host) || /gitlab|jira|jenkins/i.test(host)) return `${scheme}${mask(host, 'internal-host')}${rest}`;
    return full;
  });
  return text.slice(0, 280);
}

function parseAllow(value) {
  const index = value.indexOf(':');
  return index < 0 ? { rule: value, path: null } : { rule: value.slice(0, index), path: value.slice(index + 1) };
}

function allowed(allows, ruleId, rel) {
  return allows.some((raw) => {
    const item = parseAllow(raw);
    if (item.rule !== ruleId) return false;
    return !item.path || item.path === rel || rel.startsWith(`${item.path.replace(/\/$/, '')}/`);
  });
}

function isIgnoredRiskPath(rel) {
  return !/(?:^|\/)(?:node_modules|\.git|venv|\.venv|__pycache__|resources\/runtime|\.build|dist|build|coverage|tmp|temp)(?:\/|$)/i.test(rel) && /(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials?(?:\.[^/]+)?|secrets?(?:\.[^/]+)?|auth(?:\.[^/]+)?|tokens?(?:\.[^/]+)?|cookies?(?:\.[^/]+)?|id_(?:rsa|ed25519)|codex[-_ ]clipboard[^/]*|screenshot[^/]*|screen[-_ ]shot[^/]*|.*\.(?:pem|key|p12|pfx|log|dump|dmp|trace))$/i.test(rel);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = fs.realpathSync.native(path.resolve(git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()));
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'DETACHED';
  const report = { schemaVersion: 1, tool: 'cogseed-open-source-audit', mode: options.mode, branch: redactText(branch), base: null, repositoryName: redactText(path.basename(root)), generatedAt: new Date().toISOString(), findings: [], exemptions: [], checks: [], filesScanned: 0, status: 'UNKNOWN' };
  const errors = [];

  const add = (finding) => {
    const rawPath = finding.path || null;
    const normalized = { ...finding, path: rawPath ? redactText(rawPath) : null, line: finding.line || null, snippet: redactText(finding.snippet || '') };
    normalized.fingerprint = sha(`${normalized.ruleId}|${normalized.path}|${normalized.line}|${normalized.snippet}`);
    if (allowed(options.allows, normalized.ruleId, rawPath || '')) {
      report.exemptions.push({ ruleId: normalized.ruleId, path: normalized.path, line: normalized.line, fingerprint: sha(`${normalized.ruleId}:${normalized.path}:${normalized.line}:${normalized.snippet}`) });
      return;
    }
    const key = `${normalized.ruleId}|${normalized.path}|${normalized.line}|${normalized.snippet}`;
    if (!report.findings.some((item) => `${item.ruleId}|${item.path}|${item.line}|${item.snippet}` === key)) report.findings.push(normalized);
  };

  let status;
  try { status = git(root, ['status', '--porcelain=v1', '-z']); } catch (error) { errors.push(error.message); }
  let paths = [];
  let trackedPaths = new Set();
  let diffBase = null;
  try { trackedPaths = new Set(splitNul(git(root, ['ls-files', '-z']))); } catch (error) { errors.push(error.message); }
  try {
    if (options.mode === 'repo') {
      paths = [...trackedPaths];
    } else {
      let base = options.base;
      if (!base) {
        base = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true })?.trim() || null;
        if (!base) for (const candidate of ['origin/develop', 'origin/main']) {
          if (git(root, ['rev-parse', '--verify', `${candidate}^{commit}`], { allowFailure: true })) { base = candidate; break; }
        }
      }
      if (!base || !git(root, ['rev-parse', '--verify', `${base}^{commit}`], { allowFailure: true })) throw new Error('Unable to resolve a diff base; pass --base <ref>');
      diffBase = base;
      report.base = base;
      paths = [
        ...splitNul(git(root, ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', `${base}...HEAD`])),
        ...splitNul(git(root, ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB'])),
        ...splitNul(git(root, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACDMRTUXB'])),
        ...splitNul(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])),
        ...splitNul(git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).filter(isIgnoredRiskPath),
      ];
    }
  } catch (error) { errors.push(error.message); }
  paths = [...new Set(paths)].filter((rel) => rel && !rel.startsWith('../') && !path.isAbsolute(rel));
  report.filesScanned = paths.length;
  if (!paths.length && !errors.length) add({ ruleId: 'SCAN_UNKNOWN', severity: 'HIGH', category: 'scan', message: 'No files could be established for the selected scope.', remediation: 'Confirm that this is a Git repository with commits and pass an explicit base ref if using diff mode.' });

  const seenFiles = [];
  for (const rel of paths) {
    const absolute = path.join(root, rel);
    let stat;
    let bytes;
    try {
      stat = fs.lstatSync(absolute);
      if (!stat.isFile()) continue;
      if (stat.size <= MAX_FILE_BYTES) bytes = fs.readFileSync(absolute);
    } catch (error) {
      if (error.code !== 'ENOENT') { errors.push(`${rel}: ${error.message}`); continue; }
      bytes = readGitBlob(root, 'HEAD', rel) || (diffBase ? readGitBlob(root, diffBase, rel) : null);
      if (!bytes) {
        errors.push(`${rel}: file content could not be read from the working tree or Git objects`);
        continue;
      }
    }
    seenFiles.push(rel);
    const size = stat?.size ?? bytes.length;
    scanPath(rel, add);
    if (size > LARGE_FILE_BYTES) add({ ruleId: 'FILE_LARGE', severity: 'LOW', category: 'file', path: rel, message: `File is ${Math.ceil(size / 1024 / 1024)} MiB and may be a generated or private resource.`, remediation: 'Remove it from the release or document why this large asset is intentionally public.' });
    if (size > MAX_FILE_BYTES) { add({ ruleId: 'SCAN_UNKNOWN', severity: 'HIGH', category: 'scan', path: rel, message: 'File exceeds the scanner safety limit and was not inspected.', remediation: 'Review the file separately or reduce its size before publishing.' }); continue; }
    const binary = bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0);
    if (binary) {
      add({ ruleId: 'FILE_BINARY', severity: 'LOW', category: 'file', path: rel, message: 'Binary or media file is in the selected scope.', remediation: 'Confirm that this binary is public, licensed, and required for the source distribution.' });
      continue;
    }
    let text;
    try { text = UTF8_DECODER.decode(bytes); } catch (error) { errors.push(`${rel}: invalid UTF-8 (${error.message})`); continue; }
    scanContent(rel, text, add);
  }

  report.files = [...seenFiles].sort().map((rel) => redactText(rel));
  checkGeneratedPaths(seenFiles, add);
  checkLicenses(root, trackedPaths, new Set(paths), report, add, errors);
  if (status === null) errors.push('Git status could not be read');
  if (errors.length) add({ ruleId: 'SCAN_UNKNOWN', severity: 'HIGH', category: 'scan', message: 'The audit encountered an unreadable repository state or file.', remediation: 'Resolve the listed scan errors and rerun; an unknown result must not be published.' });
  report.scanErrors = errors.map((error) => redactText(error));

  runLocalChecks(report, add);
  report.findings.sort((left, right) => {
    const severity = { HIGH: 0, LOW: 1 };
    return (severity[left.severity] ?? 2) - (severity[right.severity] ?? 2)
      || String(left.path || '').localeCompare(String(right.path || ''))
      || (left.line || 0) - (right.line || 0)
      || left.ruleId.localeCompare(right.ruleId);
  });
  if (report.findings.some((finding) => finding.severity === 'HIGH')) report.status = 'BLOCKED';
  else if (report.findings.length) report.status = 'PASS_WITH_WARNINGS';
  else report.status = 'PASS';
  printFindings(report);
  process.exitCode = report.status === 'BLOCKED' ? 1 : 0;
}

function printFindings(report) {
  if (!report.findings.length) {
    console.log('No issues found.');
    console.log(report.status);
    return;
  }
  for (const finding of report.findings) {
    const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}` : '(repository)';
    console.log(`[${finding.severity}] ${finding.ruleId} ${location}`);
    console.log(`Category: ${finding.category}`);
    console.log(`Problem: ${finding.message}`);
    if (finding.snippet) console.log(`Evidence: ${finding.snippet}`);
    console.log(`Fix: ${finding.remediation}`);
    console.log(`Fingerprint: ${finding.fingerprint}`);
  }
  console.log(`Result: ${report.status}`);
}

function scanPath(rel, add) {
  const lower = rel.toLowerCase();
  const name = path.basename(lower);
  if (/^\.env(?:\..*)?$/.test(name) && !/^\.env\.(?:example|sample|template)$/.test(name)) add({ ruleId: 'FILE_AUTH_CONFIG', severity: 'HIGH', category: 'release-file', path: rel, message: 'Environment file is in scope and may contain deployment secrets.', remediation: 'Remove the real environment file and provide only a redacted example template.' });
  if (/(?:^|\/)(?:credentials?|secrets?|auth|tokens?|cookies?)(?:\.(?:json|ya?ml|toml|ini|conf|txt|db))?$/.test(name) || /(?:^|\/)(?:id_rsa|id_ed25519|server|client)\.(?:pem|key|p12|pfx)$/.test(lower) || /\.npmrc$/.test(name)) add({ ruleId: 'FILE_AUTH_CONFIG', severity: 'HIGH', category: 'release-file', path: rel, message: 'Authentication or credential file is in scope.', remediation: 'Remove it from the public tree and rotate any credentials it contained.' });
  if (/(?:codex[-_ ]clipboard|clipboard[-_ ]|(?:^|[-_ ])screenshot|screen[-_ ]shot)/i.test(name)) add({ ruleId: 'FILE_INTERNAL_MATERIAL', severity: 'HIGH', category: 'release-file', path: rel, message: 'Clipboard or screenshot artifact may contain private conversation or environment data.', remediation: 'Remove it or replace it with an intentionally public, reviewed asset.' });
  const documentLike = /\.(?:md|mdx|txt|rst|docx?|pdf|csv|xlsx?|ya?ml)$/i.test(name);
  if (/(?:release[-_ ]checklist|pre[-_ ]release|confidential|private|internal|draft)/i.test(name) && (documentLike || /release[-_ ]checklist|pre[-_ ]release/i.test(name))) add({ ruleId: 'FILE_INTERNAL_MATERIAL', severity: 'HIGH', category: 'release-file', path: rel, message: 'Filename indicates internal or unfinished release material.', remediation: 'Move the working document outside the public repository or rename/review it as public documentation.' });
  if (/(?:^|[-_.])(?:debug|error|crash|heap|session)[-_.].*\.log$|\.(?:dump|dmp|trace)$|(?:^|\/)(?:dump|logs?|crash-reports?)(?:\/|$)/i.test(lower)) add({ ruleId: 'FILE_LOG_DUMP', severity: 'HIGH', category: 'release-file', path: rel, message: 'Log, crash, session, or dump artifact is in scope.', remediation: 'Remove it and inspect it for credentials or personal data before any separate sharing.' });
  if (/(?:^|\/)(?:dist|build|coverage|\.cache|\.pytest_cache|\.build|tmp|temp|out)(?:\/|$)/i.test(lower) || /(?:\.map$|\.tsbuildinfo$)/i.test(lower)) add({ ruleId: 'FILE_GENERATED', severity: 'LOW', category: 'release-file', path: rel, message: 'Generated, cache, or build output is in scope.', remediation: 'Keep only reproducible source or explicitly public distribution assets.' });
}

function scanContent(rel, text, add) {
  const lines = text.split(/\r?\n/);
  const addLine = (ruleId, severity, category, line, snippet, message, remediation) => add({ ruleId, severity, category, path: rel, line, snippet, message, remediation });
  const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i;
  const bearer = /\bBearer\s+([A-Za-z0-9._~+/=-]{12,})/i;
  const knownToken = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_-]{12,}\b|\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[A-Za-z0-9_-]{35}\b|\bnpm_[A-Za-z0-9]{36}\b|\bhf_[A-Za-z0-9]{20,}\b|\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/;
  const assignment = /(?:api[-_ ]?key|password|passwd|secret|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret)\s*[:=]\s*(?:"([^"\n]{8,})"|'([^'\n]{8,})'|([A-Za-z0-9][A-Za-z0-9_+/=-]{19,})(?![A-Za-z0-9_.(]))/i;
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const phone = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)|(?<!\d)1[3-9]\d{1}[- ]\d{4}[- ]\d{4}(?!\d)/;
  const pathPattern = /(?<![A-Za-z0-9._-])(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+)/i;
  const privateIp = /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})\b/;
  const url = /https?:\/\/([^/\s:]+)(?::\d+)?(?:\/[^\s]*)?/i;
  lines.forEach((lineText, index) => {
    const line = index + 1;
    if (privateKey.test(lineText)) {
      const sample = /(?:pattern|regex|regular expression|example|placeholder)/i.test(lineText);
      addLine(sample ? 'SECRET_EXAMPLE' : 'SECRET_PRIVATE_KEY', sample ? 'LOW' : 'HIGH', 'secret', line, lineText, 'Private-key-shaped sample or private-key material is present.', sample ? 'Keep the pattern clearly synthetic and separate from deployable credentials.' : 'Remove the key, rotate it if it was real, and keep only a documented public-key example.');
    }
    const bearerMatch = lineText.match(bearer);
    if (bearerMatch) {
      const sample = isPlaceholder(bearerMatch[1]) || /^(?:access[_-]?token|token|authorization)$/i.test(bearerMatch[1]);
      addLine(sample ? 'SECRET_EXAMPLE' : 'SECRET_TOKEN', sample ? 'LOW' : 'HIGH', 'secret', line, lineText, 'Bearer token-shaped value is present.', sample ? 'Keep the sample clearly synthetic.' : 'Replace it with a runtime environment reference or remove it.');
    }
    const knownTokenMatch = lineText.match(knownToken);
    if (knownTokenMatch) {
      const sample = isPlaceholder(knownTokenMatch[0]);
      addLine(sample ? 'SECRET_EXAMPLE' : 'SECRET_TOKEN', sample ? 'LOW' : 'HIGH', 'secret', line, lineText, 'Known provider token pattern is present.', sample ? 'Keep the sample clearly synthetic.' : 'Remove the token and rotate it if it was ever valid.');
    }
    const assignmentMatch = lineText.match(assignment);
    if (assignmentMatch) {
      const value = assignmentMatch[1] ?? assignmentMatch[2] ?? assignmentMatch[3] ?? '';
      if (isPlaceholder(value) || /^(?:access[_-]?token|token|authorization)$/i.test(value) || /^[a-z][a-z0-9_]*$/.test(value)) addLine('SECRET_EXAMPLE', 'LOW', 'secret', line, lineText, 'Credential-shaped example or placeholder is present.', 'Keep examples clearly synthetic and avoid values that could be mistaken for credentials.');
      else if (value.length >= 12) addLine('SECRET_ASSIGNMENT', 'HIGH', 'secret', line, lineText, 'Credential-like assignment is present.', 'Remove the value and load it at runtime from a secure environment.');
    }
    const publicMetadata = /(?:NOTICE|CODE_OF_CONDUCT|publiccode\.yml|\.reuse\/dep5|THIRD_PARTY_NOTICES|package(?:-lock)?\.json|sbom\.cdx\.json|_manifest\.json)$/i.test(rel);
    const publicContactDoc = /(?:NOTICE|CODE_OF_CONDUCT|SECURITY|CONTRIBUTING|publiccode\.yml|\.reuse\/dep5|THIRD_PARTY_NOTICES|package(?:-lock)?\.json|sbom\.cdx\.json|_manifest\.json)/i.test(rel);
    const documentationEmail = /@(?:example\.(?:com|org|net)|localhost)\b|@[A-Z0-9.-]+\.test\b/i.test(lineText);
    const sshRemote = /\b(?:git|ssh|hg)@[A-Z0-9.-]+:/i.test(lineText);
    const assetName = /@[0-9]+x\.(?:png|jpe?g|gif|svg|webp|ico)\b/i.test(lineText);
    if (email.test(lineText) && !isFixtureContext(lineText) && !publicContactDoc && !documentationEmail && !sshRemote && !assetName) addLine('PRIVACY_CONTACT', 'HIGH', 'privacy', line, lineText, 'Personal or organizational email address is present outside known public metadata.', 'Replace it with a public project contact or document why the address is intentionally public.');
    const phoneSample = /(?:CN mobile|phone|mask|redact|sanitize|example|fixture)/i.test(lineText);
    if (phone.test(lineText) && !isFixtureContext(lineText) && !publicMetadata && !phoneSample) addLine('PRIVACY_CONTACT', 'HIGH', 'privacy', line, lineText, 'Phone-number-shaped personal data is present.', 'Remove or anonymize the number before publishing.');
    const pathMatch = lineText.match(pathPattern);
    const endpointPath = /(?:gfetch|fetch\(|https?:\/\/|endpoint|calendarlist|\/api\/|windows path|drive path|--home\s)/i.test(lineText);
    if (pathMatch && !endpointPath && !isFixtureContext(lineText) && !FIXTURE_PATH_RE.test(pathMatch[0])) {
      const sample = /(?:pattern|windows path|drive path|example)/i.test(lineText);
      addLine(sample ? 'SECRET_EXAMPLE' : 'PRIVACY_USER_PATH', sample ? 'LOW' : 'HIGH', 'privacy', line, lineText, 'Absolute local user path is present in a sample or source text.', sample ? 'Keep the sample generic.' : 'Use a repository-relative path or a generic fixture path.');
    }
    const ipMatch = lineText.match(privateIp);
    if (ipMatch && !DOC_IP_RE.test(ipMatch[0]) && !isFixtureContext(lineText) && !/(?:localhost|127\.0\.0\.1|example|test|fixture)/i.test(lineText)) addLine('PRIVACY_INTERNAL_NET', 'HIGH', 'privacy', line, lineText, 'Private network address is present.', 'Remove internal infrastructure addresses or replace them with a documentation-only example.');
    const urlMatch = lineText.match(url);
    if (urlMatch) {
      const host = urlMatch[1];
      const sample = isFixtureContext(lineText) || /(?:example|localhost|127\.0\.0\.1|test)/i.test(lineText);
      if (/(?:\.internal|\.intra|\.corp|\.lan)$/i.test(host) || /gitlab|jira|jenkins/i.test(host) && !/github\.com|gitlab\.com/i.test(host)) addLine(sample ? 'PRIVACY_INTERNAL_SUSPECTED' : 'PRIVACY_INTERNAL_NET', sample ? 'LOW' : 'HIGH', 'privacy', line, lineText, 'Internal service URL is present in a sample or source text.', sample ? 'Keep test URLs non-routable and clearly synthetic.' : 'Replace it with a public project URL or a documentation placeholder.');
      else if (/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(host)) addLine(sample ? 'PRIVACY_INTERNAL_SUSPECTED' : 'PRIVACY_INTERNAL_NET', sample ? 'LOW' : 'HIGH', 'privacy', line, lineText, 'Private network URL is present in a sample or source text.', sample ? 'Keep test URLs non-routable and clearly synthetic.' : 'Remove the internal URL before publishing.');
    }
  });
}

function checkGeneratedPaths(paths, add) {
  for (const rel of paths) {
    if (/(?:^|\/)(?:node_modules|\.git)(?:\/|$)/.test(rel)) add({ ruleId: 'FILE_GENERATED', severity: 'HIGH', category: 'release-file', path: rel, message: 'Dependency metadata indicates a forbidden generated directory.', remediation: 'Remove it from Git and keep it ignored.' });
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function checkLicenses(root, trackedPaths, scopePaths, report, add, errors) {
  const inScope = (rel) => trackedPaths.has(rel) || scopePaths.has(rel);
  const hasScopedFile = (prefix) => [...trackedPaths, ...scopePaths].some((rel) => rel.startsWith(prefix));
  const rootLicense = path.join(root, 'LICENSE');
  if (!inScope('LICENSE') || !fs.existsSync(rootLicense)) add({ ruleId: 'LICENSE_MIT_MISSING', severity: 'HIGH', category: 'license', path: 'LICENSE', message: 'Root MIT LICENSE file is missing from the selected release scope.', remediation: 'Add the complete MIT license text to Git and preserve copyright ownership.' });
  else {
    let licenseText = '';
    try { licenseText = fs.readFileSync(rootLicense, 'utf8'); } catch (error) { errors.push(`LICENSE: ${error.message}`); }
    if (!/MIT License|Permission is hereby granted, free of charge/i.test(licenseText)) add({ ruleId: 'LICENSE_MIT_MISSING', severity: 'HIGH', category: 'license', path: 'LICENSE', snippet: licenseText.slice(0, 120), message: 'Root LICENSE does not appear to contain the MIT license text.', remediation: 'Use the canonical MIT license text and retain the copyright notice.' });
  }
  const pkg = inScope('package.json') ? readJson(path.join(root, 'package.json')) : null;
  const lockFiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
  const lock = lockFiles.some((file) => inScope(file) && fs.existsSync(path.join(root, file)));
  const dependencyNames = pkg ? Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) }) : [];
  const hasDeps = dependencyNames.length > 0 || lock;
  const thirdParty = ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt'].find((file) => inScope(file) && fs.existsSync(path.join(root, file)));
  const licensesDir = path.join(root, 'LICENSES');
  if (hasDeps && !thirdParty) add({ ruleId: 'LICENSE_THIRD_PARTY_MISSING', severity: 'HIGH', category: 'license', path: 'THIRD_PARTY_NOTICES.md', message: 'Dependency manifests exist but no third-party notices file was found.', remediation: 'Add third-party package names, versions, sources, licenses, and required notices.' });
  if (hasDeps && (!fs.existsSync(licensesDir) || !hasScopedFile('LICENSES/'))) add({ ruleId: 'LICENSE_THIRD_PARTY_MISSING', severity: 'LOW', category: 'license', path: 'LICENSES/', message: 'No tracked LICENSES directory was found for bundled license texts.', remediation: 'Add license texts required by the chosen compliance workflow, or document why none are bundled.' });
  if (hasScopedFile('.reuse/') && (!inScope('.reuse/dep5') || !fs.existsSync(path.join(root, '.reuse', 'dep5')))) add({ ruleId: 'LICENSE_THIRD_PARTY_MISSING', severity: 'HIGH', category: 'license', path: '.reuse/dep5', message: 'REUSE directory exists without a tracked dep5 declaration.', remediation: 'Add complete REUSE metadata or remove the incomplete compliance setup.' });
  const sbomPath = path.join(root, 'sbom.cdx.json');
  if (inScope('sbom.cdx.json') && fs.existsSync(sbomPath)) {
    const sbom = readJson(sbomPath);
    if (!sbom || sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) add({ ruleId: 'LICENSE_THIRD_PARTY_MISSING', severity: 'HIGH', category: 'license', path: 'sbom.cdx.json', message: 'SBOM is not a valid local CycloneDX structure.', remediation: 'Regenerate the SBOM locally and verify it without downloading a checker.' });
    else {
      const malformed = sbom.components.some((component) => !component || typeof component.name !== 'string' || typeof component.version !== 'string');
      if (malformed) add({ ruleId: 'LICENSE_THIRD_PARTY_MISSING', severity: 'HIGH', category: 'license', path: 'sbom.cdx.json', message: 'One or more SBOM components lack a name or version.', remediation: 'Regenerate or repair the SBOM before publishing.' });
      const sbomNames = new Set(sbom.components.map((component) => (component.group ? `${component.group}/${component.name}` : component.name)));
      const missing = dependencyNames.filter((name) => !sbomNames.has(name));
      if (missing.length) add({ ruleId: 'LICENSE_THIRD_PARTY_MISSING', severity: 'HIGH', category: 'license', path: 'sbom.cdx.json', snippet: missing.join(', '), message: `${missing.length} direct package dependencies are absent from the SBOM.`, remediation: 'Regenerate the SBOM from the current lockfile and review its third-party notices.' });
    }
  } else if (hasDeps) add({ ruleId: 'LICENSE_METADATA_INCOMPLETE', severity: 'LOW', category: 'license', path: 'sbom.cdx.json', message: 'No tracked local SBOM was found; dependency coverage was not independently verified.', remediation: 'Provide a reproducible SBOM when your release policy requires one.' });
  if (thirdParty) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, thirdParty), 'utf8'); } catch (error) { errors.push(`${thirdParty}: ${error.message}`); }
    const incomplete = dependencyNames.filter((name) => !text.includes(name));
    if (incomplete.length) add({ ruleId: 'LICENSE_METADATA_INCOMPLETE', severity: 'LOW', category: 'license', path: thirdParty, snippet: incomplete.join(', '), message: `${incomplete.length} package names were not found in the third-party notices.`, remediation: 'Review the notices for complete package, version, source, and license coverage.' });
    const licenseWords = /\b(?:MIT|Apache[- ]?2\.0|BSD[- ]?[0-9]-Clause|ISC|MPL[- ]?2\.0|LGPL|GPL|BlueOak|CC0|Unlicense)\b/i;
    const metadataIncomplete = dependencyNames.filter((name) => {
      const index = text.split(/\r?\n/).findIndex((line) => new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(line));
      if (index < 0) return false;
      const context = text.split(/\r?\n/).slice(index, index + 3).join(' ');
      return !/\b\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/.test(context) || !licenseWords.test(context) || !/https?:\/\//i.test(context);
    });
    if (metadataIncomplete.length) add({ ruleId: 'LICENSE_METADATA_INCOMPLETE', severity: 'LOW', category: 'license', path: thirdParty, snippet: metadataIncomplete.join(', '), message: `${metadataIncomplete.length} third-party entries appear to lack a version, source, or license.`, remediation: 'Add the package version, upstream source URL, and SPDX-compatible license information.' });
  }
  for (const expected of ['NOTICE', 'THIRD_PARTY_NOTICES.md', '.reuse/dep5']) if (!inScope(expected) && expected !== 'THIRD_PARTY_NOTICES.md' && hasDeps) add({ ruleId: 'LICENSE_METADATA_INCOMPLETE', severity: 'LOW', category: 'license', path: expected, message: `${expected} is not tracked in the selected release scope.`, remediation: 'Confirm whether this compliance artifact is required by the release policy.' });
  report.checks.push({ name: 'license-structure', status: 'completed', dependenciesDetected: hasDeps, thirdPartyNotices: Boolean(thirdParty), sbom: inScope('sbom.cdx.json') && fs.existsSync(sbomPath) });
}

function runLocalChecks(report, add) {
  report.checks.push({ name: 'project-local-checks', status: 'disabled', reason: 'output-only mode never executes repository-provided code' });
  add({ ruleId: 'PROJECT_CHECKS_SKIPPED', severity: 'LOW', category: 'coverage', message: 'Repository-provided checks were not executed because output-only mode never runs repository code.', remediation: 'Run separately reviewed checks outside this audit if needed.' });
  add({ ruleId: 'VULNERABILITY_SCAN_UNCOVERED', severity: 'LOW', category: 'coverage', message: 'No network vulnerability database was consulted.', remediation: 'Run an approved offline or CI vulnerability process separately before release.' });
}

try { main(); } catch (error) {
  console.error(`BLOCKED: ${redactText(error.message)}`);
  process.exitCode = 1;
}

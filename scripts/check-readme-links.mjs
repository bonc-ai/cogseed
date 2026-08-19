import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const readmes = ['README.md', 'README.zh-CN.md'];
const checkExternal = process.argv.includes('--external');
const markdownLink = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+['\"][^'\"]*['\"])?\s*\)/g;

function targetFromMatch(value) {
  return value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
}

function localPathFromTarget(target) {
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  return decodeURIComponent(withoutFragment);
}

async function checkLocalLink(readme, target) {
  const localPath = localPathFromTarget(target);
  if (!localPath) return null;
  const resolved = path.resolve(root, path.dirname(readme), localPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return `${readme}: local target escapes the repository: ${target}`;
  }
  try {
    await fs.access(resolved);
    return null;
  } catch {
    return `${readme}: missing local target: ${target}`;
  }
}

async function fetchStatus(url, method) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'CogSeed-README-link-check/1.0' },
    });
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkExternalLink(readme, target) {
  try {
    let status = await fetchStatus(target, 'HEAD');
    if (status === 405 || status === 501) status = await fetchStatus(target, 'GET');
    return status >= 200 && status < 400 ? null : `${readme}: ${status} for ${target}`;
  } catch (error) {
    return `${readme}: unable to reach ${target} (${error instanceof Error ? error.message : String(error)})`;
  }
}

const failures = [];
let localLinks = 0;
let externalLinks = 0;
const externalTargets = [];

for (const readme of readmes) {
  const content = await fs.readFile(path.join(root, readme), 'utf8');
  for (const match of content.matchAll(markdownLink)) {
    const target = targetFromMatch(match[1]);
    if (!target || target.startsWith('#') || target.startsWith('mailto:')) continue;
    if (/^https?:\/\//i.test(target)) {
      externalLinks += 1;
      if (checkExternal) externalTargets.push({ readme, target });
      continue;
    }
    localLinks += 1;
    const failure = await checkLocalLink(readme, target);
    if (failure) failures.push(failure);
  }
}

if (checkExternal) {
  const externalFailures = await Promise.all(
    externalTargets.map(({ readme, target }) => checkExternalLink(readme, target)),
  );
  failures.push(...externalFailures.filter(Boolean));
}

if (failures.length) {
  console.error('README link verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`README link verification passed: ${localLinks} local links, ${externalLinks} external links${checkExternal ? ' checked' : ' skipped'}.`);

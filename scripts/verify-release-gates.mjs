#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOW_JOBS = Object.freeze({
  'ci.yml': Object.freeze(['verify', 'verify-windows']),
  'compliance.yml': Object.freeze(['compliance']),
});
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const MAX_PAGES = 100;

function requiredEnv(env, name) {
  const value = String(env?.[name] ?? '').trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(String(value ?? ''))) throw new Error(`${label} is not a valid commit SHA`);
  return String(value).toLowerCase();
}

function objectFrom(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} returned invalid JSON`);
  return value;
}

function integerFrom(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} returned invalid JSON`);
  return value;
}

function positiveIntegerFrom(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function createApiClient({ apiUrl, repository, token, fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const base = apiUrl.replace(/\/+$/, '');
  const prefix = `/repos/${repository}`;

  async function get(relativePath, params = undefined, { allowNotFound = false } = {}) {
    const url = new URL(`${base}${prefix}${relativePath}`);
    for (const [name, value] of Object.entries(params ?? {})) url.searchParams.set(name, String(value));
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (error) {
      throw new Error(`GitHub API request failed for ${url.pathname}: ${error?.message ?? error}`);
    }
    if (allowNotFound && response?.status === 404) return null;
    if (!response?.ok) throw new Error(`GitHub API request failed for ${url.pathname}: HTTP ${response?.status ?? 'unknown'}`);
    try {
      return objectFrom(await response.json(), `GitHub API ${url.pathname}`);
    } catch (error) {
      if (/invalid JSON/.test(String(error?.message))) throw error;
      throw new Error(`GitHub API returned invalid JSON for ${url.pathname}: ${error?.message ?? error}`);
    }
  }

  async function getAll(relativePath, arrayKey, params = undefined) {
    const rows = [];
    let expectedTotal;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await get(relativePath, { ...params, per_page: 100, page });
      const total = integerFrom(payload.total_count, `${relativePath} pagination`);
      if (expectedTotal === undefined) expectedTotal = total;
      if (total !== expectedTotal) throw new Error(`${relativePath} pagination total changed while reading pages`);
      if (!Array.isArray(payload[arrayKey])) throw new Error(`${relativePath} pagination returned invalid JSON`);
      rows.push(...payload[arrayKey]);
      if (rows.length === expectedTotal) return rows;
      if (rows.length > expectedTotal || payload[arrayKey].length === 0) {
        throw new Error(`${relativePath} pagination did not return the declared rows`);
      }
    }
    throw new Error(`${relativePath} pagination exceeded ${MAX_PAGES} pages`);
  }

  return {
    get,
    getAll,
    getOptional: (relativePath, params = undefined) => get(relativePath, params, { allowNotFound: true }),
  };
}

async function peelTag(api, tagName) {
  const encodedTag = encodeURIComponent(tagName);
  let object = objectFrom((await api.get(`/git/ref/tags/${encodedTag}`)).object, 'Tag ref');
  const visited = new Set();
  for (let depth = 0; depth < 16; depth += 1) {
    const current = objectFrom(object, 'Tag object');
    const sha = assertSha(current.sha, 'Tag object SHA');
    if (current.type === 'commit') return sha;
    if (current.type !== 'tag') throw new Error(`Tag resolves to unsupported Git object type: ${String(current.type)}`);
    if (visited.has(sha)) throw new Error('Annotated tag chain contains a cycle');
    visited.add(sha);
    object = objectFrom((await api.get(`/git/tags/${sha}`)).object, 'Annotated tag');
  }
  throw new Error('Annotated tag chain is too deep');
}

function validateRun(run, workflowName) {
  const row = objectFrom(run, `${workflowName} workflow run`);
  positiveIntegerFrom(row.id, `${workflowName} workflow run id`);
  positiveIntegerFrom(row.run_number, `${workflowName} workflow run number`);
  positiveIntegerFrom(row.run_attempt, `${workflowName} workflow run attempt`);
  return row;
}

function latestRun(runs, workflowName, peeledSha) {
  const exactRuns = runs
    .map((run) => validateRun(run, workflowName))
    .filter((run) => (
      String(run.head_sha).toLowerCase() === peeledSha
      && run.head_branch === 'cicd'
      && run.event === 'push'
    ));
  if (exactRuns.length === 0) throw new Error(`No exact ${workflowName} push run for SHA ${peeledSha}`);
  return exactRuns.sort((left, right) => (
    right.run_number - left.run_number
    || right.run_attempt - left.run_attempt
    || right.id - left.id
  ))[0];
}

function verifyRunSuccess(run, workflowName) {
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error(`Latest ${workflowName} run ${run.id} attempt ${run.run_attempt} is ${run.status}/${run.conclusion}`);
  }
}

function verifyJobs(jobs, requiredNames, workflowName, attempt) {
  const counts = new Map();
  for (const job of jobs) {
    const row = objectFrom(job, `${workflowName} job`);
    if (typeof row.name !== 'string' || !row.name) throw new Error(`${workflowName} job returned invalid JSON`);
    positiveIntegerFrom(row.run_attempt, `${workflowName} job ${row.name} run_attempt`);
    counts.set(row.name, (counts.get(row.name) ?? 0) + 1);
    if (row.run_attempt !== attempt) {
      throw new Error(`${workflowName} job ${row.name} belongs to the wrong attempt`);
    }
  }
  for (const name of requiredNames) {
    const count = counts.get(name) ?? 0;
    if (count === 0) throw new Error(`Missing required ${workflowName} job: ${name}`);
    if (count > 1) throw new Error(`Duplicate required ${workflowName} job: ${name}`);
  }
  const extras = [...counts.keys()].filter((name) => !requiredNames.includes(name));
  if (extras.length > 0) throw new Error(`Unexpected ${workflowName} jobs: ${extras.join(', ')}`);
  for (const job of jobs) {
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      throw new Error(`${workflowName} job ${job.name} is ${job.status}/${job.conclusion}`);
    }
  }
}

export async function verifyReleaseGates({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiUrl = requiredEnv(env, 'GITHUB_API_URL');
  const repository = requiredEnv(env, 'GITHUB_REPOSITORY');
  const githubRef = requiredEnv(env, 'GITHUB_REF');
  const eventSha = assertSha(requiredEnv(env, 'GITHUB_SHA'), 'GITHUB_SHA');
  const token = requiredEnv(env, 'GITHUB_TOKEN');
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  if (!githubRef.startsWith('refs/tags/v')) throw new Error('GITHUB_REF must identify a v* release tag');
  const tagName = githubRef.slice('refs/tags/'.length);
  const api = createApiClient({ apiUrl, repository, token, fetchImpl });
  const peeledSha = await peelTag(api, tagName);
  if (peeledSha !== eventSha) throw new Error(`GITHUB_SHA must exactly match the peeled tag commit (${eventSha} != ${peeledSha})`);
  const cicdRef = objectFrom((await api.get('/git/ref/heads/cicd')).object, 'cicd ref');
  const cicdSha = assertSha(cicdRef.sha, 'origin/cicd tip');
  if (peeledSha !== cicdSha) {
    throw new Error(`Release tag commit must exactly match origin/cicd tip (${peeledSha} != ${cicdSha})`);
  }

  const workflows = {};
  for (const [workflowName, requiredJobs] of Object.entries(WORKFLOW_JOBS)) {
    const runs = await api.getAll(`/actions/workflows/${workflowName}/runs`, 'workflow_runs', {
      branch: 'cicd',
      event: 'push',
      head_sha: peeledSha,
    });
    const run = latestRun(runs, workflowName, peeledSha);
    verifyRunSuccess(run, workflowName);
    const jobs = await api.getAll(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    verifyJobs(jobs, requiredJobs, workflowName, run.run_attempt);
    workflows[workflowName] = { runId: run.id, attempt: run.run_attempt };
  }
  return { peeledSha, workflows };
}

export async function verifyPublishTarget({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const apiUrl = requiredEnv(env, 'GITHUB_API_URL');
  const repository = requiredEnv(env, 'GITHUB_REPOSITORY');
  const githubRef = requiredEnv(env, 'GITHUB_REF');
  const eventSha = assertSha(requiredEnv(env, 'GITHUB_SHA'), 'GITHUB_SHA');
  const expectedSha = assertSha(requiredEnv(env, 'EXPECTED_SHA'), 'EXPECTED_SHA');
  const token = requiredEnv(env, 'GITHUB_TOKEN');
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  if (!githubRef.startsWith('refs/tags/v')) throw new Error('GITHUB_REF must identify a v* release tag');
  const tagName = githubRef.slice('refs/tags/'.length);
  const api = createApiClient({ apiUrl, repository, token, fetchImpl });
  const peeledSha = await peelTag(api, tagName);
  if (peeledSha !== expectedSha) throw new Error(`EXPECTED_SHA must exactly match the peeled tag commit (${expectedSha} != ${peeledSha})`);
  if (peeledSha !== eventSha) throw new Error(`GITHUB_SHA must exactly match the peeled tag commit (${eventSha} != ${peeledSha})`);

  const release = await api.getOptional(`/releases/tags/${encodeURIComponent(tagName)}`);
  if (release === null) return { peeledSha, release: null };
  const existing = objectFrom(release, 'Existing Release');
  positiveIntegerFrom(existing.id, 'Existing Release id');
  if (existing.tag_name !== tagName || typeof existing.draft !== 'boolean') {
    throw new Error('Existing Release returned invalid JSON');
  }
  if (!existing.draft) throw new Error(`Release ${tagName} is already published`);
  return { peeledSha, release: existing };
}

async function main() {
  if (process.argv.includes('--publish-target')) {
    const result = await verifyPublishTarget();
    process.stdout.write(`Publish target is safe for ${result.peeledSha}\n`);
    return;
  }
  const result = await verifyReleaseGates();
  const outputPath = requiredEnv(process.env, 'GITHUB_OUTPUT');
  appendFileSync(outputPath, `peeled-sha=${result.peeledSha}\n`, 'utf8');
  process.stdout.write(`Release gates passed for ${result.peeledSha}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isCli) {
  main().catch((error) => {
    process.stderr.write(`[verify-release-gates] ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}

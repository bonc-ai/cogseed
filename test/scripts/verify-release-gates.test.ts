import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_CI_JOBS, verifyPublishTarget, verifyReleaseGates } from '../../scripts/verify-release-gates.mjs';

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const successfulJobs = (attempt = 1) => PUBLIC_CI_JOBS.map((name: string) => ({
  name, status: 'completed', conclusion: 'success', run_attempt: attempt,
}));

type JsonResponse = { status?: number; body?: unknown; jsonError?: Error };

function response({ status = 200, body, jsonError }: JsonResponse) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (jsonError) throw jsonError;
      return body;
    },
  };
}

function run({
  tagObject = { type: 'commit', sha: SHA },
  mainSha = SHA,
  ciRuns,
  jobs = {},
  overrides = {},
  githubSha = SHA,
  expectedSha = SHA,
  releaseResponse = { status: 404, body: { message: 'Not Found' } },
  requestedUrls = [],
  operation = 'gate',
  repository = 'bonc-ai/cogseed',
}: {
  tagObject?: { type: string; sha: string };
  mainSha?: string;
  ciRuns?: unknown[];
  jobs?: Record<string, unknown[]>;
  overrides?: Record<string, JsonResponse>;
  githubSha?: string;
  expectedSha?: string;
  releaseResponse?: JsonResponse;
  requestedUrls?: string[];
  operation?: 'gate' | 'publish';
  repository?: string;
} = {}) {
  const successfulRun = (id: number, workflow: string) => ({
    id,
    run_number: id,
    run_attempt: 1,
    head_sha: SHA,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    // The API can include an explicit ref suffix.
    path: `.github/workflows/${workflow}@refs/heads/main`,
  });
  const runsByWorkflow: Record<string, unknown[]> = {
    'public-ci.yml': ciRuns ?? [successfulRun(20, 'public-ci.yml')],
  };
  const jobsByRun: Record<string, unknown[]> = {
    '20/attempts/1': successfulJobs(),
    ...jobs,
  };

  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    const route = `${url.pathname}${url.search}`;
    requestedUrls.push(route);
    const override = overrides[route] ?? overrides[url.pathname];
    if (override) return response(override);
    if (url.pathname.endsWith('/git/ref/tags/v0.10.0')) {
      return response({ body: { object: tagObject } });
    }
    if (url.pathname.includes('/git/tags/')) {
      return response({ body: { object: { type: 'commit', sha: SHA } } });
    }
    if (url.pathname.endsWith('/git/ref/heads/main')) {
      return response({ body: { object: { type: 'commit', sha: mainSha } } });
    }
    if (url.pathname.endsWith('/releases/tags/v0.10.0')) return response(releaseResponse);
    const workflowMatch = url.pathname.match(/\/actions\/workflows\/(public-ci\.yml|compliance\.yml)\/runs$/);
    if (workflowMatch) {
      const rows = runsByWorkflow[workflowMatch[1]];
      return response({ body: { total_count: rows.length, workflow_runs: rows } });
    }
    const jobsMatch = url.pathname.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
    if (jobsMatch) {
      const rows = jobsByRun[`${jobsMatch[1]}/attempts/${jobsMatch[2]}`] ?? [];
      return response({ body: { total_count: rows.length, jobs: rows } });
    }
    return response({ status: 404, body: { message: `unhandled ${route}` } });
  });

  const env = {
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: 'refs/tags/v0.10.0',
    GITHUB_SHA: githubSha,
    GITHUB_TOKEN: 'test-token',
    EXPECTED_SHA: expectedSha,
  };
  return (operation === 'publish' ? verifyPublishTarget : verifyReleaseGates)({
    env,
    fetchImpl,
  });
}

describe('release gate verification', () => {
  it('rejects release execution in the private repository', async () => {
    for (const operation of ['gate', 'publish'] as const) {
      await expect(run({ operation, repository: 'bonc-ai/cogseed-internal' })).rejects.toThrow(/public repository/i);
    }
  });
  it('accepts an exact main tip with the current successful push attempts', async () => {
    await expect(run()).resolves.toMatchObject({
      peeledSha: SHA,
      workflows: {
        'public-ci.yml': { runId: 20, attempt: 1 },
      },
    });
  });

  it('peels an annotated tag before comparing it to the main tip', async () => {
    await expect(run({ tagObject: { type: 'tag', sha: 'c'.repeat(40) } })).resolves.toMatchObject({ peeledSha: SHA });
  });

  it('rejects an ancestor or otherwise non-tip tag SHA', async () => {
    await expect(run({ mainSha: OLD_SHA })).rejects.toThrow(/exactly match.*main/i);
  });

  it('requires the pushed tag event SHA to exactly match the peeled commit', async () => {
    await expect(run({ githubSha: '' })).rejects.toThrow(/GITHUB_SHA/);
    await expect(run({ githubSha: OLD_SHA })).rejects.toThrow(/GITHUB_SHA.*peeled/i);
  });

  it.each([
    ['pull_request', 'success'],
    ['workflow_dispatch', 'success'],
    ['push', 'failure'],
    ['push', 'skipped'],
    ['push', 'cancelled'],
  ])('rejects a %s run with conclusion %s', async (event, conclusion) => {
    const row = {
      id: 20,
      run_number: 20,
      run_attempt: 1,
      head_sha: SHA,
      head_branch: 'main',
    path: '.github/workflows/public-ci.yml',
      event,
      status: 'completed',
      conclusion,
    };
    await expect(run({ ciRuns: [row] })).rejects.toThrow(/public-ci\.yml/i);
  });

  it('uses the latest run even when the API returns runs out of order', async () => {
    const row = (id: number, conclusion: string) => ({
      id,
      run_number: id,
      run_attempt: 1,
      head_sha: SHA,
      head_branch: 'main',
    path: '.github/workflows/public-ci.yml',
      event: 'push',
      status: 'completed',
      conclusion,
    });
    await expect(run({ ciRuns: [row(30, 'failure'), row(20, 'success')] })).rejects.toThrow(/latest.*public-ci\.yml/i);
    await expect(run({ ciRuns: [row(20, 'success'), row(30, 'failure')] })).rejects.toThrow(/latest.*public-ci\.yml/i);
  });

  it('uses jobs from the selected latest run attempt', async () => {
    const requestedUrls: string[] = [];
    const rerun = {
      id: 20,
      run_number: 20,
      run_attempt: 2,
      head_sha: SHA,
      head_branch: 'main',
    path: '.github/workflows/public-ci.yml',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    };
    await expect(run({
      ciRuns: [rerun],
      jobs: {
        '20/attempts/1': [],
        '20/attempts/2': successfulJobs(2),
      },
      requestedUrls,
    })).resolves.toMatchObject({ workflows: { 'public-ci.yml': { runId: 20, attempt: 2 } } });
    expect(requestedUrls.some((url) => url.includes('/actions/runs/20/attempts/2/jobs'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/actions/runs/20/attempts/1/jobs'))).toBe(false);
  });

  it('selects exact-SHA runs while ignoring historical runs from other main tips', async () => {
    const exact = {
      id: 20,
      run_number: 20,
      run_attempt: 1,
      head_sha: SHA,
      head_branch: 'main',
    path: '.github/workflows/public-ci.yml',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    };
    const historical = { ...exact, id: 19, run_number: 19, head_sha: OLD_SHA };
    await expect(run({ ciRuns: [historical, exact] })).resolves.toMatchObject({ peeledSha: SHA });
    await expect(run({ ciRuns: [historical] })).rejects.toThrow(/exact.*public-ci\.yml.*SHA/i);
  });

  it('rejects missing, unexpected and duplicate required jobs', async () => {
    await expect(run({ jobs: { '20/attempts/1': successfulJobs().slice(1) } }))
      .rejects.toThrow(/missing.*compliance/i);
    await expect(run({ jobs: { '20/attempts/1': [...successfulJobs(),
      { name: 'legacy', status: 'completed', conclusion: 'success', run_attempt: 1 },
    ] } })).rejects.toThrow(/unexpected.*legacy/i);
    await expect(run({ jobs: { '20/attempts/1': [...successfulJobs(), successfulJobs()[0]] } }))
      .rejects.toThrow(/duplicate.*compliance/i);
  });

  it('rejects missing or non-positive run_attempt values', async () => {
    await expect(run({ jobs: { '20/attempts/1': [
      { name: 'compliance', status: 'completed', conclusion: 'success' },
    ] } })).rejects.toThrow(/run_attempt.*positive integer/i);

    const zeroAttemptRun = {
      id: 20,
      run_number: 20,
      run_attempt: 0,
      head_sha: SHA,
      head_branch: 'main',
    path: '.github/workflows/public-ci.yml',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
    };
    await expect(run({
      ciRuns: [zeroAttemptRun],
      jobs: {
        '20/attempts/0': [
          { name: 'verify', status: 'completed', conclusion: 'success', run_attempt: 0 },
        ],
      },
    })).rejects.toThrow(/run attempt.*positive integer/i);
  });

  it('rejects failed, skipped, and cancelled jobs', async () => {
    for (const conclusion of ['failure', 'skipped', 'cancelled']) {
      await expect(run({ jobs: { '20/attempts/1': successfulJobs().map((job) =>
        job.name === 'windows-tests (4)' ? { ...job, conclusion } : job) } }))
        .rejects.toThrow(/windows-tests/i);
    }
  });

  it('fails closed on missing env, HTTP errors, malformed JSON, and pagination errors', async () => {
    await expect(verifyReleaseGates({ env: {}, fetchImpl: vi.fn() })).rejects.toThrow(/GITHUB_API_URL/);
    await expect(run({ overrides: { '/repos/bonc-ai/cogseed/git/ref/tags/v0.10.0': { status: 503, body: {} } } }))
      .rejects.toThrow(/503/);
    await expect(run({ overrides: { '/repos/bonc-ai/cogseed/git/ref/tags/v0.10.0': { jsonError: new Error('bad json') } } }))
      .rejects.toThrow(/JSON/i);
    const firstPage = '/repos/bonc-ai/cogseed/actions/workflows/public-ci.yml/runs?branch=main&event=push&head_sha=' + SHA + '&per_page=100&page=1';
    await expect(run({ overrides: { [firstPage]: { body: { total_count: 101, workflow_runs: [] } } } }))
      .rejects.toThrow(/pagination/i);
  });

  it('allows first publish or an existing draft, but rejects a published release and API failures', async () => {
    await expect(run({ operation: 'publish' })).resolves.toMatchObject({ release: null, peeledSha: SHA });
    await expect(run({
      operation: 'publish',
      releaseResponse: { body: { id: 42, tag_name: 'v0.10.0', draft: true } },
    })).resolves.toMatchObject({ release: { id: 42, draft: true }, peeledSha: SHA });
    await expect(run({
      operation: 'publish',
      releaseResponse: { body: { id: 42, tag_name: 'v0.10.0', draft: false } },
    })).rejects.toThrow(/already published/i);
    await expect(run({
      operation: 'publish',
      releaseResponse: { status: 503, body: {} },
    })).rejects.toThrow(/503/);
  });

  it('revalidates the publisher tag against both the gate SHA and event SHA', async () => {
    await expect(run({ operation: 'publish', expectedSha: OLD_SHA })).rejects.toThrow(/EXPECTED_SHA.*peeled/i);
    await expect(run({ operation: 'publish', githubSha: OLD_SHA })).rejects.toThrow(/GITHUB_SHA.*peeled/i);
  });
});

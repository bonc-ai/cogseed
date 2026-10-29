/**
 * Apply the suite's bounded Vitest worker default without overriding an
 * explicit caller choice. Windows stays serialized because native Electron,
 * Git, SQLite, PowerShell, and cmd fixtures otherwise exhaust desktop process
 * resources late in the full suite.
 *
 * The QC probe directory (test/质检) additionally defaults to one worker on
 * every platform (P-r2-43/P-r3-34, 决策卡组 11): probe-directory runs are
 * flaky under file parallelism and a serialized 18.6s run was accepted by the
 * 2026-10-01 decision card. Full-suite runs without a 质检 target keep the
 * bounded parallel default so per-batch full gates stay fast.
 *
 * @param {string[]} args
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function withDefaultWorkerLimit(args, platform = process.platform) {
  const forwarded = [...args];
  const hasWorkerLimit = forwarded.some((arg) =>
    arg === '--maxWorkers'
    || arg.startsWith('--maxWorkers=')
    || arg === '--minWorkers'
    || arg.startsWith('--minWorkers='),
  );
  if (!hasWorkerLimit && forwarded[0] === 'run') {
    // Positional filters only: `质检` appears when the caller targets the QC
    // probe directory or one of its files (`run test/质检`,
    // `run test/质检/probe-x.test.ts`, …).
    const targetsQcProbes = forwarded
      .slice(1)
      .some((arg) => !arg.startsWith('-') && arg.includes('质检'));
    const defaultWorkers = platform === 'win32' || targetsQcProbes ? 1 : 4;
    forwarded.push(`--maxWorkers=${defaultWorkers}`);
  }
  return forwarded;
}

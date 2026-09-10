/**
 * Apply the suite's bounded Vitest worker default without overriding an
 * explicit caller choice. Windows stays serialized because native Electron,
 * Git, SQLite, PowerShell, and cmd fixtures otherwise exhaust desktop process
 * resources late in the full suite.
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
    forwarded.push(`--maxWorkers=${platform === 'win32' ? 1 : 4}`);
  }
  return forwarded;
}

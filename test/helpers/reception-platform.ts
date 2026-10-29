import * as fs from 'node:fs';

/**
 * Whether this host can actually run a trusted reception shell.
 *
 * The strict reception profile is a deny-default `sandbox-exec` policy and the
 * product refuses to run the reception shell anywhere else
 * (`E_SANDBOX_UNAVAILABLE`, see `src/core-agent/src/sandbox/executor.ts`). A
 * reception test whose positive control needs a real shell therefore has to
 * know this, otherwise it reports the platform's documented fail-closed
 * behaviour as a regression on Windows and Linux.
 */
export const RECEPTION_SHELL_SANDBOX_AVAILABLE =
  process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

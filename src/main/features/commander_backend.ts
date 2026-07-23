/**
 * Commander backend binding and runtime view.
 *
 * The commander keeps using Orkas Core Agent by default. Hermes CLI is a
 * user-selected local backend, but this module only resolves configuration and
 * availability; dispatch, Wake Gate, KSTAR, and persistence remain owned by
 * group_chat / p3394.
 */

import {
  getCommanderBackendSettings as readCommanderBackendPreference,
  setCommanderBackendSettings as writeCommanderBackendPreference,
  type CommanderBackendSettings,
} from './config';
import { hasConfiguredModel } from './auth';
import { detectOne } from './local_agents/registry';

export type { CommanderBackendKind, CommanderBackendSettings } from './config';

export interface CommanderBackendHermesView {
  available: boolean;
  path: string | null;
  version: string | null;
  error?: string;
}

export interface CommanderBackendView {
  settings: CommanderBackendSettings;
  cloudConfigured: boolean;
  hermes: CommanderBackendHermesView;
}

function hermesError(entry: Awaited<ReturnType<typeof detectOne>>): string | undefined {
  if (entry.available) return undefined;
  return entry.errorDetail || entry.error || 'Hermes CLI is unavailable';
}

export async function detectCommanderBackends(): Promise<{ hermes: CommanderBackendHermesView }> {
  const hermes = await detectOne('hermes');
  return {
    hermes: {
      available: !!hermes.available,
      path: hermes.path,
      version: hermes.version,
      ...(hermesError(hermes) ? { error: hermesError(hermes) } : {}),
    },
  };
}

export async function getCommanderBackendView(): Promise<CommanderBackendView> {
  const [detected, configured] = await Promise.all([
    detectCommanderBackends(),
    Promise.resolve(hasConfiguredModel()),
  ]);
  return {
    settings: readCommanderBackendPreference(),
    cloudConfigured: !!configured.configured,
    hermes: detected.hermes,
  };
}

export function getCommanderBackendSettings(): CommanderBackendSettings {
  return readCommanderBackendPreference();
}

export function setCommanderBackendSettings(settings: CommanderBackendSettings): CommanderBackendSettings {
  return writeCommanderBackendPreference(settings);
}

/**
 * Normalize a caller-provided backend selection into the exact setting shape
 * group_chat should branch on. This function intentionally does not auto-switch
 * away from an unavailable backend; UI/runtime surfaces should report the
 * availability problem explicitly instead of silently changing user preference.
 */
export async function resolveCommanderBackend(input?: CommanderBackendSettings): Promise<CommanderBackendSettings> {
  return input ? writeCommanderBackendPreference(input) : readCommanderBackendPreference();
}

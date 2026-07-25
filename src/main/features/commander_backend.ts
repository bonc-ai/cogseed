/**
 * Commander backend binding and runtime view.
 *
 * The commander is always the in-process Orkas Core Agent. External CLIs such
 * as Hermes can still be configured as specialist local agents, but not as a
 * replacement commander backend.
 */

import {
  getCommanderBackendSettings as readCommanderBackendPreference,
  setCommanderBackendSettings as writeCommanderBackendPreference,
  type CommanderBackendSettings,
} from './config';
import { hasConfiguredModel } from './auth';

export type { CommanderBackendKind, CommanderBackendSettings } from './config';

export interface CommanderBackendView {
  settings: CommanderBackendSettings;
  cloudConfigured: boolean;
}

export async function getCommanderBackendView(): Promise<CommanderBackendView> {
  const configured = await Promise.resolve(hasConfiguredModel());
  return {
    settings: readCommanderBackendPreference(),
    cloudConfigured: !!configured.configured,
  };
}

export function getCommanderBackendSettings(): CommanderBackendSettings {
  return readCommanderBackendPreference();
}

export function setCommanderBackendSettings(settings: CommanderBackendSettings): CommanderBackendSettings {
  return writeCommanderBackendPreference(settings);
}

/**
 * Normalize a caller-provided backend selection into the exact setting shape.
 * Legacy Hermes commander selections are folded back to Orkas Core Agent.
 */
export async function resolveCommanderBackend(input?: CommanderBackendSettings): Promise<CommanderBackendSettings> {
  if (!input) return readCommanderBackendPreference();
  const raw = input as CommanderBackendSettings & { backend?: string };
  if (raw.backend !== 'orkas-core-agent') {
    return writeCommanderBackendPreference({ backend: 'orkas-core-agent', authEntryId: null, localCli: null });
  }
  return writeCommanderBackendPreference(input);
}

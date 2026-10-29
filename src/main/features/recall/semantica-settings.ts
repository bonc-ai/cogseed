import { userPreferencesFile } from '../../paths';
import { readJsonSync } from '../../storage';
import * as appConfig from '../config';

export interface SemanticaSettings {
  semanticaEnabled: boolean;
}

interface SemanticaPreferenceShape {
  semantica_enabled?: boolean;
}

function boolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return undefined;
}

export function readSemanticaSettings(userId?: string): SemanticaSettings {
  const prefs = (userId
    ? readJsonSync<SemanticaPreferenceShape>(userPreferencesFile(userId))
    : appConfig.readPreferences()) as SemanticaPreferenceShape;
  return { semanticaEnabled: prefs.semantica_enabled === true };
}

export function updateSemanticaSettings(input: Partial<SemanticaSettings>): SemanticaSettings {
  const current = readSemanticaSettings();
  const next = {
    semanticaEnabled: typeof input.semanticaEnabled === 'boolean'
      ? input.semanticaEnabled
      : current.semanticaEnabled,
  };
  appConfig.writePreferences({ semantica_enabled: next.semanticaEnabled });
  return next;
}

export function isSemanticaEnabled(
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return boolEnv(env.COGSEED_SEMANTICA_ENABLED) ?? readSemanticaSettings(userId).semanticaEnabled;
}

export function settingsView(userId: string): Record<string, unknown> {
  const semanticaEnabled = isSemanticaEnabled(userId);
  return {
    semanticaEnabled,
    semanticaStatus: semanticaEnabled ? 'running' : 'disabled',
    decisionMode: 'local_deterministic',
  };
}

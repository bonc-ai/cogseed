import { describe, expect, it } from 'vitest';
import { requireCogSeedApiBase } from '../../../src/main/features/api_base';

describe('CogSeed API base', () => {
  it('requires an explicit canonical API base', () => {
    expect(() => requireCogSeedApiBase({} as NodeJS.ProcessEnv)).toThrow('COGSEED_API_BASE_URL is required');
  });

  it('accepts and normalizes an HTTPS base', () => {
    expect(requireCogSeedApiBase({ COGSEED_API_BASE_URL: 'https://api.example.test/root/' } as NodeJS.ProcessEnv))
      .toBe('https://api.example.test/root');
  });

  it.each([
    'http://api.example.test',
    'https://user:pass@api.example.test',
    'https://api.example.test/path?query=1',
    'https://api.example.test/path#fragment',
  ])('rejects unsafe API base %s', (value) => {
    expect(() => requireCogSeedApiBase({ COGSEED_API_BASE_URL: value } as NodeJS.ProcessEnv))
      .toThrow(/HTTPS origin\/path/);
  });
});

/**
 * Test: MCP server health and lifecycle
 */
import { describe, it, expect } from 'vitest';
import { getEngineInfo } from '../src/index';

describe('MCP server health', () => {
  it('should return engine version', () => {
    const info = getEngineInfo();

    expect(info.version).toBe('1.0.0');
    expect(info.engine_name).toBe('nseap-meta-skill-engine');
  });

  it('should return snapshot hash', () => {
    const info = getEngineInfo();

    expect(info.snapshot_hash).toBeTruthy();
    expect(typeof info.snapshot_hash).toBe('string');
  });

  it('should return capabilities', () => {
    const info = getEngineInfo();

    expect(info.capabilities).toBeDefined();
    expect(Array.isArray(info.capabilities)).toBe(true);
    expect(info.capabilities).toContain('generation_cas');
    expect(info.capabilities).toContain('idempotent_evidence');
    expect(info.capabilities).toContain('ontology_reader');
    expect(info.capabilities).toContain('snapshot_migration');
  });

  it('should return stable hash across calls', () => {
    const info1 = getEngineInfo();
    const info2 = getEngineInfo();

    expect(info1.snapshot_hash).toBe(info2.snapshot_hash);
  });
});

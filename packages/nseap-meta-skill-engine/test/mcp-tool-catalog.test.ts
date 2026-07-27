/**
 * Test: MCP tool catalog contract
 * Ensures all 13 required tools are present
 */
import { describe, it, expect } from 'vitest';
import { getToolCatalog } from '../src/persistence/tool-catalog';

describe('MCP tool catalog', () => {
  it('should expose exactly 13 required tools', () => {
    const catalog = getToolCatalog();
    expect(catalog).toHaveLength(13);
  });

  it('should include core snapshot tools', () => {
    const catalog = getToolCatalog();
    const names = catalog.map(t => t.name);

    expect(names).toContain('create_skill_snapshot');
    expect(names).toContain('mutate_skill_snapshot');
    expect(names).toContain('add_evidence');
    expect(names).toContain('get_snapshot');
    expect(names).toContain('list_snapshots');
  });

  it('should include ontology and migration tools', () => {
    const catalog = getToolCatalog();
    const names = catalog.map(t => t.name);

    expect(names).toContain('get_ontology');
    expect(names).toContain('list_ontologies');
    expect(names).toContain('migrate_snapshot');
    expect(names).toContain('import_legacy_skill');
  });

  it('should include engine info tool', () => {
    const catalog = getToolCatalog();
    const names = catalog.map(t => t.name);

    expect(names).toContain('get_engine_info');
  });

  it('should have base_generation parameter in mutation tools', () => {
    const catalog = getToolCatalog();
    const mutateTool = catalog.find(t => t.name === 'mutate_skill_snapshot');

    expect(mutateTool).toBeDefined();
    expect(mutateTool?.inputSchema.properties).toHaveProperty('base_generation');
  });

  it('should have all tools with valid schemas', () => {
    const catalog = getToolCatalog();

    catalog.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    });
  });
});

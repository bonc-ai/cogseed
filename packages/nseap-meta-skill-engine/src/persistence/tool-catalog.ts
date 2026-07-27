/**
 * MCP tool catalog
 * Defines all 13 required tools for the meta-skill engine
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function getToolCatalog(): ToolDefinition[] {
  return [
    {
      name: 'get_engine_info',
      description: 'Get engine version, hash, and capabilities',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'create_skill_snapshot',
      description: 'Create a new skill snapshot with generation 1',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Unique skill identifier' }
        },
        required: ['skill_id']
      }
    },
    {
      name: 'mutate_skill_snapshot',
      description: 'Mutate skill snapshot with CAS semantics',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill identifier' },
          base_generation: { type: 'number', description: 'Expected current generation' },
          mutation: {
            type: 'object',
            description: 'Fields to update',
            properties: {
              name: { type: 'string' },
              category: { type: 'string' },
              description: { type: 'string' }
            }
          }
        },
        required: ['skill_id', 'base_generation', 'mutation']
      }
    },
    {
      name: 'add_evidence',
      description: 'Add evidence episode with idempotent deduplication',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill identifier' },
          base_generation: { type: 'number', description: 'Expected current generation' },
          evidence: {
            type: 'object',
            description: 'Evidence to add',
            properties: {
              evidence_id: { type: 'string' },
              task_description: { type: 'string' },
              outcome: { type: 'string', enum: ['success', 'failure', 'partial'] },
              timestamp: { type: 'string' }
            }
          }
        },
        required: ['skill_id', 'base_generation', 'evidence']
      }
    },
    {
      name: 'get_snapshot',
      description: 'Get current snapshot for a skill',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill identifier' }
        },
        required: ['skill_id']
      }
    },
    {
      name: 'list_snapshots',
      description: 'List all skill snapshots',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional category filter' }
        }
      }
    },
    {
      name: 'get_ontology',
      description: 'Get ontology definition by name',
      inputSchema: {
        type: 'object',
        properties: {
          ontology_name: { type: 'string', description: 'Ontology identifier' }
        },
        required: ['ontology_name']
      }
    },
    {
      name: 'list_ontologies',
      description: 'List available ontologies',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    },
    {
      name: 'migrate_snapshot',
      description: 'Migrate snapshot to latest schema version',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill identifier' }
        },
        required: ['skill_id']
      }
    },
    {
      name: 'import_legacy_skill',
      description: 'Import legacy PC skill to draft snapshot',
      inputSchema: {
        type: 'object',
        properties: {
          skill_path: { type: 'string', description: 'Path to legacy SKILL.md' }
        },
        required: ['skill_path']
      }
    },
    {
      name: 'query_by_task',
      description: 'Query skills by task description',
      inputSchema: {
        type: 'object',
        properties: {
          task_query: { type: 'string', description: 'Task description to match' }
        },
        required: ['task_query']
      }
    },
    {
      name: 'get_skill_statistics',
      description: 'Get aggregated statistics for a skill',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill identifier' }
        },
        required: ['skill_id']
      }
    },
    {
      name: 'export_snapshot',
      description: 'Export snapshot to portable format',
      inputSchema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', description: 'Skill identifier' },
          format: { type: 'string', enum: ['json', 'yaml'], description: 'Export format' }
        },
        required: ['skill_id']
      }
    }
  ];
}

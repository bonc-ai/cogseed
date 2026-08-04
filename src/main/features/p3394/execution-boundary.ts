export interface ExecutionBoundaryInfo {
  mode: 'real' | 'degraded' | 'test-double';
  provider: 'meta-skill-engine-mcp' | 'core-agent' | 'local-agent' | 'fixture';
  reason?: string;
}

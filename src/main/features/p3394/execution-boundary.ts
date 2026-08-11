export interface ExecutionBoundaryInfo {
  mode: 'real' | 'degraded' | 'test-double';
  provider: 'cogseed-backend' | 'core-agent' | 'local-agent' | 'fixture';
  reason?: string;
}

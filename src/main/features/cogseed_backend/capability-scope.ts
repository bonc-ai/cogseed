export interface MateCapabilityScope {
  userId: string;
  actorId?: string;
  sessionId?: string;
  sessionKind?: string;
  allowedConnectorIds?: readonly string[];
  allowedConnectorTools?: Readonly<Record<string, readonly string[]>>;
  allowedKbSourceIds?: readonly string[];
}

export function assertCapabilityScope(userId: string, scope?: MateCapabilityScope): void {
  if (scope && scope.userId !== userId) throw new Error('CogSeed capability scope belongs to a different user');
}

export function canAccessConnector(scope: MateCapabilityScope | undefined, connectorId: string): boolean {
  return !scope?.allowedConnectorIds || scope.allowedConnectorIds.includes(connectorId);
}

export function canAccessConnectorTool(scope: MateCapabilityScope | undefined, connectorId: string, toolName: string): boolean {
  if (!canAccessConnector(scope, connectorId)) return false;
  const allowed = scope?.allowedConnectorTools?.[connectorId];
  return !allowed || allowed.includes(toolName);
}

export function canAccessKbSource(scope: MateCapabilityScope | undefined, sourceId: string): boolean {
  return !scope?.allowedKbSourceIds || scope.allowedKbSourceIds.includes(sourceId);
}

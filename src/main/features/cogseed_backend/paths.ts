import * as path from 'node:path';

import {
  cogseedAgentLocalRoot,
  cogseedAgentRequestClaimsDir,
  cogseedAgentExecutionRecordsDir,
  cogseedAgentConnectorsDir,
  cogseedAgentConnectorSecretsDir,
  cogseedAgentKbSourcesDir,
  cogseedAgentKbVectorDir,
  cogseedAgentSessionsDir,
  cogseedAgentTaskEventsDir,
  cogseedAgentTasksDir,
  cogseedAgentWorkerStateDir,
  cogseedAgentRecoveryStateFile,
  cogseedAgentCoordinationsDir,
} from '../../paths';
import { safeId } from '../../storage';

function assertSegment(value: string, label: string, prefix?: string): string {
  if (!safeId(value) || (prefix && !value.startsWith(prefix))) {
    throw new Error(`invalid CogSeed ${label}`);
  }
  return value;
}

export function assertCogSeedUserId(userId: string): string {
  return assertSegment(userId, 'user id');
}

export function assertCogSeedTaskId(taskId: string): string {
  return assertSegment(taskId, 'task id', 'cogseed-task-');
}

export function assertCogSeedSessionId(sessionId: string): string {
  return assertSegment(sessionId, 'session id', 'cogseed-session-');
}

export function assertCogSeedRequestId(requestId: string): string {
  return assertSegment(requestId, 'request id', 'req-');
}

export function assertCogSeedConversationId(conversationId: string): string {
  return assertSegment(conversationId, 'conversation id');
}

export function assertCogSeedAgentId(agentId: string): string {
  return assertSegment(agentId, 'agent id');
}

export function cogseedBackendCloudRoot(userId: string): string {
  assertCogSeedUserId(userId);
  return path.dirname(cogseedAgentTasksDir(userId));
}

export function cogseedBackendLocalRoot(userId: string): string {
  assertCogSeedUserId(userId);
  return cogseedAgentLocalRoot(userId);
}

export function cogseedPendingResultDeliveriesDirectory(userId: string): string {
  return path.join(cogseedBackendLocalRoot(assertCogSeedUserId(userId)), 'pending-result-deliveries');
}

export function cogseedPendingResultDeliveryFile(userId: string, executionId: string): string {
  if (!safeId(executionId) || !executionId.startsWith('cogseed-exec-')) throw new Error('invalid CogSeed execution id');
  return path.join(cogseedPendingResultDeliveriesDirectory(userId), `${executionId}.json`);
}

export function cogseedUndeliverableResultsDirectory(userId: string): string {
  return path.join(cogseedBackendLocalRoot(assertCogSeedUserId(userId)), 'undeliverable-results');
}

export function cogseedUndeliverableResultFile(userId: string, archiveId: string): string {
  if (!safeId(archiveId)) throw new Error('invalid CogSeed undeliverable result id');
  return path.join(cogseedUndeliverableResultsDirectory(userId), `${archiveId}.json`);
}

export function cogseedResultDeliveryLeasesDirectory(userId: string): string {
  return path.join(cogseedBackendLocalRoot(assertCogSeedUserId(userId)), 'result-delivery-leases');
}

export function cogseedResultDeliveryLeaseFile(userId: string, executionId: string): string {
  if (!safeId(executionId) || !executionId.startsWith('cogseed-exec-')) throw new Error('invalid CogSeed execution id');
  return path.join(cogseedResultDeliveryLeasesDirectory(userId), `${executionId}.lease`);
}

export function cogseedTasksDirectory(userId: string): string {
  return cogseedAgentTasksDir(assertCogSeedUserId(userId));
}

export function cogseedTaskFile(userId: string, taskId: string): string {
  return path.join(cogseedAgentTasksDir(assertCogSeedUserId(userId)), `${assertCogSeedTaskId(taskId)}.json`);
}

export function cogseedTaskEventsFile(userId: string, taskId: string): string {
  return path.join(cogseedAgentTaskEventsDir(assertCogSeedUserId(userId)), `${assertCogSeedTaskId(taskId)}.jsonl`);
}

export function cogseedTaskProjectionFile(userId: string, taskId: string): string {
  return path.join(cogseedAgentTaskEventsDir(assertCogSeedUserId(userId)), '_projections', `${assertCogSeedTaskId(taskId)}.json`);
}

export function cogseedSessionsDirectory(userId: string): string {
  return cogseedAgentSessionsDir(assertCogSeedUserId(userId));
}

export function cogseedSessionFile(userId: string, sessionId: string): string {
  return path.join(cogseedAgentSessionsDir(assertCogSeedUserId(userId)), `${assertCogSeedSessionId(sessionId)}.json`);
}

export function cogseedAgentSessionMappingsDirectory(userId: string): string {
  return path.join(cogseedAgentSessionsDir(assertCogSeedUserId(userId)), '_agent_map');
}

export function cogseedAgentSessionMappingFile(userId: string, conversationId: string, agentId: string): string {
  const key = Buffer.from(JSON.stringify([
    assertCogSeedConversationId(conversationId),
    assertCogSeedAgentId(agentId),
  ]), 'utf8').toString('base64url');
  return path.join(cogseedAgentSessionMappingsDirectory(userId), `${key}.json`);
}

export function cogseedRequestClaimFile(userId: string, requestId: string): string {
  return path.join(cogseedAgentRequestClaimsDir(assertCogSeedUserId(userId)), `${assertCogSeedRequestId(requestId)}.json`);
}

export function assertCogSeedKbSourceId(id: string): string {
  if (!safeId(id) || !id.startsWith('cogseed-source-')) throw new Error('invalid CogSeed KB source id');
  return id;
}

export function cogseedKbSourceFile(userId: string, sourceId: string): string {
  assertCogSeedUserId(userId);
  return path.join(cogseedAgentKbSourcesDir(userId), assertCogSeedKbSourceId(sourceId) + '.txt');
}

export function cogseedKbSourceMetadataFile(userId: string, sourceId: string): string {
  return path.join(cogseedAgentKbSourcesDir(assertCogSeedUserId(userId)), assertCogSeedKbSourceId(sourceId) + '.json');
}

export function cogseedKbVectorDir(userId: string): string {
  assertCogSeedUserId(userId);
  return cogseedAgentKbVectorDir(userId);
}

export function assertCogSeedConnectorId(id: string): string {
  if (!safeId(id) || !id.startsWith('cogseed-connector-')) throw new Error('invalid CogSeed connector id');
  return id;
}

export function cogseedConnectorsDirectory(userId: string): string {
  return cogseedAgentConnectorsDir(assertCogSeedUserId(userId));
}

export function cogseedConnectorFile(userId: string, id: string): string {
  return path.join(cogseedConnectorsDirectory(userId), assertCogSeedConnectorId(id) + '.json');
}

export function cogseedConnectorSecretFile(userId: string, id: string): string {
  assertCogSeedUserId(userId);
  return path.join(cogseedAgentConnectorSecretsDir(userId), assertCogSeedConnectorId(id) + '.enc');
}

export function cogseedExecutionDir(userId: string, executionId: string): string {
  assertCogSeedUserId(userId);
  if (!safeId(executionId) || !executionId.startsWith('cogseed-exec-')) throw new Error('invalid CogSeed execution id');
  return path.join(cogseedAgentExecutionRecordsDir(userId), executionId);
}

export function cogseedExecutionRecordFile(userId: string, executionId: string): string {
  return path.join(cogseedExecutionDir(userId, executionId), 'record.json');
}

export function cogseedExecutionEventsFile(userId: string, executionId: string): string {
  return path.join(cogseedExecutionDir(userId, executionId), 'events.jsonl');
}

export function cogseedRecoveryStateFile(userId: string): string {
  assertCogSeedUserId(userId);
  return cogseedAgentRecoveryStateFile(userId);
}

export function cogseedWorkerStateRoot(userId: string): string {
  return cogseedAgentWorkerStateDir(assertCogSeedUserId(userId));
}


export function assertCogSeedCoordinationId(id: string): string {
  if (!safeId(id) || !id.startsWith('cogseed-coord-')) throw new Error('invalid CogSeed coordination id');
  return id;
}

export function cogseedCoordinationFile(userId: string, coordinationId: string): string {
  assertCogSeedUserId(userId);
  return path.join(cogseedAgentCoordinationsDir(userId), `${assertCogSeedCoordinationId(coordinationId)}.json`);
}

export function cogseedCoordinationControlDir(userId: string, coordinationId: string): string {
  assertCogSeedUserId(userId);
  return path.join(cogseedAgentCoordinationsDir(userId), assertCogSeedCoordinationId(coordinationId));
}

export function cogseedCoordinationControlRunFile(userId: string, coordinationId: string): string {
  return path.join(cogseedCoordinationControlDir(userId, coordinationId), 'run.json');
}

export function cogseedCoordinationControlContextFile(userId: string, coordinationId: string): string {
  return path.join(cogseedCoordinationControlDir(userId, coordinationId), 'context.json');
}

export function cogseedCoordinationControlEventsFile(userId: string, coordinationId: string): string {
  return path.join(cogseedCoordinationControlDir(userId, coordinationId), 'events.jsonl');
}

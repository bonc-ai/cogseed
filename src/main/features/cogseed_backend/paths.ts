import * as path from 'node:path';

import {
  mateAgentLocalRoot,
  mateAgentRequestClaimsDir,
  mateAgentExecutionRecordsDir,
  mateAgentConnectorsDir,
  mateAgentConnectorSecretsDir,
  mateAgentKbSourcesDir,
  mateAgentKbVectorDir,
  mateAgentSessionsDir,
  mateAgentTaskEventsDir,
  mateAgentTasksDir,
  mateAgentWorkerStateDir,
  mateAgentRecoveryStateFile,
  mateAgentCoordinationsDir,
} from '../../paths';
import { safeId } from '../../storage';

function assertSegment(value: string, label: string, prefix?: string): string {
  if (!safeId(value) || (prefix && !value.startsWith(prefix))) {
    throw new Error(`invalid CogSeed ${label}`);
  }
  return value;
}

export function assertMateUserId(userId: string): string {
  return assertSegment(userId, 'user id');
}

export function assertMateTaskId(taskId: string): string {
  return assertSegment(taskId, 'task id', 'mate-task-');
}

export function assertMateSessionId(sessionId: string): string {
  return assertSegment(sessionId, 'session id', 'mate-session-');
}

export function assertMateRequestId(requestId: string): string {
  return assertSegment(requestId, 'request id', 'req-');
}

export function mateBackendCloudRoot(userId: string): string {
  assertMateUserId(userId);
  return path.dirname(mateAgentTasksDir(userId));
}

export function mateBackendLocalRoot(userId: string): string {
  assertMateUserId(userId);
  return mateAgentLocalRoot(userId);
}

export function mateTasksDirectory(userId: string): string {
  return mateAgentTasksDir(assertMateUserId(userId));
}

export function mateTaskFile(userId: string, taskId: string): string {
  return path.join(mateAgentTasksDir(assertMateUserId(userId)), `${assertMateTaskId(taskId)}.json`);
}

export function mateTaskEventsFile(userId: string, taskId: string): string {
  return path.join(mateAgentTaskEventsDir(assertMateUserId(userId)), `${assertMateTaskId(taskId)}.jsonl`);
}

export function mateSessionsDirectory(userId: string): string {
  return mateAgentSessionsDir(assertMateUserId(userId));
}

export function mateSessionFile(userId: string, sessionId: string): string {
  return path.join(mateAgentSessionsDir(assertMateUserId(userId)), `${assertMateSessionId(sessionId)}.json`);
}

export function mateRequestClaimFile(userId: string, requestId: string): string {
  return path.join(mateAgentRequestClaimsDir(assertMateUserId(userId)), `${assertMateRequestId(requestId)}.json`);
}

export function assertMateKbSourceId(id: string): string {
  if (!safeId(id) || !id.startsWith('mate-source-')) throw new Error('invalid Mate KB source id');
  return id;
}

export function mateKbSourceFile(userId: string, sourceId: string): string {
  assertMateUserId(userId);
  return path.join(mateAgentKbSourcesDir(userId), assertMateKbSourceId(sourceId) + '.txt');
}

export function mateKbSourceMetadataFile(userId: string, sourceId: string): string {
  return path.join(mateAgentKbSourcesDir(assertMateUserId(userId)), assertMateKbSourceId(sourceId) + '.json');
}

export function mateKbVectorDir(userId: string): string {
  assertMateUserId(userId);
  return mateAgentKbVectorDir(userId);
}

export function assertMateConnectorId(id: string): string {
  if (!safeId(id) || !id.startsWith('mate-connector-')) throw new Error('invalid Mate connector id');
  return id;
}

export function mateConnectorsDirectory(userId: string): string {
  return mateAgentConnectorsDir(assertMateUserId(userId));
}

export function mateConnectorFile(userId: string, id: string): string {
  return path.join(mateConnectorsDirectory(userId), assertMateConnectorId(id) + '.json');
}

export function mateConnectorSecretFile(userId: string, id: string): string {
  assertMateUserId(userId);
  return path.join(mateAgentConnectorSecretsDir(userId), assertMateConnectorId(id) + '.enc');
}

export function mateExecutionDir(userId: string, executionId: string): string {
  assertMateUserId(userId);
  if (!safeId(executionId) || !executionId.startsWith('mate-exec-')) throw new Error('invalid Mate execution id');
  return path.join(mateAgentExecutionRecordsDir(userId), executionId);
}

export function mateExecutionRecordFile(userId: string, executionId: string): string {
  return path.join(mateExecutionDir(userId, executionId), 'record.json');
}

export function mateExecutionEventsFile(userId: string, executionId: string): string {
  return path.join(mateExecutionDir(userId, executionId), 'events.jsonl');
}

export function mateRecoveryStateFile(userId: string): string {
  assertMateUserId(userId);
  return mateAgentRecoveryStateFile(userId);
}

export function mateWorkerStateRoot(userId: string): string {
  return mateAgentWorkerStateDir(assertMateUserId(userId));
}


export function assertMateCoordinationId(id: string): string {
  if (!safeId(id) || !id.startsWith('mate-coord-')) throw new Error('invalid Mate coordination id');
  return id;
}

export function mateCoordinationFile(userId: string, coordinationId: string): string {
  assertMateUserId(userId);
  return path.join(mateAgentCoordinationsDir(userId), `${assertMateCoordinationId(coordinationId)}.json`);
}

export function mateCoordinationControlDir(userId: string, coordinationId: string): string {
  assertMateUserId(userId);
  return path.join(mateAgentCoordinationsDir(userId), assertMateCoordinationId(coordinationId));
}

export function mateCoordinationControlRunFile(userId: string, coordinationId: string): string {
  return path.join(mateCoordinationControlDir(userId, coordinationId), 'run.json');
}

export function mateCoordinationControlContextFile(userId: string, coordinationId: string): string {
  return path.join(mateCoordinationControlDir(userId, coordinationId), 'context.json');
}

export function mateCoordinationControlEventsFile(userId: string, coordinationId: string): string {
  return path.join(mateCoordinationControlDir(userId, coordinationId), 'events.jsonl');
}

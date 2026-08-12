export { createMateIpcService, mateIpcService } from './ipc-service';
export { createMateRuntimeController, mateRuntimeController } from './runtime-controller';
export type { MateRuntimeController, MateRuntimeStatus, ResumeMateTaskInput } from './runtime-controller';
export { readMateTaskEvents } from './event-store';
export * as mateExecutionRecords from './mate-execution-store';
export { mateConnectorManager, createMateConnectorManager } from './connector-manager';
export { mateKbManager, createMateKbManager } from './mate-kb-store';
export { retryMateTask, transitionMateTask, markMateTaskRecoverable } from './lifecycle';
export { recoverMateTasks } from './recovery';
export { createMateTask, readMateTask, updateMateTask, listMateTasks, getOrCreateMateSession, readMateSession, listMateSessions } from './task-store';
export type { MateActorRecord, MateActorRole, MateCommanderSession, MateMemberSession, MateSessionKind, MateSessionLifecycleState, MateSessionLineage, MateTaskEvent, MateTaskRecord, MateTaskStatus, MateSessionRecord } from './types';

export { mateOfficeAdapter, createMateOfficeAdapter } from './office-adapter';
export { mateBrowserManager, createMateBrowserManager } from './browser-manager';
export { mateBrowserAdapter, createMateBrowserAdapter } from './browser-adapter';
export { mateCoordinator, createMateCoordinator } from './coordinator';
export { mateHostToolRouter, createMateHostToolRouter } from './host-tool-router';
export { mateCollaborationStore, createMateCollaborationStore } from './collaboration-store-adapter';
export { createMateCollaborationDispatcher } from './collaboration-dispatcher';
export { mateP3394Controller, createMateP3394Controller } from './p3394-admission';
export { mateControlService } from './mate-control-service';
export type { StartMateCommanderTaskInput, StartMateMemberTaskInput } from './mate-control-service';

export { buildMateCommanderCompatibilityId, buildMateCommanderSessionId, buildMateMemberCompatibilityId, buildMateMemberSessionId, hydrateMateSessionRecord, isMateMemberSession, resolveMateSessionIdentity, taskLineageFromSession } from './actor-session-facade';

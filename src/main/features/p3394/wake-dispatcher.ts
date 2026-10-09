import type { AgentWakeRequest } from './types';
export interface WakeDispatchContext { targetInteractive: boolean }
export interface WakeDispatcher { dispatch(userId: string, request: AgentWakeRequest, context: WakeDispatchContext): Promise<void> }

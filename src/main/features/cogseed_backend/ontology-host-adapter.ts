/**
 * CogSeed Runtime host-tool adapter for the meeting ontology tools.
 *
 * Thin bridge: the Worker never reads the graph; the host resolves the
 * request's readable/writable roots and delegates to the shared feature that
 * the in-process core-agent tools use as well.
 */

import { runMeetingOntologyTool, type MeetingOntologyToolName } from '../meeting_ontology_projection';
import type { CogSeedHostToolResult, CogSeedHostToolScope } from './office-adapter';

export async function runOntologyHostTool(
  name: MeetingOntologyToolName,
  input: Record<string, unknown>,
  scope: CogSeedHostToolScope,
): Promise<CogSeedHostToolResult> {
  return runMeetingOntologyTool(name, input, {
    userId: scope.userId,
    roots: [...scope.readOnlyRoots, ...scope.writableRoots],
    ...(scope.workingDir ? { workingDir: scope.workingDir } : {}),
  });
}

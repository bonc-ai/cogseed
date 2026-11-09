/** Reception-only private decision adapter; destination is host scope only. */
import type { AgentTool } from '#core-agent';
import type { TrustedReceptionScope } from '../../features/a2a/reception-scope';
import { requestConsultation } from '../../features/a2a/consultation-service';

export function createA2AConsultationTools(opts: {
  userId: string;
  scope: TrustedReceptionScope;
  turnId?: string;
}): AgentTool[] {
  return [{
    name: 'request_a2a_consultation',
    description: 'Ask the owner privately to decide an exception or a matter outside the granted reception scope. ' +
      'Provide the private question and proposed public reply. The host stores them for the owner and ends this turn ' +
      'without forwarding your final text. Wait for the owner to approve, revise or decline; do not send the proposal to the visitor.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 4000 },
        proposedReply: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['question', 'proposedReply'],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        // Pick only content fields. A model-supplied peer, CID or root can never
        // replace opts.scope; the schema also excludes such arguments.
        const row = await requestConsultation(opts.userId, {
          scope: opts.scope,
          turnId: opts.turnId,
          question: typeof input.question === 'string' ? input.question : '',
          proposedReply: typeof input.proposedReply === 'string' ? input.proposedReply : '',
        });
        return { content: JSON.stringify({ consultationId: row.id, state: row.state }), endTurn: true };
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'E_CONSULTATION_CREATE';
        return {
          content: JSON.stringify({ code, message: 'The private decision could not be requested. Do not forward the private question or proposal.' }),
          isError: true,
          endTurn: true,
        };
      }
    },
  }];
}

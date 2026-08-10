export type TouchpointContractErrorCode =
  | 'invalid_user_id'
  | 'invalid_identifier'
  | 'invalid_text'
  | 'invalid_timestamp'
  | 'unsupported_event_kind'
  | 'unsupported_channel'
  | 'unsupported_template'
  | 'unsupported_priority'
  | 'user_mismatch'
  | 'template_event_mismatch'
  | 'invalid_delivery_window'
  | 'invalid_action_contract'
  | 'intent_mismatch'
  | 'intent_expired'
  | 'action_not_allowed'
  | 'invalid_signature'
  | 'intent_not_found'
  | 'intent_not_actionable'
  | 'invalid_status_transition'
  | 'ledger_corrupt'
  | 'action_duplicate'
  | 'invalid_policy'
  | 'intent_not_dispatchable'
  | 'intent_not_available'
  | 'channel_mismatch';

export class TouchpointContractError extends Error {
  readonly code: TouchpointContractErrorCode;
  readonly field?: string;

  constructor(code: TouchpointContractErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'TouchpointContractError';
    this.code = code;
    this.field = field;
  }

  toJSON(): { name: string; code: TouchpointContractErrorCode; message: string; field?: string } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.field ? { field: this.field } : {}),
    };
  }
}

'use strict';

// Shared between the adapter and host approval gate. Only these structured actions
// reach the CLI; no command strings, extra flags, or model-supplied consent fields.
const string = (description, maxLength = 200) => ({ type: 'string', minLength: 1, maxLength, description });
const time = string('ISO 8601 time with explicit UTC offset, e.g. 2026-10-09T14:00:00+08:00', 40);
const id = string('Exact meeting ID returned by a meeting query; never invent an ID.', 80);
const paging = {
  page_token: string('Cursor returned by the previous page.', 1000),
  page_size: { type: 'integer', minimum: 1, maximum: 20 },
};
const fields = { subject: string('Meeting subject', 100), start: time, end: time };
const definitions = [
  ['list_meetings', 'list', 'List upcoming and ongoing meetings.', { start: time, end: time, ...paging }, []],
  ['list_ended_meetings', 'list-ended', 'List past meetings, including records and permission_status. For transcripts use can_view records; can_apply records can use apply_record_permission. Do not apply while recording/transcoding.', { start: time, end: time, ...paging }, []],
  ['get_meeting', 'get', 'Read meeting details, including records and permission_status, before changes or transcript access. can_view permits reads; can_apply permits apply_record_permission after transcoding completes. closed/deleted/password_required must not trigger an application.', { meeting_id: id, meeting_code: string('Meeting code', 20) }, []],
  ['create_meeting', 'create', 'Schedule a regular meeting. The host shows the exact proposal and requires human confirmation before execution.', fields, ['subject', 'start', 'end']],
  ['update_meeting', 'update', 'Change a meeting subject or time after reading its details. Human confirmation is required. Supply start and end together; omitted fields remain unchanged.', { meeting_id: id, ...fields, sub_meeting_id: id, meeting_type: { type: 'integer', enum: [0, 1], description: '0 regular meeting; 1 recurring series. Use sub_meeting_id to target one occurrence.' } }, ['meeting_id']],
  ['cancel_meeting', 'cancel', 'Cancel a meeting after reading its details. Human confirmation is required. Specify meeting_type=1 only to cancel the entire recurring series.', { meeting_id: id, sub_meeting_id: id, meeting_type: { type: 'integer', enum: [0, 1] } }, ['meeting_id']],
  ['apply_record_permission', 'permission-apply-commit', 'Request access to an existing meeting recording/transcript. Use meeting_id and meeting_record_id from get_meeting/list_ended_meetings with permission_status=can_apply after transcoding. The host fetches the official preview and waits for explicit human confirmation before submitting. Return status and approval_url to the user; submission is not access granted. Never retry an uncertain submission automatically.', { meeting_id: id, meeting_record_id: string('Exact recording ID, NOT record_file_id, returned by a meeting query.', 200) }, ['meeting_id', 'meeting_record_id']],
];
const WRITE_NAMES = new Set(['create_meeting', 'update_meeting', 'cancel_meeting', 'apply_record_permission']);
const INTERNAL_NAMES = new Set(['prepare_meeting_change', 'commit_meeting_change', 'discard_meeting_change']);
const TOOLS = definitions.map(([name, , description, properties, required]) => ({
  name, description, inputSchema: { type: 'object', additionalProperties: false, properties, required },
}));

function normalizeAction(name, input) {
  const def = definitions.find((row) => row[0] === name);
  if (!def) throw new Error('Unknown meeting action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Meeting arguments must be an object');
  const [, command, , properties, required] = def;
  const args = {};
  for (const [key, value] of Object.entries(input)) {
    const schema = properties[key];
    if (!schema) throw new Error(`Unexpected meeting argument: ${key}`);
    if (schema.type === 'integer') {
      if (!Number.isInteger(value) || (schema.enum ? !schema.enum.includes(value) : value < schema.minimum || value > schema.maximum)) throw new Error(`Invalid ${key}`);
      args[key] = value;
    } else {
      if (typeof value !== 'string' || !value.trim() || value.length > schema.maxLength || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${key}`);
      args[key] = value.trim();
      if (key === 'start' || key === 'end') {
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${key} requires an ISO 8601 time with offset`);
      }
      if ((key.endsWith('_id') && key !== 'meeting_record_id') || key === 'meeting_code') {
        if (!/^\d+$/.test(args[key])) throw new Error(`${key} must be a numeric string from a meeting query`);
      }
    }
  }
  for (const key of required) if (!(key in args)) throw new Error(`${key} is required`);
  if (name === 'get_meeting' && !args.meeting_id && !args.meeting_code) throw new Error('meeting_id or meeting_code is required');
  if (name === 'update_meeting' && !args.subject && !args.start && !args.end) throw new Error('Provide subject or start and end to update');
  if (WRITE_NAMES.has(name) && Boolean(args.start) !== Boolean(args.end)) throw new Error('start and end must be supplied together');
  if (args.start && args.end && Date.parse(args.end) <= Date.parse(args.start)) throw new Error('end must be after start');
  // = keeps a subject beginning with -- from becoming another CLI flag.
  const argv = [name === 'apply_record_permission' ? 'record' : 'meeting', command, ...Object.entries(args).map(([key, value]) => `--${key.replaceAll('_', '-')}=${value}`)];
  return { args, argv };
}

module.exports = { TOOLS, WRITE_NAMES, INTERNAL_NAMES, normalizeAction };

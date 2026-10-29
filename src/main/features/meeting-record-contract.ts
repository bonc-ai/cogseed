/** Pure contract for meeting_record.v1, shared by the Main-side validator and
 * the Runtime tool catalog. No storage, model or Electron imports. */
export const MEETING_RECORD_SCHEMA = 'meeting_record.v1';

/** Shape of a valid record, attached to every validation error. The parser
 * stops at the first problem; without the full shape the Agent fixes one
 * field per round and burns a model call on each guess. */
export const MEETING_RECORD_TEMPLATE = JSON.stringify({
  schema: MEETING_RECORD_SCHEMA,
  meeting: {
    ref: '<platform meeting id>-<YYYYMMDD>', title: '<meeting name>', date: 'YYYY-MM-DD', confirmed: true,
    minutes_version: 'v001', minutes_file: '<absolute path of the confirmed minutes>', tencent_meeting_id: '<optional>',
    series_entity_id: '<optional existing id>', series_new_entity: '<optional N-key of kind series>',
    project_entity_id: '<optional existing id>', project_new_entity: '<optional N-key of kind project>',
  },
  participants: [{ name: '<name>', entity_id: '<existing id, or omit>', new_entity: '<N-key of kind member, or omit>' }],
  new_entities: [{ key: 'N1', kind: 'member|series|project', name: '<name>', aliases: ['<alias>'], confirmed: false }],
  decisions: [{ id: 'D1', text: '<decision>', source_refs: ['<paragraph ref>'] }],
  open_questions: [{ id: 'Q1', text: '<question>', status: 'open|resolved', source_refs: [] }],
  action_items: [{ id: 'A1', text: '<action>', status: 'clue|candidate|created', owner_text: '<optional>',
    owner_entity_id: '<optional>', owner_new_entity: '<optional N-key>', deadline_text: '<optional>',
    derived_from: ['D1'], source_refs: [] }],
  resolves: [{ prior_meeting_ref: '<ref>', prior_item_id: 'Q1', by: 'D1' }],
});


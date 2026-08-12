# Schemas — copy-paste, exact shapes (align to E0 §8.3 / §8.4)

Do not invent field names. `<primary>` = the first/primary domain entity, lowercased
(e.g. `customer`, `device`). `<field>` = a domain field of that entity.

## input_schema (three-layer)

`owner_context` is a field-position **we expose**; its values (`owner_id`, real scope)
are injected at load time by the Agent layer — the skill never fills them.

```json
{
  "type": "object",
  "required": ["task_id", "owner_context", "<primary>_payload"],
  "properties": {
    "task_id": { "type": "string" },
    "owner_context": {
      "type": "object",
      "required": ["owner_id", "role", "authorization_scope"],
      "properties": {
        "owner_id": { "type": "string" },
        "role": { "type": "string" },
        "authorization_scope": { "type": "array", "items": { "type": "string" } }
      }
    },
    "<primary>_payload": {
      "type": "object",
      "required": ["<field_a>", "<field_b>"],
      "properties": {
        "<field_a>": { "type": "number" },
        "<field_b>": { "type": "number" }
      }
    }
  }
}
```

## output_schema (includes audit_refs)

```json
{
  "type": "object",
  "required": ["actions", "result", "trace", "audit_refs"],
  "properties": {
    "actions": { "type": "array", "items": { "type": "string" } },
    "result": { "type": "number" },
    "trace": { "type": "array", "items": { "type": "string" } },
    "audit_refs": { "type": "array", "items": { "type": "string" } }
  }
}
```

## runtime_contracts (five classes, 4 keys — resource+permission share the permission face)

We expose **field-positions and boundary guards only**. The guard values are fixed and
are the Team A–F boundary: the skill never accesses resources, resolves identity, or
holds tokens. Keep the guard values exactly as below.

```json
{
  "resource": {
    "resource_requirements": [
      { "resource_type": "<primary>", "operation": "read", "purpose": "ontology_grounded_read", "min_scope": true }
    ],
    "access_via_gateway_only": true,
    "direct_resource_access": false
  },
  "permission": {
    "permissions": [
      { "action": "assess",  "permission_level": "read",  "hitl_required": false },
      { "action": "execute", "permission_level": "write", "hitl_required": true },
      { "action": "confirm", "permission_level": "write", "hitl_required": true }
    ]
  },
  "owner_binding": {
    "required_owner_sections": ["role", "authorization_scope"],
    "owner_context_ref": "input_schema.owner_context",
    "binding_resolved_by": "agent_layer"
  },
  "audit": {
    "audit_refs_field": "output_schema.audit_refs",
    "emitted_by": "runtime",
    "append_only": true
  }
}
```

**Boundary invariants (a registry gate rejects the skill if any is wrong):**
`resource.direct_resource_access = false`, `resource.access_via_gateway_only = true`,
`owner_binding.binding_resolved_by = "agent_layer"`, `audit.emitted_by = "runtime"`.

## skill-spec.yaml identity (for the produced skill)

```yaml
skill_spec:
  standard_id: nseap-skill-creator
  skill_class: execution            # or meta_skill if it makes skills
  is_skill_of_skill: false
  level: L5
  risk_route: Full
  promotion_ceiling: staged         # hard cap — never higher
  production_release_allowed: false # hard lock — never true
```

## ontology slice (TBox / RBox / ABox)

```yaml
tbox:                               # concepts + their fields
  <Entity>: [<field_a>, <field_b>]
rbox:                               # rules (structured: field/op/value + action)
  - rule_id: R1
    formal: "<human-readable rule>"     # human-only; never machine-parsed
    field: <field_a>
    op: le                              # le/lt/ge/gt/eq
    value: 300
    action: <policy_action_or_null>
abox: {}                            # instances (usually empty at scaffold time)
source_refs: ["materials::<domain>::snapshot"]   # traceability (GAP-1); platform-registry binding is target-state
```

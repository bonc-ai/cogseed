---
name: skill-invoice-dunning
description: >-
  Decide and draft the remediation for an overdue invoice: assess the invoice, choose the
  dunning action (auto-remind vs human-review vs relationship-first for VIPs), and draft the
  message. Use when an invoice is overdue and a collection decision is needed — e.g. "this
  invoice is 45 days late, what do we do", "chase the overdue payment for account X",
  "the customer hasn't paid, draft a reminder". Do NOT use for billing/invoice-detail
  questions (that is a lookup, not a collection decision).
---

# Invoice Dunning

Given one overdue invoice, decide the appropriate collection action and draft the outreach —
respecting amount/aging thresholds and VIP relationship rules. Staged-capped; the actual
send/charge is a downstream action, never performed here.

## Trigger semantics
- **use_when**: an invoice is overdue and a collection decision/outreach is needed.
- **do_not_use_when**: the customer is asking what an invoice contains or how it was
  calculated (that is a billing lookup, handled elsewhere).
- **positive_examples**: ["invoice #INV-882 is 45 days overdue, $2,300 — what do we do",
  "chase the unpaid balance on the Acme account"]
- **negative_examples**: ["why was I charged a late fee", "resend me my invoice PDF"]

## Business context (ontology slice → references/ontology-mapping.md)
- **TBox**: `Invoice{amount_overdue, days_overdue, is_vip}`
- **RBox**: R1 amount>1000 & days>30 → human review (HITL); R2 VIP → relationship_first
  (soothe/relationship before dunning)
- **ABox**: (empty at authoring time)

## Workflow
`start → assess → decide → preview → confirm → execute → close`
HITL gate at `confirm` for any `execute` (send/charge) action; R1 forces human review
before execute for large aged invoices.

## Input / output
`references/schemas.json` — three-layer input (`task_id` + `owner_context` +
`invoice_payload{amount_overdue, days_overdue, is_vip}`); output `actions/result/trace/audit_refs`.
Field meanings in `references/input-contract.md`.

## Governance & non-claims (references/governance-boundaries.md)
- `promotion_ceiling: staged` · `production_release_allowed: false`.
- Decides + drafts; does **not** send, charge, or access the billing system. Owner/resource
  values injected by the Agent layer (`binding_resolved_by: agent_layer`).
- Symbolic decides right/wrong (which rule fires); neural only drafts the message wording.

# The nine-element contract (expanded)

Every L3+ Skill must satisfy all nine. A skill missing any of these is a script, not an
NSEAP capability. Fill each from the Step-1 domain material.

1. **Trigger semantics** — `use_when` (when to fire) **and** anti-trigger
   (`do_not_use_when` or `negative_examples`), plus `positive_examples` and
   `negative_examples`. Anti-trigger is a **hard requirement** — a skill that can't say
   when NOT to fire is dangerous. Example: use_when="customer disputes a refund amount";
   do_not_use_when="customer asks a general policy question".

2. **Business-context mapping** — `relevant(TBox) + applicable(RBox) + current(ABox)`.
   Which concepts, rules, and instances this skill reasons over.

3. **Executable workflow** — a state machine. Put `preview` and `confirm` **before** any
   `execute` node (e.g. `start → assess → decide → preview → confirm → execute → close`).
   This is where the human-in-the-loop gate lives for write actions.

4. **Tool / resource binding** — declared tools + the `runtime_contracts` (resource /
   permission / owner_binding / audit). See `schemas.md`. Field-positions only.

5. **Validation contract** — ontology refs + boundary tests + "requires HITL for high
   risk" + "ΔA gates ΔR" + "staged is not production release".

6. **Eval / replay / regression contract** — forecast fields (expected result /
   confidence / cost / latency) → outcome fields (actual …) → delta → replay set +
   regression. This is what lets the skill be *evaluated*, not just run.

7. **Failure attribution** — when it fails, which layer? (TBox / RBox / ABox / Skill /
   MetaSkill / ToolBinding / Workflow / Eval / Policy / Execution / Memory.) Declare the
   target set even if the scaffold only exercises a few.

8. **KSTAR evolution hook** — how updates get proposed: a **bounded patch**
   (`edit_budget`), gated by Validation→Governance→Release, where **symbolic decides
   right/wrong and neural only proposes wording**. The scaffold declares the hook; the
   real learning runs in the engine.

9. **Governance boundaries** — the non-claims block (see `non-claims.md`) +
   `promotion_ceiling: staged`.

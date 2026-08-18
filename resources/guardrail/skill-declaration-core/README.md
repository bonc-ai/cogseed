# NSEAP Skill Security Core (Phase-1 baseline v1.2)

Shared engine for ECS Security 3.1 template provision, Creator precheck, 3.2 PREVALIDATION / FORMAL_TEST, freeze, and subject_digest alignment.

## Install

```bash
cd nseap-skill-security-core
pip install -e .
# or run CLIs with PYTHONPATH=.
```

Dependencies: Python 3.10+, PyYAML, jsonschema.

## CLIs

```bash
# 3.1
python scripts/template_cli.py --ontology-version 1.1.1 get-template

# 3.2 PREVALIDATION
python scripts/validator_cli.py --skill-root fixtures/sample-skill --mode PREVALIDATION

# Orchestrator pipeline
python scripts/orchestrator_cli.py run-pipeline \
  --skill-root fixtures/sample-skill \
  --state-root .nseap-state \
  --ontology-version 1.1.1
```

## Cursor Skills

Under `.cursor/skills/`:

| Skill | Role |
|-------|------|
| `ecs-security-template-provider` | 3.1 |
| `ecs-skill-creator-security-guidance` | Creator fill + precheck |
| `ecs-security-core-usage` | Core API / exit codes |
| `ecs-security-validator` | 3.2 dual mode |
| `ecs-formal-test-orchestrator` | Freeze + formal + digest set |

## Phase boundary

Formal report `subject_digest` consistency proves tests targeted the same frozen content. It is **not** delivery / register / deploy authorization. Gate, Attestation, signatures, and keys are phase-2.

#!/usr/bin/env python3
from __future__ import annotations
import json, os, re, sys
from pathlib import Path


def read(p):
    try:
        return Path(p).read_text(encoding='utf-8')
    except Exception:
        return ''


def all_text(root):
    return '\n'.join(
        read(Path(dp) / f)
        for dp, _, fs in os.walk(root)
        for f in fs
        if Path(f).suffix.lower() in {'.md', '.yaml', '.yml', '.json', '.txt'}
    )


def find_schema(root):
    for p in Path(root).rglob('*.json'):
        try:
            d = json.loads(read(p))
        except Exception:
            continue
        if isinstance(d, dict) and 'input_schema' in d:
            return d
    return None


def main(root):
    root = Path(root)
    checks = []

    def c(ok, label, detail=''):
        checks.append((bool(ok), label, detail))

    skill = read(root / 'SKILL.md')
    fm = re.search(r'^---\s*(.*?)\s*---', skill, re.S)
    c(
        bool(
            fm
            and re.search(r'^name:\s*\S', fm.group(1), re.M)
            and re.search(r'^description:', fm.group(1), re.M)
            and re.search(r'^version:\s*["\']?0\.1\.0', fm.group(1), re.M)
        ),
        'SKILL.md frontmatter + v0.1.0',
    )
    c('use_when' in skill and ('do_not_use_when' in skill or 'negative_examples' in skill), 'trigger + anti-trigger')
    c('v0.1 Candidate' in skill and '候选版' in skill, 'candidate distribution status declared')
    c('Mandatory website research' in skill or 'mandatory website research' in skill.lower(), 'mandatory web research documented')
    c('validate_research_bundle.py' in skill and 'research-gate.json' in skill, 'computed research gate documented')

    doc = find_schema(root)
    if doc:
        req = doc['input_schema'].get('required', [])
        payload = [x for x in req if x.endswith('_payload')]
        c('task_id' in req and 'owner_context' in req and len(payload) == 1, 'three-layer input schema', str(req))
        oc = doc['input_schema'].get('properties', {}).get('owner_context', {}).get('required')
        c(oc == ['owner_id', 'role', 'authorization_scope'], 'owner_context required exact', str(oc))
        dp = doc['input_schema'].get('properties', {}).get('domain_payload', {})
        c('research_bundle_dir' in dp.get('required', []), 'research_bundle_dir required')
        c('audit_refs' in doc['output_schema'].get('required', []), 'output audit_refs')
        rc = doc.get('runtime_contracts', {})
        c(rc.get('resource', {}).get('direct_resource_access') is False, 'direct_resource_access=false')
        c(rc.get('resource', {}).get('access_via_gateway_only') is True, 'gateway only')
        c(rc.get('owner_binding', {}).get('binding_resolved_by') == 'agent_layer', 'agent-layer binding')
        c(rc.get('audit', {}).get('emitted_by') == 'runtime', 'runtime audit')
        rg = rc.get('research_gate', {})
        c(rg.get('mandatory_before_report_validation') is True, 'research gate before report validation')
        c(rg.get('search_snippets_are_evidence') is False, 'search snippets prohibited as evidence')
        c(rg.get('failure_blocks_docx_generation') is True, 'research failure blocks DOCX')
    else:
        c(False, 'schemas.json found')

    text = all_text(root)
    c('staged' in text.lower(), 'staged ceiling')
    c(bool(re.search(r'production_release_allowed["\'\s:]+false', text, re.I)), 'production release false')
    c('search_snippets_are_evidence: false' in text or '"search_snippets_are_evidence": false' in text, 'snippet non-evidence invariant')
    c('selected_sources_must_be_opened' in text, 'source opening invariant')

    required = [
        'SKILL.md',
        'README.md',
        'input-template.md',
        'output-template.md',
        'quality-checklist.md',
        'examples/education-example.md',
        'examples/human-resources-example.md',
        'changelog.md',
        'agents/openai.yaml',
        'evals/evals.json',
        'evals/forecast_model.md',
        'evals/outcome_evaluation.md',
        'evals/replay_dataset.md',
        'evals/regression_tests.md',
        'references/skill-spec.yaml',
        'references/input-contract.md',
        'references/output-contract.md',
        'references/validation-contract.md',
        'references/ontology-mapping.md',
        'references/kstar-evolution.md',
        'references/governance-boundaries.md',
        'references/eval-cases.yaml',
        'references/mandatory-web-research-gate.md',
        'references/research-artifact-contract.md',
        'schemas/research-plan.schema.json',
        'schemas/web-research-ledger.schema.json',
        'schemas/research-gate.schema.json',
        'templates/research-plan.template.json',
        'templates/web-research-ledger.template.json',
        'templates/research-gate.template.json',
        'scripts/validate_research_bundle.py',
        'fixtures/research/research-plan.json',
        'fixtures/research/web-research-ledger.json',
        'tests/test_research_gate_failures.sh',
    ]
    missing = [x for x in required if not (root / x).exists()]
    c(not missing, 'Skill contract + v0.1 Candidate research-gate artifacts', ', '.join(missing))

    fail = 0
    print(f'Skill contract self-check · {root}\n')
    for ok, label, detail in checks:
        print(('✓' if ok else '✗'), label, ('— ' + detail if detail else ''))
        if not ok:
            fail += 1
    print('\nResult:', 'shape-compliant staged package with mandatory research gate' if not fail else f'{fail} hard failures')
    return 0 if not fail else 1


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else '.'))

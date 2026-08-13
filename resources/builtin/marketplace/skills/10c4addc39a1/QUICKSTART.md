# Quickstart · v0.1 Candidate

## Full pipeline with mandatory website-research gate

```bash
python -m pip install -r requirements.txt
cp fixtures/sample-report-data.json report-data.json
mkdir -p research
cp fixtures/research/research-plan.json research/research-plan.json
cp fixtures/research/web-research-ledger.json research/web-research-ledger.json

python scripts/run_skill.py \
  --input report-data.json \
  --research-dir research \
  --output-dir out \
  --strict \
  --render
```

The sample bundle is synthetic and only proves executable structure. For a real volume, the Agent must replace it with actual web search/open records from official government and standards-body sources.

Outputs include:

```text
out/research/research-plan.json
out/research/web-research-ledger.json
out/research/research-gate.json
out/research/research-validation-report.json
out/report-data.validated.json
out/*.docx
out/validation-report.json
out/verification-report.json
out/render/page-*.png
out/a11y-report.json
out/run-manifest.json
out/skill-output.json
```

If the research gate fails, Word generation is blocked and `skill-output.json` records `RESEARCH_GATE_FAILURE`.

## Mandatory visual QA

Open every `out/render/page-*.png`, inspect at 100% zoom, then record the result:

```bash
python scripts/record_visual_qa.py \
  --render-dir out/render \
  --reviewer "name-or-agent-id" \
  --status passed
```

The bundled fixture is synthetic and demonstrates the pipeline only; it is not an industry conclusion or business-value proof.

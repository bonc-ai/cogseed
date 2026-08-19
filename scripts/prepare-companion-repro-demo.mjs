#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const demoRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'userWorkSpace', 'companion-repro-demo');
const workspace = path.join(demoRoot, 'tiny-paper-repro');
const artifacts = path.join(workspace, 'artifacts');

function write(rel, body) {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
}

fs.mkdirSync(artifacts, { recursive: true });
write('README.md', `# Tiny Paper Repro

This repository is a deterministic Companion Agent demo fixture.

## Minimal reproduction

\`\`\`bash
python3 examples/minimal_repro.py --out artifacts/result.json
\`\`\`

## Expected result

- command exits with code 0
- \`artifacts/result.json\` is created
- result JSON contains \`{"status":"ok"}\`
`);
write('requirements.txt', '# no external dependencies required\n');
write('examples/minimal_repro.py', `#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--out', required=True)
args = parser.parse_args()
out = Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps({
    'status': 'ok',
    'metric': 0.99,
    'artifact': str(out),
}, indent=2), encoding='utf-8')
print(f'wrote {out}')
`);
write('tests/test_minimal_repro.py', `import json
import subprocess
import sys
from pathlib import Path


def test_minimal_repro(tmp_path):
    out = tmp_path / 'result.json'
    subprocess.check_call([sys.executable, 'examples/minimal_repro.py', '--out', str(out)])
    assert json.loads(out.read_text())['status'] == 'ok'
`);
write('.env', 'DEMO_SECRET=should-be-skipped\n');
write('node_modules/ignored.js', 'ignored\n');

const hash = crypto.createHash('sha1');
for (const rel of ['README.md', 'requirements.txt', 'examples/minimal_repro.py', 'tests/test_minimal_repro.py']) {
  hash.update(rel);
  hash.update(fs.readFileSync(path.join(workspace, rel)));
}
const commit = hash.digest('hex').slice(0, 12);
const paperSelection = 'The minimal experiment evaluates whether the reference implementation can produce the expected output artifact on a small deterministic fixture before attempting full-scale reproduction.';
const repoUrl = 'https://github.com/cogseed-agent/demo-tiny-paper-repro';
const userIntent = 'Run the minimal experiment on this Mac and verify that artifacts/result.json is produced with status ok.';

const payload = {
  paper_title: 'Tiny Paper Reproduction Demo',
  paper_selection: paperSelection,
  repo_url: repoUrl,
  commit,
  workspace_path: workspace,
  user_intent: userIntent,
  command_to_verify_after_commander_starts: 'python3 examples/minimal_repro.py --out artifacts/result.json',
};
fs.writeFileSync(path.join(demoRoot, 'companion-repro-demo-input.json'), JSON.stringify(payload, null, 2), 'utf8');

console.log('\nCompanion Research Repro demo fixture is ready.\n');
console.log(`Workspace path:\n${workspace}\n`);
console.log(`Paper title:\n${payload.paper_title}\n`);
console.log(`Paper selection:\n${paperSelection}\n`);
console.log(`Repo URL:\n${repoUrl}\n`);
console.log(`Commit:\n${commit}\n`);
console.log(`User intent:\n${userIntent}\n`);
console.log(`Saved input JSON:\n${path.join(demoRoot, 'companion-repro-demo-input.json')}\n`);
console.log('Optional manual verification:');
console.log(`cd '${workspace}' && python3 examples/minimal_repro.py --out artifacts/result.json && cat artifacts/result.json`);

import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, it } from 'vitest';

it('keeps the generic collaboration control plane independent from product adapters', () => {
  const dir = path.resolve(__dirname, '../../../../src/main/features/collaboration_control');
  const source = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n') : '';
  expect(source).not.toMatch(/features\/group_chat|features\/mate_agent_backend|renderer|ipc\//);
});

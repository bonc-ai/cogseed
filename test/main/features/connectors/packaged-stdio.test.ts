/** Real stdio handshakes: unpacked adapters must resolve dependencies inside ASAR. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const layout = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', async () => {
  const { createRequire } = await import('node:module');
  const stub = createRequire(import.meta.url)('../../../../bin/child-electron-stub.cjs');
  return { ...stub, app: { ...stub.app, isPackaged: true } };
});
vi.mock('../../../../src/main/paths', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/main/paths')>(),
  get PC_ROOT() { return layout.root; },
}));

import { CONNECTOR_CATALOG } from '../../../../src/main/features/connectors/catalog';
import { applyTemplate } from '../../../../src/main/features/connectors/apply-template';
import { McpConnection } from '../../../../src/main/features/connectors/mcp-client';

const require_ = createRequire(import.meta.url);
const entries = CONNECTOR_CATALOG.filter(entry => entry.transport_template?.kind === 'stdio'
  && entry.transport_template.command === '${COGSEED_NODE}');
let temp: string;

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-packaged-'));
  const source = path.join(temp, 'source');
  const seen = new Set<string>();
  function visit(name: string, base: string) {
    const req = createRequire(path.join(base, 'package.json'));
    const directory = req.resolve.paths(name)!.map(p => path.join(p, name))
      .find(p => fs.existsSync(path.join(p, 'package.json')));
    if (!directory) throw new Error(`Missing fixture dependency: ${name}`);
    if (seen.has(directory)) return;
    seen.add(directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, directory);
  }
  for (const dep of ['@modelcontextprotocol/sdk', 'undici', 'imapflow', 'mailparser']) visit(dep, process.cwd());
  for (const directory of [...seen].sort((a, b) => a.length - b.length)) {
    const dest = path.join(source, path.relative(process.cwd(), directory));
    if (!fs.existsSync(dest)) fs.cpSync(directory, dest, { recursive: true });
  }
  fs.cpSync(path.resolve('bin'), path.join(source, 'bin'), { recursive: true });
  layout.root = path.join(temp, 'app.asar');
  await require_('@electron/asar').createPackageWithOptions(source, layout.root, { unpackDir: 'bin' });
}, 60_000);

afterAll(() => { if (temp) fs.rmSync(temp, { recursive: true, force: true }); });

it.each(entries.map(entry => [entry.id, entry] as const))('%s starts outside the source tree with ASAR-only dependencies', async (_id, entry) => {
  const transport = applyTemplate(entry, { access_token: 'fixture-not-a-real-token' });
  if (transport.kind !== 'stdio') throw new Error('Expected stdio');
  // Route selection belongs to proxy tests. Here the explicit child proxy
  // below exercises dependency loading without consulting the machine's PAC.
  delete transport.proxyTargetUrl;
  // Exercise undici's dependency loading too, without issuing a provider request.
  transport.env = { ...transport.env, COGSEED_PROXY_MODE: 'env',
    COGSEED_PROXY_HTTP_URL: 'http://127.0.0.1:9',
    TMEET_CLI_CONFIG_DIR: path.join(temp, 'tmeet-config'), TMEET_CLI_DATA_DIR: path.join(temp, 'tmeet-data'),
    EMAIL_PROVIDER: entry.id, EMAIL_ADDRESS: entry.id === 'email-163' ? 'fixture@163.com' : 'fixture@qq.com',
    EMAIL_PASSWORD: 'fixture-not-sent', EMAIL_IMAP_HOST: 'imap.example.test', EMAIL_IMAP_PORT: '993', EMAIL_IMAP_SECURITY: 'tls' };
  transport.cwd = temp;
  const conn = new McpConnection(`packaged-${entry.id}`, transport);
  try {
    await conn.connect();
    if (entry.id.startsWith('email-')) {
      // Email discovery deliberately authenticates. An unknown tool verifies the
      // real protocol and module closure without contacting an email provider.
      expect(await conn.callTool('fixture_unknown_tool', {})).toMatchObject({ isError: true });
    } else {
      expect((await conn.listTools()).length).toBeGreaterThan(0);
    }
  } finally { await conn.close(); }
}, 20_000);

it('leaves third-party stdio and remote HTTP transport settings unchanged', () => {
  const custom = { ...entries[0], id: 'fixture-third-party', transport_template: {
    kind: 'stdio' as const, command: 'npx', args: ['fixture-mcp'],
  } };
  expect(applyTemplate(custom, null)).toEqual({ kind: 'stdio', command: 'npx', args: ['fixture-mcp'], env: {} });
  const remote = CONNECTOR_CATALOG.find(entry => entry.id === 'tencent-docs')!;
  expect(applyTemplate(remote, { access_token: 'fixture-token' })).toMatchObject({ kind: 'streamable-http' });
});

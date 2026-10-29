/** Exercise the real Electron-as-Node entrypoint with bin unpacked and npm dependencies in asar. */
import { it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { McpConnection } from '../../../../src/main/features/connectors/mcp-client';
const require_ = createRequire(import.meta.url);
const asar = require_('@electron/asar');
it('loads the email adapter dependency closure from a packaged asar', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'email-packaged-'));
  const src = path.join(temp, 'source');
  let conn: McpConnection | undefined;
  try {
    const seen = new Set<string>();
    function visit(name: string, base: string) {
      const req = createRequire(path.join(base, 'package.json'));
      const directory = req.resolve.paths(name)!.map(p => path.join(p, name)).find(p => fs.existsSync(path.join(p, 'package.json')))!;
      if (seen.has(directory)) return;
      seen.add(directory);
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, directory);
    }
    for (const dep of ['imapflow', 'mailparser', '@modelcontextprotocol/sdk', 'zod']) visit(dep, process.cwd());
    for (const directory of [...seen].sort((a, b) => a.length - b.length)) {
      const dest = path.join(src, path.relative(process.cwd(), directory));
      if (!fs.existsSync(dest)) fs.cpSync(directory, dest, { recursive: true });
    }
    fs.mkdirSync(path.join(src, 'bin'), { recursive: true });
    for (const file of ['email-mcp-server.cjs', 'email-mcp-core.cjs']) fs.copyFileSync(path.resolve('bin', file), path.join(src, 'bin', file));
    await asar.createPackageWithOptions(src, path.join(temp, 'app.asar'), { unpackDir: 'bin' });
    conn = new McpConnection('email-package-test', { kind: 'stdio', command: process.execPath,
      args: [path.join(temp, 'app.asar.unpacked/bin/email-mcp-server.cjs')], env: {
        ELECTRON_RUN_AS_NODE: '1', EMAIL_PROVIDER: 'email-163', EMAIL_ADDRESS: 'protocol-test@163.com', EMAIL_PASSWORD: 'not-sent',
      } });
    await conn.connect();
    const result = await conn.callTool('send_mail', {}) as any;
    expect(result).toMatchObject({ isError: true, content: [{ text: 'email_unknown_tool' }] });
  } finally { await conn?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
}, 60_000);

#!/usr/bin/env node
// Standalone design preview only; never imported by the Electron runtime.
// Serve existing generated assets without caching; JSX changes still need build.cjs.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--port')) {
  process.stderr.write('Usage: npm run design:preview -- [--port 4173]\n');
  process.exit(1);
}
const port = args.length ? Number(args[1]) : 4173;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write('Port must be an integer from 1 to 65535.\n');
  process.exit(1);
}
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.md': 'text/plain; charset=utf-8',
};
function insideRoot(file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const server = http.createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return reply(405, 'Method not allowed');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid path');
  } catch {
    return reply(400, 'Invalid path');
  }
  if (pathname.split('/').some(segment => segment.startsWith('.'))) return reply(403, 'Forbidden');
  try {
    let file = path.resolve(root, `.${pathname}`);
    if (!insideRoot(file)) return reply(403, 'Forbidden');
    file = await fs.realpath(file);
    if (!insideRoot(file)) return reply(403, 'Forbidden');
    if ((await fs.stat(file)).isDirectory()) {
      if (!pathname.endsWith('/')) {
        const query = new URL(req.url, 'http://127.0.0.1').search;
        res.writeHead(302, { Location: encodeURI(pathname + '/').replace(/^\/+/, '/') + query });
        return res.end();
      }
      file = await fs.realpath(path.join(file, 'index.html'));
    }
    if (!insideRoot(file)) return reply(403, 'Forbidden');
    const content = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    reply(['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : 500, 'File unavailable');
  }
});
server.on('error', error => {
  process.stderr.write(error.code === 'EADDRINUSE'
    ? `Port ${port} is occupied. Use npm run design:preview -- --port 4174\n`
    : `${error.message}\n`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`CogSeed Open-source Design System: http://127.0.0.1:${port}/\nRefresh to see saved changes. Press Ctrl+C to stop.\n`);
});

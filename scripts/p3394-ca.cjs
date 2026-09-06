#!/usr/bin/env node
/**
 * P3394 私有 CA 工具（标准 §15 生产远程 Channel 的证书供给）。
 *
 * 用 openssl（macOS/Linux 自带）生成内网可用的 TLS 信任链：
 *   1. init  —— 生成私有 CA（ca.key / ca.crt，默认 10 年）
 *   2. issue —— 用 CA 给节点签发证书（<name>.key / <name>.crt，默认 3 年）
 *
 * 产物对应的环境变量：
 *   A 机桥：COGSEED_P3394_TLS_CERT=<name>.crt  COGSEED_P3394_TLS_KEY=<name>.key
 *           COGSEED_P3394_TLS_CA=ca.crt（要求客户端证书时再开 REQUIRE_CLIENT_CERT=1）
 *   B 机网关：P3394_GATEWAY_TLS_CERT/_KEY（自身 https 监听）+ P3394_TLS_CA=ca.crt（回连校验）
 *
 * 公网场景请改用公共 CA（Let's Encrypt 等，需域名，见《P3394-外部资源申请清单》）。
 */
'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const TEN_YEARS_DAYS = 3650;
const THREE_YEARS_DAYS = 1095;

function usage(code) {
  console.log('用法：');
  console.log('  node scripts/p3394-ca.cjs init  --dir ./p3394-pki [--cn P3394-Private-CA]');
  console.log('  node scripts/p3394-ca.cjs issue --dir ./p3394-pki --name 192.168.1.10');
  process.exit(code);
}

function parseArgv(argv) {
  const out = { cmd: argv[2] };
  for (let i = 3; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) usage(2);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.cmd || !['init', 'issue'].includes(out.cmd)) usage(2);
  return out;
}

function openssl(args, opts = {}) {
  try {
    execFileSync('openssl', args, {
      stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      ...(opts.input !== undefined ? { input: opts.input } : {}),
    });
  } catch (err) {
    console.error('openssl 执行失败：', err.stderr ? err.stderr.toString().trim() : err.message);
    process.exit(1);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyDir = path.join(dir, 'private');
  fs.mkdirSync(keyDir, { recursive: true });
  return keyDir;
}

function initCa(opts) {
  const dir = opts.dir;
  if (!dir) usage(2);
  const keyDir = ensureDir(dir);
  const caKey = path.join(keyDir, 'ca.key');
  const caCrt = path.join(dir, 'ca.crt');
  if (fs.existsSync(caCrt)) {
    console.error(`已存在 ${caCrt}；如需重建请先删除整个目录`);
    process.exit(1);
  }
  const cn = opts.cn || 'P3394-Private-CA';
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes',
    '-keyout', caKey, '-out', caCrt, '-days', String(TEN_YEARS_DAYS),
    '-subj', `/CN=${cn}`,
    '-addext', 'basicConstraints=critical,CA:true',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  fs.chmodSync(caKey, 0o600);
  console.log(`私有 CA 已生成：`);
  console.log(`  CA 证书（分发到各节点做信任锚）：${caCrt}`);
  console.log(`  CA 私钥（只留在签发机，勿分发）：${caKey}`);
}

function issueNodeCert(opts) {
  const dir = opts.dir;
  const name = opts.name;
  if (!dir || !name) usage(2);
  const caCrt = path.join(dir, 'ca.crt');
  const caKey = path.join(dir, 'private', 'ca.key');
  if (!fs.existsSync(caCrt) || !fs.existsSync(caKey)) {
    console.error(`找不到 ${caCrt} / ${caKey}，请先 init`);
    process.exit(1);
  }
  const isIp = /^[0-9.]+$/.test(name);
  const san = isIp ? `IP:${name}` : `DNS:${name}`;
  const keyPath = path.join(dir, `${name}.key`);
  const crtPath = path.join(dir, `${name}.crt`);
  const csrPath = path.join(dir, `${name}.csr`);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', csrPath, '-subj', `/CN=${name}`]);
  openssl(['x509', '-req', '-in', csrPath,
    '-CA', caCrt, '-CAkey', caKey, '-CAcreateserial',
    '-out', crtPath, '-days', String(THREE_YEARS_DAYS),
    '-extfile', '/dev/stdin'], { input: `subjectAltName=${san}\nbasicConstraints=CA:false\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth\n` });
  fs.rmSync(csrPath, { force: true });
  fs.chmodSync(keyPath, 0o600);
  console.log(`节点证书已签发（SAN=${san}）：`);
  console.log(`  证书：${crtPath}`);
  console.log(`  私钥：${keyPath}`);
  console.log(`对端信任配置使用 CA 证书：${caCrt}`);
}

const opts = parseArgv(process.argv);
if (opts.cmd === 'init') initCa(opts);
else issueNodeCert(opts);

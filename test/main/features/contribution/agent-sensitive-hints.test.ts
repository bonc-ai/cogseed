/**
 * 预览页"可能包含本机信息"提示：认得出最明显的两类，认不出的不乱报，凭据的值被遮住。
 * 不是安全扫描，命中不阻断。
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_HINTS_PER_FILE, MAX_HINTS_TOTAL, looksBinary, scanFilesForHints, scanTextForHints,
} from '../../../../src/main/features/contribution/agent-sensitive-hints';

const hints = (text: string) => scanTextForHints('agent.json', text);

describe('本机路径', () => {
  it.each([
    ['示例材料在 /Users/lin/Documents/发票2024/ 下', '/Users/lin/Documents/发票2024/'],
    ['cd /home/dev/projects/app && ls', '/home/dev/projects/app'],
    ['路径是 C:\\Users\\Lin\\Desktop\\报销', 'C:\\Users\\Lin\\Desktop\\报销'],
    ['盘符小写 d:\\Users\\x\\y', 'd:\\Users\\x\\y'],
  ])('%s', (text, excerpt) => {
    const [h] = hints(text);
    expect(h.kind).toBe('local_path');
    expect(h.excerpt).toBe(excerpt);
  });

  it('不带用户名的路径、相对路径、网址里的 /Users 字样不报', () => {
    expect(hints('把文件放到 ./data/input 或 ~/notes')).toEqual([]);
    expect(hints('系统工具在 /usr/local/bin 与 /etc/hosts')).toEqual([]);
    expect(hints('说明文字里提到 Users 和 home 这两个词')).toEqual([]);
  });

  it('行号从 1 起算，指出具体哪一行', () => {
    const found = hints('第一行没事\n第二行也没事\n第三行 /Users/lin/x');
    expect(found.map((h) => h.line)).toEqual([3]);
  });

  it('CRLF 换行行号也对', () => {
    expect(hints('a\r\nb\r\n/home/u/x').map((h) => h.line)).toEqual([3]);
  });
});

describe('疑似凭据：值被遮住', () => {
  it('sk- / ghp_ / AKIA 这类固定格式的令牌', () => {
    const sk = hints('key = sk-abcdefghijklmnopqrstuvwx')[0];
    expect(sk.kind).toBe('credential_like');
    expect(sk.excerpt).not.toContain('abcdefghijklmnopqrstuvwx');
    expect(sk.excerpt).toContain('sk-a');
    expect(hints('GITHUB ghp_abcdefghijklmnopqrstuvwxyz0123')[0].kind).toBe('credential_like');
    expect(hints('aws AKIAABCDEFGHIJKLMNOP')[0].kind).toBe('credential_like');
  });

  it('Bearer 令牌：只留开头几位', () => {
    const h = hints('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456')[0];
    expect(h.excerpt.startsWith('Bearer ')).toBe(true);
    expect(h.excerpt).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('名字像密钥、值像随机串的赋值', () => {
    for (const line of ['api_key = "k3j4h5g6f7d8s9a0"', 'password: hunter2hunter2', 'SECRET=abcdef1234567890', 'access-key: ZZZZ1111yyyy2222']) {
      const h = hints(line)[0];
      expect(h?.kind, line).toBe('credential_like');
      expect(h.excerpt, line).toContain('****');
    }
  });

  it('值太短或像普通词的不报；只是提到"密码"这个词不报', () => {
    expect(hints('password: 1234')).toEqual([]);
    expect(hints('请让用户输入密码，不要保存 token')).toEqual([]);
    expect(hints('the token count is high')).toEqual([]);
  });

  it('整串凭据不会出现在任何摘录里', () => {
    const secret = 'sk-SECRETSECRETSECRETSECRET99';
    const out = hints(`a ${secret} b\napi_key=${secret}\nBearer ${secret}`);
    expect(out.length).toBeGreaterThan(0);
    for (const h of out) expect(h.excerpt).not.toContain('SECRETSECRETSECRET');
  });
});

describe('一行里的多类、数量上限', () => {
  it('同一行同一类只报一次；不同类各报一次', () => {
    const out = hints('/Users/a/b 和 /Users/c/d，另有 sk-abcdefghijklmnopqrstuv');
    expect(out.map((h) => h.kind).sort()).toEqual(['credential_like', 'local_path']);
  });

  it('单个文件最多 MAX_HINTS_PER_FILE 条', () => {
    const text = Array.from({ length: 40 }, (_, i) => `/Users/u${i}/x`).join('\n');
    expect(hints(text)).toHaveLength(MAX_HINTS_PER_FILE);
  });

  it('整体最多 MAX_HINTS_TOTAL 条', () => {
    const body = Array.from({ length: 30 }, (_, i) => `/Users/u${i}/x`).join('\n');
    const files = Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.md`, size: body.length }));
    const out = scanFilesForHints(files, () => Buffer.from(body));
    expect(out).toHaveLength(MAX_HINTS_TOTAL);
  });
});

describe('扫一批文件', () => {
  const read = (map: Record<string, string | Buffer>) => (p: string) => {
    const v = map[p];
    return v === undefined ? null : (Buffer.isBuffer(v) ? v : Buffer.from(v));
  };

  it('逐个文件扫，带上相对路径', () => {
    const out = scanFilesForHints(
      [{ path: 'agent.json', size: 10 }, { path: 'skills/ocr/SKILL.md', size: 10 }],
      read({ 'agent.json': '{"workflow":"读 /Users/lin/x"}', 'skills/ocr/SKILL.md': '干净' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: 'agent.json', kind: 'local_path', line: 1 });
  });

  it('二进制、超大文件、读不到的文件都跳过，不让提示功能挡住贡献', () => {
    const files = [{ path: 'bin.dat', size: 5 }, { path: 'huge.txt', size: 10 * 1024 * 1024 }, { path: 'gone.txt', size: 5 }, { path: 'throws.txt', size: 5 }];
    const out = scanFilesForHints(files, (p) => {
      if (p === 'throws.txt') throw new Error('EACCES');
      return read({ 'bin.dat': Buffer.from([0, 1, 2, 47, 85]), 'huge.txt': '/Users/lin/x' })(p);
    });
    expect(out).toEqual([]);
  });

  it('looksBinary 只看 NUL 字节', () => {
    expect(looksBinary(Buffer.from('正常文本'))).toBe(false);
    expect(looksBinary(Buffer.from([65, 0, 66]))).toBe(true);
  });
});

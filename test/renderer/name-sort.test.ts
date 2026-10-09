import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';


const nameLimitSource = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/modules/name-limit.js'), 'utf8',
);
const nameSortSource = fs.readFileSync(
  path.join(process.cwd(), 'src/renderer/modules/name-sort.js'), 'utf8',
);

function loadNameLimit() {
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const range = { selectNodeContents: vi.fn(), collapse: vi.fn() };
  const windowObj = { getSelection: () => selection } as Record<string, unknown>;
  const sandbox = {
    window: windowObj,
    document: { createRange: () => range },
    Intl,
    Array,
    String,
    Number,
  };
  vm.runInNewContext(nameLimitSource, sandbox, { filename: 'name-limit.js' });
  return {
    api: windowObj as {
      NAME_DISPLAY_MAX_UNITS: number;
      nameDisplayWidth: (text: unknown) => number;
      limitNameDisplayText: (text: unknown, max?: number) => string;
      enforceNameLimitOnControl: (el: unknown, max?: number) => string;
      bindNameLimitControl: (el: unknown, max?: number) => void;
    },
    selection,
    range,
  };
}

function fakeControl({ value = '', editable = false } = {}) {
  const listeners = new Map<string, Array<() => void>>();
  const control = {
    dataset: {} as Record<string, string>,
    isContentEditable: editable,
    value,
    innerText: value,
    setSelectionRange: vi.fn(),
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    }),
  };
  return {
    control,
    emit: (type: string) => listeners.get(type)?.forEach((listener) => listener()),
  };
}

describe('renderer name length limit', () => {
  it('counts ASCII as one and wide graphemes as two', () => {
    const { api } = loadNameLimit();
    expect(api.NAME_DISPLAY_MAX_UNITS).toBe(60);
    expect(api.nameDisplayWidth('abc')).toBe(3);
    expect(api.nameDisplayWidth('中文')).toBe(4);
    expect(api.nameDisplayWidth('A中😀')).toBe(5);
  });

  it('keeps combining marks and joined emoji within one grapheme width', () => {
    const { api } = loadNameLimit();
    expect(api.nameDisplayWidth('e\u0301')).toBe(1);
    expect(api.nameDisplayWidth('👨‍👩‍👧‍👦')).toBe(2);
  });

  it('truncates at display width without splitting grapheme clusters', () => {
    const { api } = loadNameLimit();
    expect(api.limitNameDisplayText('ab中文c', 5)).toBe('ab中');
    expect(api.limitNameDisplayText(`a👨‍👩‍👧‍👦b`, 3)).toBe('a👨‍👩‍👧‍👦');
    expect(api.limitNameDisplayText('anything', 0)).toBe('');
  });

  it('enforces input and contenteditable values and restores the caret', () => {
    const { api, selection, range } = loadNameLimit();
    const input = fakeControl({ value: 'abc中文' }).control;
    expect(api.enforceNameLimitOnControl(input, 4)).toBe('abc');
    expect(input.value).toBe('abc');
    expect(input.setSelectionRange).toHaveBeenCalledWith(3, 3);

    const editable = fakeControl({ value: 'a中文', editable: true }).control;
    expect(api.enforceNameLimitOnControl(editable, 3)).toBe('a中');
    expect(editable.innerText).toBe('a中');
    expect(range.selectNodeContents).toHaveBeenCalledWith(editable);
    expect(selection.addRange).toHaveBeenCalledWith(range);
  });

  it('binds once and defers truncation until IME composition ends', () => {
    const { api } = loadNameLimit();
    const { control, emit } = fakeControl({ value: 'ok' });
    api.bindNameLimitControl(control, 2);
    api.bindNameLimitControl(control, 2);
    expect(control.addEventListener).toHaveBeenCalledTimes(3);

    emit('compositionstart');
    control.value = '中文';
    emit('input');
    expect(control.value).toBe('中文');
    emit('compositionend');
    expect(control.value).toBe('中');
  });
});

describe('renderer native display-name sorting', () => {
  function load() {
    return vm.runInNewContext(
      `${nameSortSource}\n({ compareDisplayNames })`,
      { Intl, String },
      { filename: 'name-sort.js' },
    ) as {
      compareDisplayNames: (left: string, right: string) => number;
    };
  }

  it('sorts Chinese names by native pinyin collation', () => {
    const api = load();
    const names = ['张三', '李四', '王五', '赵六', '阿里', '陈七', '一丁'];
    expect(names.sort(api.compareDisplayNames)).toEqual(['阿里', '陈七', '李四', '王五', '一丁', '张三', '赵六']);
  });

  it('compares Latin text without case sensitivity and honors numeric order', () => {
    const api = load();
    expect(['Agent 10', 'agent 2', 'Agent 1'].sort(api.compareDisplayNames))
      .toEqual(['Agent 1', 'agent 2', 'Agent 10']);
  });

  it('does not ship the removed third-party pinyin table', () => {
    const removedVendorDir = path.join(process.cwd(), 'src/renderer/vendor', ['pinyin', 'firstletter'].join('-'));
    const removedScript = ['pinyin', 'firstletter'].join('-');
    expect(fs.existsSync(removedVendorDir)).toBe(false);
    expect(fs.readFileSync(path.join(process.cwd(), 'src/renderer/index.html'), 'utf8'))
      .not.toContain(removedScript);
  });
});

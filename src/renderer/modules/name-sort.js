// Locale-aware display-name sorting built into Electron's ICU runtime.
// No third-party transliteration data is bundled with the application.
let _nameSortCollator = null;

function _getNameSortCollator() {
  if (_nameSortCollator) return _nameSortCollator;
  try {
    _nameSortCollator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', {
      sensitivity: 'base',
      numeric: true,
      ignorePunctuation: true,
    });
  } catch {
    _nameSortCollator = new Intl.Collator(undefined, {
      sensitivity: 'base',
      numeric: true,
      ignorePunctuation: true,
    });
  }
  return _nameSortCollator;
}

function compareDisplayNames(left, right) {
  return _getNameSortCollator().compare(String(left || ''), String(right || ''));
}

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const list = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.cjs'));
const variants = list.length ? list : ['a:m', 'b:m', 'a:s', 'a:l'];
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1310, height: 900, show: true, useContentSize: true,
    webPreferences: { backgroundThrottling: false },
  });
  const url = pathToFileURL(path.join(__dirname, 'index.html'));
  url.searchParams.set('clean', '1');
  try {
    for (const spec of variants) {
      const [pos, size] = spec.split(':');
      await win.loadURL(url.toString());
      await new Promise((r) => setTimeout(r, 2500));
      await win.webContents.executeJavaScript(`(function(){
        var img = document.querySelector('.squirrel-perch');
        img.dataset.pos = ${JSON.stringify(pos)};
        img.setAttribute('size', ${JSON.stringify(size || 'm')});
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 700));
      const img = await win.webContents.capturePage();
      const tag = size && size !== 'm' ? `-${size}` : '';
      const out = path.join(__dirname, `preview-pos-${pos}${tag}.png`);
      fs.writeFileSync(out, img.toPNG());
      console.log('saved', out, img.toPNG().length);
    }
  } catch (err) {
    console.error('FAILED', err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

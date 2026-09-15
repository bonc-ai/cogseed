// Real Chromium layout checks against production styles, without user data or IPC.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { sandbox: true } });
  const root = path.resolve(__dirname, '../../../src/renderer');
  const styles = ['tokens.css', 'style.css', 'workspace.css', 'ui-components.css'];
  await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><head></head><body></body></html>'));
  for (const file of styles) await window.webContents.insertCSS(fs.readFileSync(path.join(root, file), 'utf8'));
  const outcome = await window.webContents.executeJavaScript(`(() => {
    try {
    const results = [];
    const grids = [
      ['ws-space-grid', 'ws-space-card'],
      ['ws-template-grid', 'ws-template-card'],
      ['auto-tpl-grid', 'auto-tpl-card'],
      ['agents-grid', 'agent-card'],
      ['agents-source-section-grid', 'agent-card'],
      ['skills-grid', 'skill-card'],
      ['skills-source-section-grid', 'skill-card'],
      ['connectors-grid', 'connector-card'],
      ['gallery-resource-grid', 'ui-resource-card'],
    ];
    for (const [gridClass, cardClass] of grids) {
      for (const [width, columns] of [[240,1],[575,1],[576,2],[871,2],[872,3],[1232,3],[1500,3]]) {
        for (const count of [1,6]) {
          const cards = Array.from({ length: count }, (_, index) => '<article class="' + cardClass + '"><div>' + 'LongResourceName'.repeat(index === 0 ? 12 : 1) + '</div></article>').join('');
          document.body.innerHTML = '<div style="width:' + width + 'px"><div class="ui-resource-grid ' + gridClass + '">' + cards + '</div></div>';
          const grid = document.body.firstElementChild.firstElementChild;
          const computed = getComputedStyle(grid);
          const actual = computed.gridTemplateColumns.split(' ').length;
          const boxes = [...grid.children].map(child => child.getBoundingClientRect());
          const card = boxes[0];
          const expectedWidth = (Math.min(width, 1232) - (columns - 1) * 16) / columns;
          const firstRow = boxes.filter(box => Math.abs(box.top - card.top) < 1);
          const sameHeight = firstRow.every(box => Math.abs(box.height - card.height) < 1);
          if (actual !== columns || Math.abs(card.width - expectedWidth) > 1 || grid.scrollWidth > grid.clientWidth + 1 || computed.columnGap !== '16px' || !sameHeight) {
            throw new Error(JSON.stringify({ gridClass, width, count, actual, columns, cardWidth: card.width, expectedWidth, overflow: grid.scrollWidth - grid.clientWidth, sameHeight }));
          }
          results.push({ gridClass, width, count, columns });
        }
      }
    }
    return { results };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })()`);
  if (outcome.error) throw new Error(outcome.error);
  console.log(JSON.stringify({ passed: outcome.results.length }));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });

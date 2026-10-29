import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

describe('S4 catalog real-page integration contract', () => {
  const html = read('src/renderer/index.html');
  const lazy = read('src/renderer/modules/lazy-features.js');
  const catalog = read('src/renderer/modules/catalog.js');
  const agents = read('src/renderer/modules/agents.js');
  const skills = read('src/renderer/modules/skills.js');
  const css = read('src/renderer/style.css');

  it('loads the production catalog seam and mounts both page subview hosts', () => {
    const marketplaceStart = lazy.indexOf("marketplace: [");
    const marketplaceModule = lazy.indexOf("{ src: './modules/marketplace.js' }", marketplaceStart);
    const catalogModule = lazy.indexOf("{ src: './modules/catalog.js' }", marketplaceStart);

    expect(marketplaceStart).toBeGreaterThanOrEqual(0);
    expect(catalogModule).toBeGreaterThan(marketplaceModule);
    expect(html).toContain('id="agents-catalog-actions"');
    expect(html).toContain('id="skills-catalog-actions"');
    expect(html).toContain('id="agents-subview-back"');
    expect(html).toContain('id="skills-subview-back"');
    expect(catalog).toContain('window.openCatalogPopup = openCatalogPopup;');
    expect(catalog).toContain('window.catalogInstalledGridHtml = catalogInstalledGridHtml;');
  });

  it('wires the unified popup into the real Agent and Skill cards through shared primitives', () => {
    expect(agents).toContain('openCatalogPopup({');
    expect(skills).toContain('openCatalogPopup({');
    expect(catalog).toContain('const modal = uiModal({');
    expect(catalog).toContain('const primary = uiButton({');
    expect(catalog).toContain('uiStatusPill({ label, tone })');
    expect(catalog).not.toMatch(/<(?:button|input|textarea|select)\b/i);
    expect(css).toContain('.catalog-popup-content');
  });

  it('adopts the create-agent dialog into the shared modal lifecycle', () => {
    expect(html).toContain('id="agent-modal" hidden');
    expect(agents).toContain('uiModalController({');
    expect(agents).toContain("initialFocus: '#agent-modal-tabs .is-active'");
    expect(agents).toContain("fallbackFocus: '#create-agent-btn'");
    expect(agents).toContain("controller.close('close')");
  });

  it('wires installed cards, status filters and overflow actions into both real pages', () => {
    expect(agents).toContain("catalogInstalledGridHtml(rows, 'agent')");
    expect(skills).toContain("catalogInstalledGridHtml(rows, 'skill')");
    expect(agents).toContain('catalogOpenRowMenu(actionEl, items');
    expect(skills).toContain('catalogOpenRowMenu(actionEl, items');
    expect(catalog).toContain('window.uiSegmentedControl({');
    expect(catalog).toContain("uiSwitch({\n      label:");
    expect(catalog).toContain("uiIconButton({\n      label:");
    expect(css).toContain('.catalog-installed-grid');
    expect(css).toContain('.catalog-row-menu');
  });

  it('wires signed-out/offline feedback and the local-roots switch into the production views', () => {
    expect(agents).toContain("catalogHomeBannerHtml('agent')");
    expect(skills).toContain("catalogHomeBannerHtml('skill')");
    expect(catalog).toContain('data-catalog-banner-action');
    expect(skills).toContain('class="catalog-local-bar"');
    expect(skills).toContain("window.uiSwitch({");
    expect(skills).toContain("window.cogseed.invoke('skills.setGlobalRootsEnabled'");
    expect(css).toContain('.catalog-home-banner');
    expect(css).toContain('.catalog-local-bar');
  });
});

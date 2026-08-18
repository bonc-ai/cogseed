import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('renderer continue-work wizard wiring', () => {
  it('exposes the standalone flow and reuses session-import backends', () => {
    const wizard = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/continue-work.js'), 'utf8');
    const conversation = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
    const index = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

    expect(wizard).toContain('window.continueWork = { open }');
    expect(wizard).toContain("window.cogseed.invoke('localAgents.list')");
    expect(wizard).toContain("window.cogseed.invoke('localAgents.listClaudeSessions')");
    expect(wizard).toContain("window.cogseed.invoke('sessionImport.listCodexSessions')");
    expect(wizard).toContain("window.cogseed.invoke('sessionImport.importClaudeSession'");
    expect(wizard).toContain("window.cogseed.invoke('sessionImport.importCodexSession'");
    expect(wizard).toContain('window._markConversationListLocallyChanged');
    expect(wizard).toContain('loadConversations()');
    expect(wizard).toContain("setView('conversation'");

    expect(conversation).toContain('window.continueWork.open()');
    expect(index).toContain('<script src="./modules/continue-work.js"></script>');
  });
});

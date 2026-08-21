/**
 * Installer action abstraction.
 *
 * v1 hands the verified installer to the OS:
 *   - macOS dmg → `shell.openPath` mounts the image and opens a Finder
 *     window; the user drags CogSeed into /Applications (Gatekeeper makes
 *     silent dmg installs impossible by design).
 *   - Windows exe / macOS zip → also just revealed in the OS for now.
 *
 * Phase 2 (zip-based automatic replacement, Squirrel.Mac-style) replaces
 * this implementation behind the same signature — `features/updater/client`
 * calls `openDownloadedUpdate` via dynamic import, so callers never change.
 */

import { shell } from 'electron';

export async function openDownloadedUpdate(installerPath: string): Promise<void> {
  const errorMessage = await shell.openPath(installerPath);
  if (errorMessage) throw new Error(errorMessage);
}

import { existsSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Resolves a Chrome executable for Remotion to use, avoiding a network download.
 *
 * Remotion needs the "chrome-headless-shell" (the old headless mode). Playwright
 * ships exactly that next to its full Chromium, so derive its path from
 * Playwright's executable. Honors DEMOPILOT_CHROME as an override; falls back to
 * the full Chromium (and ultimately to Remotion's own download) if no shell is
 * found.
 */
export function resolveChromeForRemotion(): string | undefined {
  if (process.env.DEMOPILOT_CHROME) return process.env.DEMOPILOT_CHROME;

  let full: string;
  try {
    full = chromium.executablePath();
  } catch {
    return undefined;
  }

  // .../chromium-<rev>/chrome-linux/chrome  ->  .../chromium_headless_shell-<rev>/chrome-linux/headless_shell
  const shell = full
    .replace(/chromium-(\d+)/, "chromium_headless_shell-$1")
    .replace(/chrome-linux\/chrome$/, "chrome-linux/headless_shell")
    .replace(/chrome-mac\/.*$/, "chrome-mac/headless_shell")
    .replace(/chrome-win\\chrome\.exe$/, "chrome-win\\headless_shell.exe");

  if (shell !== full && existsSync(shell)) return shell;
  return existsSync(full) ? full : undefined;
}

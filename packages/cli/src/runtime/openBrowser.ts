/**
 * Cross-platform default browser launcher used by `--login` flows.
 *
 * Honours the `BROWSER` env var as an override; otherwise picks the
 * platform-native opener (`open` on macOS, `start` on Windows,
 * `xdg-open` on Linux). Failure to spawn is non-fatal — the authorize
 * URL is always logged so the user can paste it manually.
 */

import { spawn } from 'node:child_process';
import type { AuthorizeBrowser } from '../tokens/index.js';

/** Browser command resolved for a validated authorization URL. */
export interface BrowserLaunchCommand {
    readonly cmd: string;
    readonly args: readonly string[];
}

/** Resolve a shell-free platform browser command for an HTTP(S) URL. */
export function browserLaunchCommand(
    url: string,
    currentPlatform: NodeJS.Platform = process.platform,
    override: string | undefined = process.env['BROWSER'],
): BrowserLaunchCommand | null {
    try {
        const protocol = new URL(url).protocol;
        if (protocol !== 'http:' && protocol !== 'https:') return null;
    } catch {
        return null;
    }

    if (override) return { cmd: override, args: [url] };
    if (currentPlatform === 'darwin') return { cmd: 'open', args: [url] };
    if (currentPlatform === 'win32') {
        return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
    }
    return { cmd: 'xdg-open', args: [url] };
}

/** Best-effort cross-platform browser launcher; never throws. */
export const defaultOpenBrowser: AuthorizeBrowser = (url: string) => {
    const command = browserLaunchCommand(url);
    if (!command) return;
    try {
        const child = spawn(command.cmd, [...command.args], { stdio: 'ignore', detached: true });
        child.on('error', () => undefined);
        child.unref();
    } catch {
        // Browser launch failed; URL was already logged.
    }
};

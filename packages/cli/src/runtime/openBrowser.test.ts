/** Unit tests for shell-free browser command selection. */

import { describe, expect, it } from 'vitest';
import { browserLaunchCommand } from './openBrowser.js';

describe('browserLaunchCommand', () => {
    it('uses the shell-free Windows URL protocol handler', () => {
        const url = 'https://idp.example/authorize?a=1&next=calc.exe|ignored';
        expect(browserLaunchCommand(url, 'win32', undefined)).toEqual({
            cmd: 'rundll32.exe',
            args: ['url.dll,FileProtocolHandler', url],
        });
    });

    it('preserves the configured executable override without a shell', () => {
        const url = 'https://idp.example/authorize?a=1&b=2';
        expect(browserLaunchCommand(url, 'win32', 'custom-browser')).toEqual({
            cmd: 'custom-browser',
            args: [url],
        });
    });

    it.each(['file:///tmp/token', 'javascript:alert(1)', 'not-a-url'])(
        'rejects non-HTTP authorization URL %s',
        (url) => {
            expect(browserLaunchCommand(url, 'win32', undefined)).toBeNull();
        },
    );

    it.each([
        ['darwin', 'open'],
        ['linux', 'xdg-open'],
    ] as const)('retains the %s default opener', (platform, cmd) => {
        expect(browserLaunchCommand('http://localhost:33423/callback', platform, undefined)).toEqual(
            {
                cmd,
                args: ['http://localhost:33423/callback'],
            },
        );
    });
});

/**
 * macOS Keychain backend via the `security` CLI.
 *
 * No native dependency: we shell out to the system tool that ships
 * with macOS, so `npx mcp-savvy` works without node-gyp.
 */

import { platform } from 'node:os';
import type { KeychainBackend, KeychainBackendOptions } from './types.js';
import { nodeRunner, type Runner } from '../runner.js';

const SET_PASSWORD_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');

function run(argv) {
    const inputData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    const value = ObjC.unwrap(
        $.NSString.alloc.initWithDataEncoding(inputData, $.NSUTF8StringEncoding),
    );
    const secClass = ObjC.castRefToObject($.kSecClass);
    const genericPassword = ObjC.castRefToObject($.kSecClassGenericPassword);
    const attrService = ObjC.castRefToObject($.kSecAttrService);
    const attrAccount = ObjC.castRefToObject($.kSecAttrAccount);
    const valueDataKey = ObjC.castRefToObject($.kSecValueData);
    const query = $.NSMutableDictionary.alloc.init;
    query.setObjectForKey(genericPassword, secClass);
    query.setObjectForKey($(argv[0]), attrService);
    query.setObjectForKey($(argv[1]), attrAccount);
    $.SecItemDelete(query);
    const item = $.NSMutableDictionary.dictionaryWithDictionary(query);
    item.setObjectForKey($(value).dataUsingEncoding($.NSUTF8StringEncoding), valueDataKey);
    const status = $.SecItemAdd(item, $());
    if (status !== 0) throw new Error('SecItemAdd failed with status ' + status);
}
`;

/** Constructor options for `MacOSKeychain`. */
export interface MacOSKeychainOptions extends KeychainBackendOptions {
    /** Override the subprocess runner. Tests pass a fake; prod leaves unset. */
    runner?: Runner;
    /** Override `process.platform`. Tests pass 'darwin'; prod leaves unset. */
    platform?: NodeJS.Platform;
}

/** macOS implementation of `KeychainBackend`. */
export class MacOSKeychain implements KeychainBackend {
    readonly name = 'macOS Keychain';
    private readonly service: string;
    private readonly account: string;
    private readonly runner: Runner;
    private readonly currentPlatform: NodeJS.Platform;

    constructor(opts: MacOSKeychainOptions) {
        this.service = opts.service;
        this.account = opts.account;
        this.runner = opts.runner ?? nodeRunner;
        this.currentPlatform = opts.platform ?? platform();
    }

    /** True only on Darwin; the `security` binary ships with the OS. */
    isAvailable(): boolean {
        return this.currentPlatform === 'darwin';
    }

    /** Read the password for our service+account, or null if not set. */
    get(): string | null {
        try {
            const out = this.runner.run('security', [
                'find-generic-password',
                '-s',
                this.service,
                '-a',
                this.account,
                '-w',
            ]);
            return out.replace(/\n$/, '');
        } catch {
            return null;
        }
    }

    /** Replace any existing entry. Returns true on success. */
    set(value: string): boolean {
        try {
            // `security add-generic-password -w` reads from /dev/tty rather than
            // stdin. JXA lets us call Keychain Services directly while keeping
            // the secret on stdin and out of argv and temporary files.
            const result = this.runner.runWithStdin('/usr/bin/osascript', [
                '-l',
                'JavaScript',
                '-e',
                SET_PASSWORD_JXA,
                '--',
                this.service,
                this.account,
            ], value);
            return result.status === 0;
        } catch {
            return false;
        }
    }

    /** Best-effort delete; returns true if the entry was removed. */
    delete(): boolean {
        try {
            this.runner.run('security', [
                'delete-generic-password',
                '-s',
                this.service,
                '-a',
                this.account,
            ]);
            return true;
        } catch {
            return false;
        }
    }
}

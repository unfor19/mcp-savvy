/**
 * macOS Keychain backend via Security.framework and JXA.
 *
 * No native dependency: we use the system `osascript` tool that ships
 * with macOS, so `npx mcp-savvy` works without node-gyp.
 */

import { platform } from 'node:os';
import {
    KeychainReadError,
    decodeKeychainCommandResult,
    sanitizeKeychainCommandFailure,
    type KeychainBackend,
    type KeychainBackendOptions,
    type KeychainReadResult,
} from './types.js';
import { nodeRunner, type Runner } from '../runner.js';

const GET_PASSWORD_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');

function run(argv) {
    const secClass = ObjC.castRefToObject($.kSecClass);
    const genericPassword = ObjC.castRefToObject($.kSecClassGenericPassword);
    const attrService = ObjC.castRefToObject($.kSecAttrService);
    const attrAccount = ObjC.castRefToObject($.kSecAttrAccount);
    const returnData = ObjC.castRefToObject($.kSecReturnData);
    const matchLimit = ObjC.castRefToObject($.kSecMatchLimit);
    const matchLimitOne = ObjC.castRefToObject($.kSecMatchLimitOne);
    const trueValue = ObjC.castRefToObject($.kCFBooleanTrue);
    const query = $.NSMutableDictionary.alloc.init;
    query.setObjectForKey(genericPassword, secClass);
    query.setObjectForKey($(argv[0]), attrService);
    query.setObjectForKey($(argv[1]), attrAccount);
    query.setObjectForKey(trueValue, returnData);
    query.setObjectForKey(matchLimitOne, matchLimit);
    const result = Ref();
    const status = $.SecItemCopyMatching(query, result);
    if (status === Number($.errSecItemNotFound)) {
        return JSON.stringify({ status: 'missing' });
    }
    if (status !== Number($.errSecSuccess)) {
        let category = 'operational-failure';
        if (
            status === Number($.errSecAuthFailed) ||
            status === Number($.errSecInteractionNotAllowed) ||
            status === Number($.errSecUserCanceled)
        ) {
            category = 'permission-denied';
        } else if (status === Number($.errSecDecode)) {
            category = 'integrity-failure';
        }
        return JSON.stringify({ status: 'error', category: category });
    }
    const data = ObjC.castRefToObject(result[0]);
    const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    if (!text) return JSON.stringify({ status: 'unreadable-local-entry' });
    return JSON.stringify({ status: 'found', value: ObjC.unwrap(text) });
}
`;

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
    const valueData = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
    const query = $.NSMutableDictionary.alloc.init;
    query.setObjectForKey(genericPassword, secClass);
    query.setObjectForKey($(argv[0]), attrService);
    query.setObjectForKey($(argv[1]), attrAccount);
    const updates = $.NSMutableDictionary.alloc.init;
    updates.setObjectForKey(valueData, valueDataKey);
    let status = $.SecItemUpdate(query, updates);
    if (status === Number($.errSecItemNotFound)) {
        const item = $.NSMutableDictionary.dictionaryWithDictionary(query);
        item.setObjectForKey(valueData, valueDataKey);
        status = $.SecItemAdd(item, $());
    }
    if (status !== Number($.errSecSuccess)) {
        throw new Error('Keychain write failed with status ' + status);
    }
}
`;

const DELETE_PASSWORD_JXA = String.raw`
ObjC.import('Foundation');
ObjC.import('Security');

function run(argv) {
    const secClass = ObjC.castRefToObject($.kSecClass);
    const genericPassword = ObjC.castRefToObject($.kSecClassGenericPassword);
    const attrService = ObjC.castRefToObject($.kSecAttrService);
    const attrAccount = ObjC.castRefToObject($.kSecAttrAccount);
    const query = $.NSMutableDictionary.alloc.init;
    query.setObjectForKey(genericPassword, secClass);
    query.setObjectForKey($(argv[0]), attrService);
    query.setObjectForKey($(argv[1]), attrAccount);
    const status = $.SecItemDelete(query);
    if (status !== Number($.errSecSuccess) && status !== Number($.errSecItemNotFound)) {
        throw new Error('Keychain delete failed with status ' + status);
    }
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

    /** True only on Darwin; Security.framework ships with macOS. */
    isAvailable(): boolean {
        return this.currentPlatform === 'darwin';
    }

    /** Read and classify the local Keychain Services entry. */
    get(): KeychainReadResult {
        try {
            const out = this.runner.run('/usr/bin/osascript', [
                '-l',
                'JavaScript',
                '-e',
                GET_PASSWORD_JXA,
                '--',
                this.service,
                this.account,
            ]);
            return decodeKeychainCommandResult(out.replace(/\n$/, ''));
        } catch (error) {
            if (error instanceof KeychainReadError) throw error;
            throw sanitizeKeychainCommandFailure(error);
        }
    }

    /** Update an existing entry without replacing its access controls. */
    set(value: string): boolean {
        try {
            // JXA lets us call Keychain Services directly while keeping the
            // secret on stdin and out of argv and temporary files.
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

    /**
     * Delete through Keychain Services without reading the secret.
     * An already-absent entry counts as success; any other failure is false.
     */
    delete(): boolean {
        try {
            this.runner.run('/usr/bin/osascript', [
                '-l',
                'JavaScript',
                '-e',
                DELETE_PASSWORD_JXA,
                '--',
                this.service,
                this.account,
            ]);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Windows Credential Manager backend via the `cmdkey` CLI.
 *
 * Note: cmdkey can store credentials but cannot read passwords back.
 * For reads we use PowerShell with the `CredentialManager` module.
 * If the module is missing, reads return null and the caller falls back
 * to the encrypted file. Writes still work.
 */

import { platform } from 'node:os';
import type { KeychainBackend, KeychainBackendOptions } from './types.js';
import { nodeRunner, type Runner } from '../runner.js';

const WRITE_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$d = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class McpSavvyCredentialWriter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
}
'@
$ptr = [Runtime.InteropServices.Marshal]::StringToCoTaskMemUni([string]$d.password)
try {
  $c = New-Object McpSavvyCredentialWriter+CREDENTIAL
  $c.Type = 1; $c.TargetName = [string]$d.target; $c.UserName = [string]$d.username
  $c.CredentialBlobSize = [Text.Encoding]::Unicode.GetByteCount([string]$d.password)
  $c.CredentialBlob = $ptr; $c.Persist = 2
  if (-not [McpSavvyCredentialWriter]::CredWrite([ref]$c, 0)) { throw "CredWriteW failed" }
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($ptr) }
`;

/** Escape arbitrary data for a PowerShell single-quoted string literal. */
function powerShellSingleQuoted(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/** Constructor options for `WindowsCredentialManager`. */
export interface WindowsCredentialManagerOptions extends KeychainBackendOptions {
    /** Override the subprocess runner. Tests pass a fake; prod leaves unset. */
    runner?: Runner;
    /** Override `process.platform`. Tests pass 'win32'; prod leaves unset. */
    platform?: NodeJS.Platform;
}

/** Windows implementation of `KeychainBackend`. */
export class WindowsCredentialManager implements KeychainBackend {
    readonly name = 'Windows Credential Manager';
    private readonly service: string;
    private readonly account: string;
    private readonly runner: Runner;
    private readonly currentPlatform: NodeJS.Platform;

    constructor(opts: WindowsCredentialManagerOptions) {
        this.service = opts.service;
        this.account = opts.account;
        this.runner = opts.runner ?? nodeRunner;
        this.currentPlatform = opts.platform ?? platform();
    }

    /** Available on win32. */
    isAvailable(): boolean {
        return this.currentPlatform === 'win32';
    }

    /**
     * Read the value via PowerShell `CredentialManager` module.
     * Returns null if the module isn't installed or the credential
     * is absent.
     */
    get(): string | null {
        try {
            const serviceLiteral = powerShellSingleQuoted(this.service);
            const script = [
                'Import-Module CredentialManager -ErrorAction Stop;',
                `$c = Get-StoredCredential -Target ${serviceLiteral} -ErrorAction SilentlyContinue;`,
                "if ($c) { $c.GetNetworkCredential().Password }",
            ].join(' ');
            const out = this.runner.run('powershell', ['-NoProfile', '-Command', script]);
            const trimmed = out.trim();
            return trimmed.length > 0 ? trimmed : null;
        } catch {
            return null;
        }
    }

    /** Persist through CredWriteW with all dynamic data supplied over stdin. */
    set(value: string): boolean {
        try {
            const result = this.runner.runWithStdin(
                'powershell',
                ['-NoProfile', '-NonInteractive', '-Command', WRITE_CREDENTIAL_SCRIPT],
                JSON.stringify({ target: this.service, username: this.account, password: value }),
            );
            return result.status === 0;
        } catch {
            return false;
        }
    }

    /** Delete via cmdkey. */
    delete(): boolean {
        try {
            this.runner.run('cmdkey', [`/delete:${this.service}`]);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * Windows Credential Manager backend via the `cmdkey` CLI.
 *
 * Note: cmdkey can store credentials but cannot read passwords back.
 * For reads we use PowerShell with the `CredentialManager` module.
 * The backend is selected only when that module can be loaded, preserving
 * read/write symmetry; otherwise the caller uses encrypted-file storage.
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

/** Probe required for read/write symmetry before selecting this backend. */
const PROBE_CREDENTIAL_MANAGER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Import-Module CredentialManager -ErrorAction Stop
`;

const READ_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Write-Result($value) { $value | ConvertTo-Json -Compress }
try {
  Import-Module CredentialManager -ErrorAction Stop
} catch {
  Write-Result @{ status = 'error'; category = 'invocation-failure' }
  return
}
try {
  $c = Get-StoredCredential -Target $target -ErrorAction Stop
  if ($null -eq $c) {
    Write-Result @{ status = 'missing' }
    return
  }
  try {
    $password = $c.GetNetworkCredential().Password
  } catch [System.Text.DecoderFallbackException] {
    Write-Result @{ status = 'unreadable-local-entry' }
    return
  } catch [System.UnauthorizedAccessException] {
    Write-Result @{ status = 'error'; category = 'permission-denied' }
    return
  } catch [System.Security.Cryptography.CryptographicException] {
    Write-Result @{ status = 'error'; category = 'integrity-failure' }
    return
  } catch {
    Write-Result @{ status = 'error'; category = 'operational-failure' }
    return
  }
  if ($null -eq $password) {
    Write-Result @{ status = 'unreadable-local-entry' }
  } else {
    Write-Result @{ status = 'found'; value = [string]$password }
  }
} catch [System.UnauthorizedAccessException] {
  Write-Result @{ status = 'error'; category = 'permission-denied' }
} catch [System.Security.Cryptography.CryptographicException] {
  Write-Result @{ status = 'error'; category = 'integrity-failure' }
} catch {
  Write-Result @{ status = 'error'; category = 'operational-failure' }
}
`;

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

  /** Available only when PowerShell can load the required reader module. */
  isAvailable(): boolean {
    if (this.currentPlatform !== 'win32') return false;
    try {
      this.runner.run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        PROBE_CREDENTIAL_MANAGER_SCRIPT,
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /** Read and classify the local Credential Manager entry. */
  get(): KeychainReadResult {
    try {
      const target = powerShellSingleQuoted(this.service);
      const script = `$target = ${target}; ${READ_CREDENTIAL_SCRIPT}`;
      const out = this.runner.run('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ]);
      return decodeKeychainCommandResult(out.trim());
    } catch (error) {
      if (error instanceof KeychainReadError) throw error;
      throw sanitizeKeychainCommandFailure(error);
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

<#
.SYNOPSIS
Windows strong write-sandbox launcher (must run with enough privileges).

.DESCRIPTION
This script is invoked by SandboxExecutor when windowsStrongSandboxAvailable()
is true. It creates a restricted, low-integrity primary token from the current
token and launches the requested shell command through CreateProcessAsUser.
Allowed directories are temporarily labeled Low (directory level only), so
files created inside them are writable by the sandboxed process while every
other directory remains write-denied by mandatory integrity policy.

The caller passes the command and allowed dirs through environment variables
(COGSEED_SANDBOX_COMMAND_B64, COGSEED_SANDBOX_ALLOWED_DIRS_JSON,
COGSEED_SANDBOX_SHELL_KIND) so no quoting layer can corrupt them.

The current process must hold SeAssignPrimaryTokenPrivilege and
SeIncreaseQuotaPrivilege (elevated CogSeed or a privileged broker). When they
are missing the script exits 3 with a structured JSON error on stderr and
does NOT touch any directory labels.
#>

param(
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

if ($SelfTest) {
  # Self-test only compiles the embedded C# helper; it must not require the
  # real env payload or an elevated token.
  $env:COGSEED_SANDBOX_COMMAND_B64 = 'ZWNobyBoZWxsbw=='
  $env:COGSEED_SANDBOX_ALLOWED_DIRS_JSON = '[]'
  $env:COGSEED_SANDBOX_SHELL_KIND = 'powershell'
}

function Write-ErrorJson {
  param([int]$Code, [string]$Message)
  [Console]::Error.WriteLine(('{{"ok":false,"code":"{0}","error":{1}}}' -f $Code, ($Message | ConvertTo-Json -Compress)))
}

function Test-RestrictedTokenPrivileges {
  $privOut = (& whoami.exe /priv 2>$null | Out-String)
  if (-not $privOut) { return $false }
  foreach ($name in @('SeAssignPrimaryTokenPrivilege', 'SeIncreaseQuotaPrivilege')) {
    $line = [regex]::Match($privOut, '(?m)^' + [regex]::Escape($name) + '\b[^\r\n]*$').Value
    if (-not $line -or $line -notmatch '\bEnabled\s*$') { return $false }
  }
  return $true
}

function Get-IntegrityRid {
  param([string]$Path)
  try {
    $sddl = (Get-Acl -LiteralPath $Path -ErrorAction Stop).Sddl
    $m = [regex]::Match($sddl, 'S-1-16-(\d+)')
    if ($m.Success) { return [int]$m.Groups[1].Value }
  } catch {
    # Missing ACL / non-NTFS path: return default medium.
  }
  return 0
}

function Set-IntegrityLabel {
  param([string]$Path, [string]$Level)
  if ($Level -eq '') { return }
  & icacls.exe $Path '/setintegritylevel' ('(OI)(CI)' + $Level) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed to set integrity level $Level on $Path" }
}

$commandB64 = $env:COGSEED_SANDBOX_COMMAND_B64
if (-not $commandB64) {
  Write-ErrorJson -Code 10 -Message 'COGSEED_SANDBOX_COMMAND_B64 is not set'
  exit 10
}

$allowedDirs = @()
$allowedRaw = $env:COGSEED_SANDBOX_ALLOWED_DIRS_JSON
if ($allowedRaw) {
  try {
    $allowedDirs = @($allowedRaw | ConvertFrom-Json)
  } catch {
    Write-ErrorJson -Code 11 -Message 'COGSEED_SANDBOX_ALLOWED_DIRS_JSON is not a JSON array'
    exit 11
  }
}

if (-not $SelfTest -and -not (Test-RestrictedTokenPrivileges)) {
  Write-ErrorJson -Code 3 -Message 'Windows strong sandbox unavailable: current process lacks SeAssignPrimaryTokenPrivilege / SeIncreaseQuotaPrivilege. Run CogSeed elevated or use a privileged broker.'
  exit 3
}

$csCode = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class WindowsSandboxLauncher
{
    private const uint TOKEN_QUERY = 0x0008;
    private const uint TOKEN_DUPLICATE = 0x0002;
    private const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
    private const uint TOKEN_ADJUST_DEFAULT = 0x0080;
    private const uint DISABLE_MAX_PRIVILEGE = 0x0001;
    private const int SecurityImpersonation = 2;
    private const int TokenPrimary = 1;
    private const int TokenIntegrityLevel = 25;
    private const int WinLowLabelSid = 16;
    private const uint SE_GROUP_INTEGRITY = 0x00000020;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint STD_INPUT_HANDLE = 0xFFFFFFF6;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_MANDATORY_LABEL
    {
        public SID_AND_ATTRIBUTES Label;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(uint nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, int nNumberOfBytesToRead, out int lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool DuplicateTokenEx(IntPtr hExistingToken, uint dwDesiredAccess, IntPtr lpTokenAttributes, int ImpersonationLevel, int TokenType, out IntPtr phNewToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr ExistingTokenHandle, uint Flags, int DisableSidCount, IntPtr SidsToDisable, int DeletePrivilegeCount, IntPtr PrivilegesToDelete, int RestrictedSidCount, IntPtr SidsToRestrict, out IntPtr NewTokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr TokenHandle, int TokenInformationClass, IntPtr TokenInformation, uint TokenInformationLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateWellKnownSid(int WellKnownSidType, IntPtr DomainSid, IntPtr pSid, ref uint cbSid);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

    private static void Drain(IntPtr handle, Stream target)
    {
        byte[] buffer = new byte[8192];
        int read = 0;
        while (ReadFile(handle, buffer, buffer.Length, out read, IntPtr.Zero) && read > 0)
        {
            target.Write(buffer, 0, read);
        }
        target.Flush();
        CloseHandle(handle);
    }

    public static int Run(string commandLine, out string error)
    {
        error = null;
        IntPtr current = IntPtr.Zero;
        IntPtr duplicate = IntPtr.Zero;
        IntPtr restricted = IntPtr.Zero;
        IntPtr outRead = IntPtr.Zero;
        IntPtr outWrite = IntPtr.Zero;
        IntPtr errRead = IntPtr.Zero;
        IntPtr errWrite = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try
        {
            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, out current))
            {
                error = "OpenProcessToken failed: " + Marshal.GetLastWin32Error();
                return 126;
            }
            if (!DuplicateTokenEx(current, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out duplicate))
            {
                error = "DuplicateTokenEx failed: " + Marshal.GetLastWin32Error();
                return 126;
            }
            if (!CreateRestrictedToken(duplicate, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted))
            {
                error = "CreateRestrictedToken failed: " + Marshal.GetLastWin32Error();
                return 126;
            }

            uint sidLen = 0;
            CreateWellKnownSid(WinLowLabelSid, IntPtr.Zero, IntPtr.Zero, ref sidLen);
            IntPtr sid = Marshal.AllocHGlobal((int)sidLen);
            IntPtr labelPtr = IntPtr.Zero;
            try
            {
                if (!CreateWellKnownSid(WinLowLabelSid, IntPtr.Zero, sid, ref sidLen))
                {
                    error = "CreateWellKnownSid(low) failed: " + Marshal.GetLastWin32Error();
                    return 126;
                }
                TOKEN_MANDATORY_LABEL label = new TOKEN_MANDATORY_LABEL();
                label.Label.Sid = sid;
                label.Label.Attributes = SE_GROUP_INTEGRITY;
                labelPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)));
                Marshal.StructureToPtr(label, labelPtr, false);
                if (!SetTokenInformation(restricted, TokenIntegrityLevel, labelPtr, (uint)Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL))))
                {
                    error = "SetTokenInformation(low integrity) failed: " + Marshal.GetLastWin32Error();
                    return 126;
                }
            }
            finally
            {
                if (labelPtr != IntPtr.Zero) Marshal.FreeHGlobal(labelPtr);
                Marshal.FreeHGlobal(sid);
            }

            SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            sa.bInheritHandle = true;
            if (!CreatePipe(out outRead, out outWrite, ref sa, 0) || !CreatePipe(out errRead, out errWrite, ref sa, 0))
            {
                error = "CreatePipe failed: " + Marshal.GetLastWin32Error();
                return 126;
            }

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.dwFlags = (int)STARTF_USESTDHANDLES;
            si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            si.hStdOutput = outWrite;
            si.hStdError = errWrite;

            bool created = CreateProcessAsUser(
                restricted,
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                IntPtr.Zero,
                null,
                ref si,
                out pi);
            CloseHandle(outWrite);
            CloseHandle(errWrite);
            outWrite = IntPtr.Zero;
            errWrite = IntPtr.Zero;
            if (!created)
            {
                error = "CreateProcessAsUser failed: " + Marshal.GetLastWin32Error();
                return 126;
            }

            ManualResetEvent doneOut = new ManualResetEvent(false);
            ManualResetEvent doneErr = new ManualResetEvent(false);
            ThreadPool.QueueUserWorkItem(delegate { Drain(outRead, Console.OpenStandardOutput()); doneOut.Set(); });
            ThreadPool.QueueUserWorkItem(delegate { Drain(errRead, Console.OpenStandardError()); doneErr.Set(); });
            CloseHandle(outRead);
            CloseHandle(errRead);
            outRead = IntPtr.Zero;
            errRead = IntPtr.Zero;

            WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
            doneOut.WaitOne(5000);
            doneErr.WaitOne(5000);

            uint exitCode = 1;
            if (!GetExitCodeProcess(pi.hProcess, out exitCode)) exitCode = 1;
            return (int)exitCode;
        }
        finally
        {
            if (current != IntPtr.Zero) CloseHandle(current);
            if (duplicate != IntPtr.Zero) CloseHandle(duplicate);
            if (restricted != IntPtr.Zero) CloseHandle(restricted);
            if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
            if (errWrite != IntPtr.Zero) CloseHandle(errWrite);
            if (outRead != IntPtr.Zero) CloseHandle(outRead);
            if (errRead != IntPtr.Zero) CloseHandle(errRead);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
        }
    }
}
'@

if ($SelfTest) {
  Add-Type -TypeDefinition $csCode
  Write-Host 'sandbox launcher C# compile OK'
  exit 0
}

Add-Type -TypeDefinition $csCode

$commandLine = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($commandB64))
$shellKind = $env:COGSEED_SANDBOX_SHELL_KIND
if ($shellKind -eq 'cmd') {
  $commandLine = 'cmd.exe /d /s /c "' + $commandLine + '"'
} elseif ($shellKind -eq 'powershell') {
  $commandLine = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + $commandLine + '"'
} else {
  $commandLine = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + $commandLine + '"'
}

$backupLabels = @()
foreach ($dir in $allowedDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $rid = Get-IntegrityRid -Path $dir
  $backupLabels += [pscustomobject]@{ Dir = $dir; Rid = $rid }
}

$exitCode = 1
try {
  foreach ($entry in $backupLabels) {
    Set-IntegrityLabel -Path $entry.Dir -Level 'Low'
  }
  $errorText = $null
  $exitCode = [WindowsSandboxLauncher]::Run($commandLine, [ref]$errorText)
  if ($errorText) {
    Write-ErrorJson -Code 4 -Message $errorText
    $exitCode = 126
  }
} finally {
  foreach ($entry in $backupLabels) {
    try {
      switch ($entry.Rid) {
        4096 { $level = 'Low' }
        12288 { $level = 'High' }
        16384 { $level = 'System' }
        default { $level = 'Medium' }
      }
      Set-IntegrityLabel -Path $entry.Dir -Level $level
    } catch {
      [Console]::Error.WriteLine(('(sandbox label restore warning) ' + $_.Exception.Message))
    }
  }
}

exit $exitCode

param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^recorder-window-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')]
  [string]$Marker,
  [Parameter(Mandatory = $true)]
  [ValidateSet('read', 'minimize')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class RecorderWindowNative {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool ShowWindowAsync(IntPtr hwnd, int command);

  public static IntPtr[] FindMarker(string marker) {
    var matches = new List<IntPtr>();
    bool ok = EnumWindows((hwnd, data) => {
      int length = GetWindowTextLength(hwnd);
      if (length <= 0 || length >= 4096) return true;
      var title = new StringBuilder(length + 1);
      GetWindowText(hwnd, title, title.Capacity);
      if (title.ToString().IndexOf(marker, StringComparison.Ordinal) >= 0) matches.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    if (!ok) throw new InvalidOperationException("Window discovery failed");
    return matches.ToArray();
  }

}
'@ | Out-Null

  function Get-MarkerWindows {
    foreach ($handle in [RecorderWindowNative]::FindMarker($Marker)) {
      if (-not [RecorderWindowNative]::IsWindow($handle)) { throw 'Window identity changed' }
      [uint32]$windowProcessId = 0
      $threadId = [RecorderWindowNative]::GetWindowThreadProcessId($handle, [ref]$windowProcessId)
      if ($threadId -eq 0 -or $windowProcessId -eq 0) { throw 'Window process unavailable' }
      $windowProcess = Get-Process -Id $windowProcessId -ErrorAction Stop
      if ($windowProcess.HasExited -or $windowProcess.ProcessName -ine 'msedge') { throw 'Window process does not match' }
      [PSCustomObject]@{ Handle = $handle; ProcessId = $windowProcessId }
    }
  }

  function Assert-MarkerWindow($Expected) {
    $current = @(Get-MarkerWindows)
    if ($current.Count -ne 1 -or $current[0].Handle -ne $Expected.Handle -or $current[0].ProcessId -ne $Expected.ProcessId) { throw 'Window binding changed or is ambiguous' }
  }

  $discovery = [Diagnostics.Stopwatch]::StartNew()
  do {
    $matches = @(Get-MarkerWindows)
    if ($matches.Count -gt 1) { throw 'Ambiguous recorder window' }
    if ($matches.Count -eq 1) { break }
    if ($discovery.ElapsedMilliseconds -ge 2000) { throw 'Recorder window not found' }
    Start-Sleep -Milliseconds 50
  } while ($true)
  $owned = $matches[0]
  Assert-MarkerWindow $owned
  if ($Action -eq 'minimize' -and -not [RecorderWindowNative]::IsIconic($owned.Handle)) {
    # SW_SHOWMINNOACTIVE only. Never restore, activate or select any window/tab.
    Assert-MarkerWindow $owned
    if (-not [RecorderWindowNative]::ShowWindowAsync($owned.Handle, 7)) { throw 'Window minimization refused' }
    $verification = [Diagnostics.Stopwatch]::StartNew()
    do {
      Assert-MarkerWindow $owned
      if ([RecorderWindowNative]::IsIconic($owned.Handle)) { break }
      if ($verification.ElapsedMilliseconds -ge 2000) { throw 'Window did not remain minimized' }
      Start-Sleep -Milliseconds 50
    } while ($true)
  }
  Assert-MarkerWindow $owned
  $state = if ([RecorderWindowNative]::IsIconic($owned.Handle)) { 'minimized' } else { 'normal' }
  if ($Action -eq 'minimize' -and $state -ne 'minimized') { throw 'Window did not remain minimized' }
  @{ windowId = $owned.Handle.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture); windowState = $state; backend = 'win32' } | ConvertTo-Json -Compress
} catch {
  # Fixed text only: do not disclose enumerated titles, process details or errors.
  [Console]::Error.WriteLine('Recorder window operation failed')
  $safeExitCode = switch ($_.Exception.Message) {
    'Recorder window not found' { 11 }
    'Ambiguous recorder window' { 12 }
    'Window binding changed or is ambiguous' { 13 }
    'Window process does not match' { 14 }
    'Window minimization refused' { 15 }
    'Window did not remain minimized' { 16 }
    default { 1 }
  }
  exit $safeExitCode
}

param([string]$ConfigPath = 'config\recorder.json')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData = Join-Path $taskRoot 'data\persistent-executor'
foreach ($taskRuntimePath in @((Join-Path $taskRoot 'data'), $taskData)) {
    if (Test-Path -LiteralPath $taskRuntimePath) {
        $taskRuntimeItem = Get-Item -LiteralPath $taskRuntimePath -Force
        if ($taskRuntimeItem.LinkType -or ($taskRuntimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime data directories must not be junctions or symbolic links.' }
        if (-not $taskRuntimeItem.FullName.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime directory resolves outside this project.' }
    }
}
[IO.Directory]::CreateDirectory($taskData) | Out-Null
$taskRuntimeItem = Get-Item -LiteralPath $taskData -Force
if ($taskRuntimeItem.LinkType -or ($taskRuntimeItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $taskRuntimeItem.FullName.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime data directory is not contained in this project.' }
$taskConfig = [IO.Path]::GetFullPath((Join-Path $taskRoot $ConfigPath))
if (-not $taskConfig.StartsWith($taskRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Configuration must remain inside this project.' }
if (-not (Test-Path -LiteralPath $taskConfig)) { throw 'Copy config/recorder.example.json to config/recorder.json and set your bookId first.' }
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
$taskControl = Join-Path $taskData 'control.json'
if (Test-Path -LiteralPath $taskControl) {
    $taskControlItem = Get-Item -LiteralPath $taskControl -Force
    if ($taskControlItem.LinkType -or ($taskControlItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'The runtime control file must not be a symbolic link.' }
    $taskPrevious = Get-Content -LiteralPath $taskControl -Raw | ConvertFrom-Json
    $taskExisting = Get-Process -Id $taskPrevious.pid -ErrorAction SilentlyContinue
    if ($taskExisting) { Write-Host 'Recorder service is already running. Check status instead of starting another writer.'; exit 0 }
}
$taskScript = Join-Path $PSScriptRoot 'run-recorder-service.mjs'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskScript + '"'), ('"--config=' + $taskConfig + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskData 'service.stdout.log') -RedirectStandardError (Join-Path $taskData 'service.stderr.log') -PassThru
Start-Sleep -Milliseconds 700
$taskProcess.Refresh()
if ($taskProcess.HasExited) { throw 'Recorder service failed to start. Inspect its local log; no second writer was started.' }
Write-Host 'Recorder service started. Check with: node scripts/recorder-control.mjs status'

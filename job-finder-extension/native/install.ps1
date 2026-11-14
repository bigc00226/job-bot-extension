# Installs Job Finder Helper for the current Windows user (no administrator rights needed):
# builds JobFinderHelper.exe from JobFinderHelper.cs with the C# compiler that comes with Windows,
# and registers it with Chrome and Edge as the native-messaging host "com.jobfinder.helper".
# Run install.cmd (it asks for Job Finder's ID, shown in Job Finder's Settings and on chrome://extensions).
param([string]$ExtensionId = "")
$ErrorActionPreference = "Stop"
$name = "com.jobfinder.helper"
$dir = Join-Path $env:LOCALAPPDATA "JobFinderHelper"

while ($ExtensionId -notmatch '^[a-p]{32}$') {
  $ExtensionId = (Read-Host "Job Finder's ID (32 letters, from Job Finder > Settings or chrome://extensions)").Trim()
}

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "The .NET Framework 4 C# compiler wasn't found ($csc)." }

New-Item -ItemType Directory -Force $dir | Out-Null
# A running copy (connected to Job Finder) would block the rebuild.
Get-Process JobFinderHelper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
$exe = Join-Path $dir "JobFinderHelper.exe"
& $csc /nologo /target:winexe /optimize+ "/out:$exe" /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $PSScriptRoot "JobFinderHelper.cs")
if ($LASTEXITCODE -ne 0) { throw "Building the helper failed." }

# Keeps IDs registered earlier (e.g. Job Finder loaded in Chrome and in Edge).
$manifestPath = Join-Path $dir "$name.json"
$origins = @("chrome-extension://$ExtensionId/")
if (Test-Path $manifestPath) {
  try { $origins = @((Get-Content $manifestPath -Raw | ConvertFrom-Json).allowed_origins) + $origins | Select-Object -Unique } catch { }
}
$manifest = [ordered]@{
  name = $name
  description = "Job Finder Helper: top-right notifications and the pinned window on every desktop"
  path = $exe
  type = "stdio"
  allowed_origins = @($origins)
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

foreach ($browser in "Google\Chrome", "Microsoft\Edge", "BraveSoftware\Brave-Browser") {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\$name"
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
}
Write-Host ""
Write-Host "Job Finder Helper is installed ($exe)." -ForegroundColor Green
Write-Host "Back in Job Finder: Settings > Desktop helper > Test notification."

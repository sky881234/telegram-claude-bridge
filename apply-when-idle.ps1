$ErrorActionPreference = "Continue"
$deadline = (Get-Date).AddHours(6)
while ((Get-Date) -lt $deadline) {
  $busy = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match 'output-format' })
  if ($busy.Count -eq 0) {
    Start-Sleep -Seconds 15
    $busy = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match 'output-format' })
    if ($busy.Count -eq 0) { break }
  }
  Start-Sleep -Seconds 5
}
$dir = Join-Path $env:USERPROFILE ".claude\channels\telegram"
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -match 'bridge\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir "start-bridge.ps1")
"topic folders applied $(Get-Date -Format o)" | Add-Content (Join-Path $dir "bridge-boot.log")

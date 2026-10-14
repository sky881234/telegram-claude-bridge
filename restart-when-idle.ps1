$ErrorActionPreference = "Continue"
$deadline = (Get-Date).AddHours(6)
while ((Get-Date) -lt $deadline) {
  $busy = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match ' --output-format json ' })
  if ($busy.Count -eq 0) {
    Start-Sleep -Seconds 15
    $busy = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match ' --output-format json ' })
    if ($busy.Count -eq 0) { break }
  }
  Start-Sleep -Seconds 5
}
$dir = Join-Path $env:USERPROFILE ".claude\channels\telegram"
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -match 'bridge\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1
Start-Process -FilePath (Join-Path $env:USERPROFILE ".bun\bin\bun.exe") -ArgumentList "`"$dir\bridge.mjs`"" -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput "$dir\bridge.log" -RedirectStandardError "$dir\bridge.err.log"
"restarted $(Get-Date -Format o)" | Set-Content "$dir\bridge-restart.log"

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".claude\channels\telegram"
$bun = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
$bootLog = Join-Path $dir "bridge-boot.log"
$mutex = New-Object System.Threading.Mutex($false, "Local\TelegramClaudeBridge")

function Write-Boot([string]$msg) {
  "$(Get-Date -Format o) $msg" | Add-Content -Path $bootLog
}

if (-not $mutex.WaitOne(0)) {
  Write-Boot "another start is in progress"
  exit 0
}

try {
  $existing = @(Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object { $_.CommandLine -match 'bridge\.mjs' })
  if ($existing.Count -gt 0) {
    Write-Boot "already running pid $($existing.ProcessId -join ',')"
    exit 0
  }
  if (-not (Test-Path $bun)) {
    Write-Boot "bun missing at $bun"
    exit 1
  }
  Start-Process -FilePath $bun -ArgumentList "`"$dir\bridge.mjs`"" -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput "$dir\bridge.log" -RedirectStandardError "$dir\bridge.err.log"
  Write-Boot "started"
} finally {
  $mutex.ReleaseMutex() | Out-Null
  $mutex.Dispose()
}

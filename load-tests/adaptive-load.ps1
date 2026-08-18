# Adaptive load test - ramps while the API stays healthy.
#
# Profiles:
#   Local     - laptop dev (default): 5 users/sec, max 200
#   Staging   - cloud staging: 500 users/sec, max 10_000
#   Production - design target: 100_000 users/sec (distributed Locust only!)
#
# Usage:
#   .\load-tests\adaptive-load.ps1
#   .\load-tests\adaptive-load.ps1 -Profile Staging -HostUrl https://api.example.com
#   .\load-tests\adaptive-load.ps1 -Profile Production -HostUrl https://api.example.com

param(
    [ValidateSet("Local", "Staging", "Production")]
    [string]$Profile = "Local",
    [string]$HostUrl = "http://127.0.0.1:8000",
    [int]$StartUsers = 0,
    [int]$MaxUsers = 0,
    [int]$SpawnRate = 0,
    [int]$MaxP95Ms = 500,
    [double]$MaxFailRatio = 0.02,
    [int]$MaxRuntimeSec = 3600,
    [string]$WsHost = "ws://127.0.0.1:8080",
    [int]$RegisterTimeoutSec = 30
)

$profiles = @{
    Local = @{
        StartUsers = 10
        MaxUsers   = 200
        SpawnRate  = 5
        MaxP95Ms   = 500
    }
    Staging = @{
        StartUsers = 50
        MaxUsers   = 10000
        SpawnRate  = 500
        MaxP95Ms   = 300
    }
    Production = @{
        StartUsers = 1000
        MaxUsers   = 100000
        SpawnRate  = 100000
        MaxP95Ms   = 200
    }
}

$p = $profiles[$Profile]
if ($StartUsers -eq 0) { $StartUsers = $p.StartUsers }
if ($MaxUsers -eq 0) { $MaxUsers = $p.MaxUsers }
if ($SpawnRate -eq 0) { $SpawnRate = $p.SpawnRate }
if ($Profile -ne "Local" -and $MaxP95Ms -eq 500) { $MaxP95Ms = $p.MaxP95Ms }

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$locust = Join-Path $root ".venv\Scripts\locust.exe"
$backend = Join-Path $root "backend"
$failPercent = [math]::Round($MaxFailRatio * 100, 2)

Write-Host "Adaptive load test [$Profile profile]"
Write-Host "  API:        $HostUrl"
Write-Host "  Start:      $StartUsers users"
Write-Host "  Max:        $MaxUsers users"
Write-Host "  Spawn rate: $SpawnRate users/sec (while healthy)"
Write-Host "  Stop ramp:  p95 > ${MaxP95Ms}ms or failures > ${failPercent}% (excludes /v1/register)"
Write-Host "  WS:         $WsHost"
Write-Host ""

if ($Profile -eq "Production") {
    Write-Host "WARNING: 100,000 users/sec requires DISTRIBUTED Locust workers on cloud VMs." -ForegroundColor Yellow
    Write-Host "         Do not run Production profile against localhost." -ForegroundColor Yellow
    Write-Host "         See load-tests/scale-targets.md" -ForegroundColor Yellow
    Write-Host ""
    if ($HostUrl -match "127\.0\.0\.1|localhost") {
        Write-Host "ERROR: Production profile cannot target localhost." -ForegroundColor Red
        exit 1
    }
}

if ($Profile -eq "Local" -and $SpawnRate -gt 50) {
    Write-Host "WARNING: Spawn rate > 50/sec will likely crash a local dev server." -ForegroundColor Yellow
    Write-Host ""
}

try {
    $health = Invoke-RestMethod -Uri "$HostUrl/v1/health" -TimeoutSec 5
    if (-not $health.ok) { throw "API reported not ok" }
    Write-Host "API OK"
}
catch {
    Write-Host "ERROR: API not reachable at $HostUrl. Start uvicorn first." -ForegroundColor Red
    exit 1
}

$env:LOAD_START_USERS = "$StartUsers"
$env:LOAD_MAX_USERS = "$MaxUsers"
$env:LOAD_SPAWN_RATE = "$SpawnRate"
$env:LOAD_MAX_P95_MS = "$MaxP95Ms"
$env:LOAD_MAX_FAIL_RATIO = "$MaxFailRatio"
$env:LOAD_MAX_RUNTIME_SEC = "$MaxRuntimeSec"
$env:WS_HOST = $WsHost
$env:LOAD_REGISTER_TIMEOUT = "$RegisterTimeoutSec"

Push-Location $backend
try {
    & $locust -f locustfile.py --host $HostUrl --headless
}
finally {
    Pop-Location
}

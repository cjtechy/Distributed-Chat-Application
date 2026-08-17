# Adaptive load test - ramps up to 100k users while the API stays healthy.
#
# Prerequisites:
#   1. API running: uvicorn app.main:app --host 127.0.0.1 --port 8000
#   2. pip install -r backend\requirements-dev.txt
#
# Usage:
#   .\load-tests\adaptive-load.ps1
#   .\load-tests\adaptive-load.ps1 -SpawnRate 200 -MaxP95Ms 300

param(
    [string]$HostUrl = "http://127.0.0.1:8000",
    [int]$StartUsers = 10,
    [int]$MaxUsers = 100000,
    [int]$SpawnRate = 100,
    [int]$MaxP95Ms = 500,
    [double]$MaxFailRatio = 0.02,
    [int]$MaxRuntimeSec = 3600
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$locust = Join-Path $root ".venv\Scripts\locust.exe"
$backend = Join-Path $root "backend"
$failPercent = [math]::Round($MaxFailRatio * 100, 2)

Write-Host "Adaptive load test"
Write-Host "  API:        $HostUrl"
Write-Host "  Start:      $StartUsers users"
Write-Host "  Max:        $MaxUsers users"
Write-Host "  Spawn rate: $SpawnRate users/sec (while healthy)"
Write-Host "  Stop ramp:  p95 > ${MaxP95Ms}ms or failures > ${failPercent}%"
Write-Host ""

try {
    $status = Invoke-RestMethod -Uri "$HostUrl/v1/status" -TimeoutSec 5
    $pg = $status.postgres.connected
    $rd = $status.redis.connected
    Write-Host "API OK - postgres=$pg redis=$rd"
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

Push-Location $backend
try {
    & $locust -f locustfile.py --host $HostUrl --headless
}
finally {
    Pop-Location
}

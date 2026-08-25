# WebSocket load test - targets N concurrent WS connections (default 2000).
# Pre-seeds users + JWT tokens once, then ramps WS-only (no HTTP auth during ramp).
#
# Usage:
#   .\test\ws-load.ps1
#   .\test\ws-load.ps1 -WsConnections 500 -SpawnRate 10
#   .\test\ws-load.ps1 -SkipSeed

param(
    [string]$HostUrl = "http://127.0.0.1:8000",
    [string]$WsHost = "ws://127.0.0.1:8080",
    [int]$WsConnections = 1000,
    [int]$StartUsers = 50,
    [int]$SpawnRate = 100,
    [int]$MaxP95Ms = 2000,
    [double]$MaxFailRatio = 0.02,
    [int]$MaxRuntimeSec = 3600,
    [string]$UserPrefix = "load_ws",
    [string]$Password = "loadpass123",
    [int]$SeedWorkers = 8,
    [switch]$SkipSeed
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root ".venv\Scripts\python.exe"
$locust = Join-Path $root ".venv\Scripts\locust.exe"
$testDir = Join-Path $root "test"
$tokenFile = Join-Path $PSScriptRoot ".load-tokens.json"
$failPercent = [math]::Round($MaxFailRatio * 100, 2)

Write-Host "WebSocket load test"
Write-Host "  API:            $HostUrl"
Write-Host "  WS:             $WsHost"
Write-Host "  Connections:    $WsConnections"
Write-Host "  Spawn rate:     $SpawnRate users/sec"
Write-Host "  Auth:           pre-minted JWT tokens (no login during ramp)"
Write-Host "  Stop ramp:      p95 > ${MaxP95Ms}ms or failures > ${failPercent}%"
Write-Host ""

try {
    $health = Invoke-RestMethod -Uri "$HostUrl/v1/health" -TimeoutSec 5
    if (-not $health.ok) { throw "API reported not ok" }
    Write-Host "API OK"
}
catch {
    Write-Host "ERROR: API not reachable at $HostUrl. Start uvicorn first." -ForegroundColor Red
    exit 1
}

if (-not $SkipSeed) {
    Write-Host ""
    Write-Host "Seeding $WsConnections users + tokens (set BCRYPT_ROUNDS=4 in backend/.env to speed this up) ..."
    & $python (Join-Path $testDir "seed_load_users.py") `
        --host $HostUrl `
        --count $WsConnections `
        --prefix $UserPrefix `
        --password $Password `
        --workers $SeedWorkers `
        --tokens-out $tokenFile
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: User seeding failed." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
}
elseif (-not (Test-Path $tokenFile)) {
    Write-Host "ERROR: -SkipSeed set but token file missing: $tokenFile" -ForegroundColor Red
    exit 1
}

$env:LOAD_WS_ONLY = "1"
$env:LOAD_AUTH_MODE = "token"
$env:LOAD_TOKEN_FILE = $tokenFile
$env:LOAD_USER_PREFIX = $UserPrefix
$env:LOAD_USER_COUNT = "$WsConnections"
$env:LOAD_PASSWORD = $Password
$env:LOAD_START_USERS = "$StartUsers"
$env:LOAD_MAX_USERS = "$WsConnections"
$env:LOAD_SPAWN_RATE = "$SpawnRate"
$env:LOAD_MAX_P95_MS = "$MaxP95Ms"
$env:LOAD_MAX_FAIL_RATIO = "$MaxFailRatio"
$env:LOAD_MAX_RUNTIME_SEC = "$MaxRuntimeSec"
$env:WS_HOST = $WsHost

Push-Location $testDir
try {
    & $locust -f locustfile.py --host $HostUrl --headless
}
finally {
    Pop-Location
}

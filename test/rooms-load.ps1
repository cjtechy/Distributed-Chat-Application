# Groups + DM load test (locustfile_rooms.py). Not everyone in Community.
#
#   python test\seed_load_users.py --count 400 --tokens-out test\.load-tokens.json
#   .\test\rooms-load.ps1
#   .\test\rooms-load.ps1 -Mode groups -Users 400 -GroupCount 20
#   .\test\rooms-load.ps1 -Mode direct -Users 200

param(
    [ValidateSet("groups", "direct", "mixed")]
    [string]$Mode = "mixed",
    [int]$Users = 400,
    [int]$SpawnRate = 10,
    [string]$Time = "120s",
    [int]$GroupCount = 20,
    [string]$HostUrl = "http://127.0.0.1:8000",
    [string]$WsHost = "ws://127.0.0.1:8080",
    [string]$TokenFile = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$locust = Join-Path $root ".venv\Scripts\locust.exe"
$testDir = Join-Path $root "test"
if (-not $TokenFile) {
    $TokenFile = Join-Path $PSScriptRoot ".load-tokens.json"
}

Write-Host "Rooms load test [$Mode]"
Write-Host "  users:  $Users at $SpawnRate/sec for $Time"
Write-Host "  groups: $GroupCount"
Write-Host "  tokens: $TokenFile"
Write-Host ""

$env:WS_HOST = $WsHost
$env:LOAD_AUTH_MODE = "token"
$env:LOAD_TOKEN_FILE = $TokenFile
$env:LOAD_ROOM_MODE = $Mode
$env:LOAD_GROUP_COUNT = "$GroupCount"

Push-Location $testDir
try {
    & $locust -f locustfile_rooms.py --host $HostUrl --headless -u $Users -r $SpawnRate -t $Time
}
finally {
    Pop-Location
}

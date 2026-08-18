# Quick HTTP smoke benchmark using hey (optional).
# Install hey: go install github.com/rakyll/hey@latest
#
# Usage:
#   .\load-tests\http-smoke.ps1
#   .\load-tests\http-smoke.ps1 -BaseUrl http://127.0.0.1:8000 -Concurrency 100

param(
    [string]$BaseUrl = "http://127.0.0.1:8000",
    [int]$Concurrency = 50,
    [int]$Requests = 2000
)

Write-Host "==> GET /v1/health ($Requests requests, $Concurrency concurrent)"
hey -n $Requests -c $Concurrency "$BaseUrl/v1/health"

Write-Host "`n==> Register + GET /v1/messages"
$suffix = Get-Random -Maximum 99999999
$username = "smoke_$suffix"
$registerBody = @{ username = $username; password = "loadpass123" } | ConvertTo-Json
$register = Invoke-RestMethod -Method POST -Uri "$BaseUrl/v1/register" -ContentType "application/json" -Body $registerBody
$token = $register.access_token

hey -n 1000 -c $Concurrency -H "Authorization: Bearer $token" "$BaseUrl/v1/messages"

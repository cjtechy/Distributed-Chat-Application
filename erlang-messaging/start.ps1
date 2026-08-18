# Load Redis/JWT settings from backend/.env, then start the OTP messaging node.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root "backend\.env"

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $parts = $line.Split("=", 2)
        if ($parts.Count -ne 2) { return }
        $name = $parts[0].Trim()
        $value = $parts[1].Trim()
        Set-Item -Path "Env:$name" -Value $value
    }
}

if (-not $env:ERLANG_WS_PORT) { $env:ERLANG_WS_PORT = "8080" }

Set-Location $PSScriptRoot
Write-Host "Erlang messaging on ws://127.0.0.1:$($env:ERLANG_WS_PORT)/v1/ws"
rebar3 shell

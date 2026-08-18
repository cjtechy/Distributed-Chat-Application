# Start the OTP messaging node. Configuration is read from backend/.env by Erlang.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root "backend\.env"
$toolsDir = Join-Path $PSScriptRoot ".tools"

if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: backend/.env not found. Copy backend/.env.example to backend/.env first." -ForegroundColor Red
    exit 1
}

function Find-ErlangBin {
    $erlCmd = Get-Command erl -ErrorAction SilentlyContinue
    if ($erlCmd) {
        return Split-Path $erlCmd.Source -Parent
    }

    if ($env:ERLANG_HOME -and (Test-Path (Join-Path $env:ERLANG_HOME "bin\erl.exe"))) {
        return Join-Path $env:ERLANG_HOME "bin"
    }

    $candidates = @(
        "$env:ProgramFiles\Erlang OTP\bin",
        "${env:ProgramFiles(x86)}\Erlang OTP\bin"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path (Join-Path $candidate "erl.exe")) {
            return $candidate
        }
    }

    return $null
}

function Ensure-Rebar3 {
    param([string]$ErlangBin)

    $rebarCmd = Get-Command rebar3 -ErrorAction SilentlyContinue
    if ($rebarCmd) {
        return $rebarCmd.Source
    }

    $localRebar = Join-Path $toolsDir "rebar3"
    $localCmd = Join-Path $toolsDir "rebar3.cmd"
    $escriptExe = Join-Path $ErlangBin "escript.exe"

    if (-not (Test-Path $localCmd) -or -not (Test-Path $localRebar)) {
        New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
        Write-Host "Downloading rebar3 to $toolsDir ..."
        Invoke-WebRequest -Uri "https://github.com/erlang/rebar3/releases/latest/download/rebar3" -OutFile $localRebar
        @"
@echo off
"$escriptExe" "%~dp0rebar3" %*
"@ | Set-Content $localCmd -Encoding ASCII
    }

    return $localCmd
}

function Read-DotEnvValue {
    param([string]$Path, [string]$Key)
    foreach ($line in Get-Content $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq "" -or $trimmed.StartsWith("#")) { continue }
        $parts = $trimmed.Split("=", 2)
        if ($parts.Count -eq 2 -and $parts[0].Trim() -eq $Key) {
            return $parts[1].Trim()
        }
    }
    return $null
}

$erlangBin = Find-ErlangBin
if (-not $erlangBin) {
    Write-Host ""
    Write-Host "ERROR: Erlang/OTP is not installed (erl.exe not found)." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install Erlang, then run this script again:" -ForegroundColor Yellow
    Write-Host "  1. Download: https://www.erlang.org/downloads"
    Write-Host "  2. Or run:   winget install Erlang.Erlang"
    Write-Host "  3. Close and reopen PowerShell after install"
    Write-Host ""
    exit 1
}

$env:PATH = "$erlangBin;$env:PATH"
$env:DOTENV_PATH = ($envFile -replace '\\', '/')

$rebar3Path = Ensure-Rebar3 -ErlangBin $erlangBin
$wsPort = Read-DotEnvValue -Path $envFile -Key "ERLANG_WS_PORT"
if (-not $wsPort) { $wsPort = "8080" }

Set-Location $PSScriptRoot
Write-Host "Erlang:  $erlangBin"
Write-Host "Config:  $envFile"
Write-Host "WebSocket: ws://127.0.0.1:$wsPort/v1/ws"
Write-Host ""
Write-Host "Compiling..."
& $rebar3Path compile
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: rebar3 compile failed." -ForegroundColor Red
    exit 1
}
Write-Host "Starting Erlang shell (look for 'Loaded N environment variables', then open chat)..."
Write-Host ""

& $rebar3Path shell

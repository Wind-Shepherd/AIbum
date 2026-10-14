param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'
$projectPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $projectPython)) {
    throw 'Missing .venv. Follow README.md to install Python 3.12 and dependencies.'
}

$alreadyListening = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
if ($alreadyListening) {
    try {
        $page = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 3
        if ($page.Content -match '<title>AIbum · (智慧|拾光)相册</title>') {
            Write-Host "AIbum is already running at http://127.0.0.1:$Port/"
            return
        }
    } catch {
        # Report the port conflict below.
    }
    throw "Port $Port is already in use by another application. Start AIbum on another port with: .\start.ps1 -Port 8001"
}

Push-Location $PSScriptRoot
try {
    & $projectPython -m uvicorn app.main:app --host 127.0.0.1 --port $Port
} finally {
    Pop-Location
}

param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$readerUrl = 'http://127.0.0.1:4173/'
$entryPath = Join-Path $projectRoot 'dist\index.html'
$lock = New-Object System.Threading.Mutex($false, 'Local\EpubWorkspaceReader4173')
$ownsLock = $false

function Test-ReaderReady {
    try {
        $response = Invoke-WebRequest -Uri $readerUrl -UseBasicParsing -TimeoutSec 2
        $expected = [System.IO.File]::ReadAllText($entryPath)
        # Windows PowerShell 5 may decode HTML as Latin-1; the build is UTF-8.
        $actual = [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
        return $response.StatusCode -eq 200 -and $actual.Trim() -eq $expected.Trim()
    } catch {
        return $false
    }
}

try {
    try { $ownsLock = $lock.WaitOne(30000) }
    catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
    if (-not $ownsLock) { throw 'Another launch is still in progress. Please try again shortly.' }

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $vitePath = Join-Path $projectRoot 'node_modules\vite\bin\vite.js'
    if (-not (Test-Path -LiteralPath $vitePath)) {
        throw 'Dependencies are missing. Run npm ci in the project folder, then try again.'
    }
    if (-not (Test-Path -LiteralPath $entryPath)) {
        Push-Location $projectRoot
        try {
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'The build failed. See the output above.' }
        } finally { Pop-Location }
    }

    if (-not (Test-ReaderReady)) {
        $listener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
        if ($listener) {
            throw 'Port 4173 is occupied or the reader is not responding. No process was stopped. Please inspect the existing service.'
        }
        $logDirectory = Join-Path $projectRoot '.cache'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $outLog = Join-Path $logDirectory 'reader.out.log'
        $errLog = Join-Path $logDirectory 'reader.err.log'
        $server = Start-Process -FilePath $nodePath `
            -ArgumentList @("`"$vitePath`"", 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort') `
            -WorkingDirectory $projectRoot -WindowStyle Hidden `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (Test-ReaderReady) { $ready = $true; break }
            if ($server.HasExited) { break }
            Start-Sleep -Milliseconds 300
        }
        if (-not $ready) {
            throw "The reader did not start. Check $errLog and $outLog."
        }
        Write-Host "Reader started at $readerUrl"
    } else {
        Write-Host "Reader is already running at $readerUrl"
    }
    if (-not $NoBrowser) { Start-Process $readerUrl }
} catch {
    Write-Host "Unable to open reader: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($ownsLock) { $lock.ReleaseMutex() }
    $lock.Dispose()
}

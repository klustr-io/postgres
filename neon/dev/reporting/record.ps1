# Windows Docker Desktop companion to record.py; never prints credential values.
param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$Program,
    [Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments
)
$ErrorActionPreference = 'Stop'
$reports = Join-Path $PSScriptRoot '../../tests/reports/local'
New-Item -ItemType Directory -Force -Path $reports | Out-Null
$started = [DateTime]::UtcNow
$stem = $started.ToString('yyyyMMddTHHmmssfffffffZ') + '-' + $Name
$logfile = Join-Path $reports ($stem + '.log')
$watch = [Diagnostics.Stopwatch]::StartNew()
$ErrorActionPreference = 'Continue'
& $Program @Arguments > $logfile 2>&1
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$watch.Stop()
$record = [ordered]@{
    name = $Name; command = @($Program) + $Arguments; cwd = (Get-Location).Path
    started_at = $started.ToString('o'); completed_at = [DateTime]::UtcNow.ToString('o')
    duration_seconds = [Math]::Round($watch.Elapsed.TotalSeconds, 3)
    exit_code = $code; status = $(if ($code -eq 0) {'PASS'} else {'FAIL'})
    log = $stem + '.log'
}
$record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $reports ($stem + '.json'))
$record | ConvertTo-Json -Compress -Depth 5
if ($code -ne 0) { Get-Content $logfile -Tail 100 }
exit $code

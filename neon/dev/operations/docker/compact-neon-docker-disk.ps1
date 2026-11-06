param([switch]$Execute)
$ErrorActionPreference='Stop'
$planPath=Join-Path $PSScriptRoot '../../../tests/reports/local/neon-docker-compaction-plan.json'
$plan=Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if (!$Execute) {$plan | Select-Object status,disk,operations | ConvertTo-Json -Depth 5; exit 0}
# Invoke -Execute only after explicit approval for the unrelated-container outage.
$target=[IO.Path]::GetFullPath($plan.disk)
if($target -ne 'C:\Users\rize\AppData\Local\Docker\wsl\disk\docker_data.vhdx'){throw 'Unexpected VHD target'}
if(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -match 'dev[\\/](?:[a-z-]+[\\/])*(build-neon-commit-guard|qualify-neon-native-guard|benchmark-neon-async-ack)\.mjs'}){throw 'Finish the candidate build and qualification first'}
$record=[ordered]@{status='RUNNING';started_at=[DateTime]::UtcNow.ToString('o');disk=$target;data_deleted=$false;containers_before=@($plan.containers.id);authorization='User explicitly allowed the maintenance interruption on 2026-10-31 (Asia/Tokyo)'}
$resultPath=Join-Path $PSScriptRoot '../../../tests/reports/local/neon-docker-compaction-result.json'
if(Test-Path -LiteralPath $resultPath){
  $retained=Join-Path $PSScriptRoot ('../../../tests/reports/local/'+[DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')+'-previous-neon-docker-compaction-result.json')
  Copy-Item -LiteralPath $resultPath -Destination $retained
}
$record.before_c_free_bytes=(Get-PSDrive C).Free
$wasStopped=$false
try {
  $running=@(& docker ps --no-trunc -q);if($LASTEXITCODE -ne 0){throw 'Docker inventory failed'}
  if(@($running | Where-Object {$plan.containers.id -notcontains $_}).Count -gt 0){throw 'Regenerate inventory for newly running workloads'}
  $wasStopped=$true
  Write-Output 'Gracefully stopping the recorded workloads'
  if($running.Count -gt 0){& docker stop --timeout 120 @running;if($LASTEXITCODE -ne 0){throw 'Graceful container stop failed'}}
  & docker desktop stop --timeout 180;if($LASTEXITCODE -ne 0){throw 'Docker Desktop stop failed'}
  $vhd=Get-VHD -Path $target
  if($vhd.Attached){& wsl --terminate docker-desktop;$vhd=Get-VHD -Path $target}
  if($vhd.Attached){throw 'Disk is still attached; refusing compaction'}
  $record.before_file_bytes=(Get-Item -LiteralPath $target).Length
  Write-Output 'Docker disk detached; compacting freed blocks'
  Optimize-VHD -Path $target -Mode Quick -ErrorAction Stop
  if((Get-PSDrive C).Free -lt 12GB){Optimize-VHD -Path $target -Mode Full -ErrorAction Stop}
  $record.after_file_bytes=(Get-Item -LiteralPath $target).Length
  $record.status='COMPACTED'
  Write-Output 'Compaction finished; restoring Docker and recorded workloads'
} catch {
  $record.status='MAINTENANCE-FAILED';$record.error=$_.Exception.Message
  throw
} finally {
  if($wasStopped){& docker desktop start --timeout 180}
  $deadline=[DateTime]::UtcNow.AddMinutes(3)
  do {& docker info --format '{{.ID}}' 2>$null;if($LASTEXITCODE -eq 0){break};Start-Sleep -Seconds 2} while([DateTime]::UtcNow -lt $deadline)
  if($LASTEXITCODE -ne 0){
    $record.restoration_status='DOCKER-NOT-AVAILABLE';$record.completed_at=[DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    throw 'Docker did not return; retain the plan for recovery'
  }
  $restoreErrors=New-Object 'System.Collections.Generic.List[string]'
  $artifactRoot='D:\code-artifacts\postgres-neon-qualification-20261030'
  $retainedDirectories=@('builder-vhds','benchmark-vhds','benchmark-volumes') | ForEach-Object {Join-Path $artifactRoot $_}
  $retainedDirectories+= 'C:\code-artifacts\neon-qualified-benchmarks\benchmark-vhds'
  foreach($directory in $retainedDirectories) {
    if(Test-Path -LiteralPath $directory){foreach($meta in Get-ChildItem -LiteralPath $directory -Filter '*.json') {
      & node (Join-Path $PSScriptRoot 'reattach-neon-benchmark-volume.mjs') $meta.FullName
      if($LASTEXITCODE -ne 0){$restoreErrors.Add("Retained filesystem reattachment failed: $($meta.Name)")}
    }}
  }
  foreach($container in $plan.containers){& docker start $container.id;if($LASTEXITCODE -ne 0){$restoreErrors.Add("Container restore failed: $($container.name)")}}
  $record.completed_at=[DateTime]::UtcNow.ToString('o');$record.c_free_bytes=(Get-PSDrive C).Free
  $record.restoration_errors=@($restoreErrors)
  if($restoreErrors.Count -eq 0){$record.restoration_status='ALL-STARTED'}else{$record.restoration_status='INCOMPLETE'}
  $record | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $resultPath -Encoding UTF8
  if($restoreErrors.Count -gt 0){throw 'Some services need recovery; every recorded container was attempted; inspect the result JSON'}
}

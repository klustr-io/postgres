$ErrorActionPreference = 'Stop'
$taskWorkspace = [IO.Path]::GetFullPath((Get-Location).Path)
if ($taskWorkspace -ne 'C:\code\CORE\postgres') { throw 'Run from the verified qualification workspace' }
$taskSource = [IO.Path]::GetFullPath((Join-Path $taskWorkspace 'build'))
$taskArtifactRoot = [IO.Path]::GetFullPath('D:\code-artifacts\postgres-neon-qualification-20261030')
$taskDestination = [IO.Path]::GetFullPath((Join-Path $taskArtifactRoot 'build'))
if ($taskSource -ne 'C:\code\CORE\postgres\build' -or $taskDestination -ne 'D:\code-artifacts\postgres-neon-qualification-20261030\build') {
    throw 'Resolved artifact move paths do not match the explicitly named directories'
}
if (Test-Path -LiteralPath $taskArtifactRoot) { throw 'Destination already exists; preserve it and inspect before resuming' }
if ((Get-Item -LiteralPath $taskSource).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Build source is already redirected' }
if (Get-ChildItem -LiteralPath $taskSource -Recurse -Force -Attributes ReparsePoint) { throw 'Unexpected nested reparse point' }
$taskDatabaseFiles = & rg --files --hidden --no-ignore $taskSource -g PG_VERSION -g postmaster.pid -g pg_control
if ($LASTEXITCODE -gt 1 -or $taskDatabaseFiles) { throw 'Database files or an unreadable source were found; refusing to move' }
New-Item -ItemType Directory -Path $taskArtifactRoot | Out-Null
# Keep generated secret inputs private when crossing volume boundaries.
$taskIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$taskSecurity = [Security.AccessControl.DirectorySecurity]::new()
$taskSecurity.SetAccessRuleProtection($true, $false)
foreach ($taskSid in @($taskIdentity, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
    $taskRule = [Security.AccessControl.FileSystemAccessRule]::new($taskSid,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $taskSecurity.AddAccessRule($taskRule)
}
Set-Acl -LiteralPath $taskArtifactRoot -AclObject $taskSecurity
# Only the checked, database-free generated build tree is moved. No Docker
# volume/image command is used, and no user checkout files are selected.
& robocopy.exe $taskSource $taskDestination /E /MOVE /COPY:DAT /DCOPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
$taskCopyExit = $LASTEXITCODE
if ($taskCopyExit -ge 8) { throw "Artifact move incomplete ($taskCopyExit); both directory trees are retained for recovery" }
if (Test-Path -LiteralPath $taskSource) {
    if (Get-ChildItem -LiteralPath $taskSource -Force) { throw 'Source is not empty; refusing to replace it' }
    Remove-Item -LiteralPath $taskSource -Force
}
New-Item -ItemType Junction -Path $taskSource -Target $taskDestination | Out-Null
$taskRecord = @{status='PASS'; source_path=$taskSource; artifact_path=$taskDestination;
    compatibility='Original build path retained through a directory junction'; database_files_moved=$false;
    docker_volumes_moved=$false; robocopy_exit_code=$taskCopyExit; generated_at=(Get-Date).ToUniversalTime().ToString('o')}
[IO.File]::WriteAllText((Join-Path $taskWorkspace 'tests/reports/local/neon-build-artifact-storage.json'),
    ($taskRecord | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
Write-Output 'PASS generated build artifacts moved to D:; original paths preserved; database volumes untouched'

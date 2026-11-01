param([Parameter(Mandatory=$true)][string]$VhdPath,[switch]$InspectOnly,[switch]$AllowSystemDrive)
$ErrorActionPreference='Stop'
$resolved=[IO.Path]::GetFullPath($VhdPath)
$scratchSystemDrive = $AllowSystemDrive -and $resolved -match '^C:\\code-artifacts\\neon-qualified-benchmarks\\benchmark-vhds\\'
if (($resolved -notmatch '^[D-Z]:\\' -and -not $scratchSystemDrive) -or [IO.Path]::GetFileName($resolved) -notmatch '^neon-pg18-benchmark-[a-f0-9]{8}-data\.vhdx$') {throw 'Invalid new benchmark VHD path'}
if ($InspectOnly) {$disk=Get-VHD -Path $resolved -ErrorAction Stop}
else {
  if (Test-Path -LiteralPath $resolved) {throw 'Refuse to overwrite an existing VHD'}
  $disk=New-VHD -Path $resolved -Dynamic -SizeBytes 64GB -BlockSizeBytes 2MB -ErrorAction Stop
}
$disk | Select-Object Path,Size,DiskIdentifier,VhdFormat,VhdType | ConvertTo-Json -Compress

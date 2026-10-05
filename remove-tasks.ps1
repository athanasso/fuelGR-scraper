#Requires -Version 5.1
<#
.SYNOPSIS
  Unregisters FuelGR Windows Scheduled Tasks.

.USAGE
  .\remove-tasks.ps1
#>

$ErrorActionPreference = 'SilentlyContinue'

$tasks = @("FuelGR-DailyScraper", "FuelGR-EVHourly")

Write-Host "=== Removing FuelGR Scheduled Tasks ===" -ForegroundColor Cyan

foreach ($task in $tasks) {
  $existing = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    Write-Host "  [OK] Removed task: $task" -ForegroundColor Green
  } else {
    Write-Host "  [-] Task not found: $task (already removed)" -ForegroundColor Yellow
  }
}

Write-Host "`nDone." -ForegroundColor Green

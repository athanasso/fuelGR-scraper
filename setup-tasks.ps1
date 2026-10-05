#Requires -Version 5.1
<#
.SYNOPSIS
  Registers automated Windows Scheduled Tasks for FuelGR Scraper & Release Publisher.

.DESCRIPTION
  Creates two automated background tasks running under your Windows user account:
  1. FuelGR-DailyScraper
     - Fuel prices + Prefectures + EV Chargers + Packaging + GitHub Release
     - Schedule: Twice daily at 08:00 and 16:00 Greek time (EEST)
       (Captures morning station price submissions and afternoon adjustments)
     - Logs: logs\scraper_daily.log
  2. FuelGR-EVHourly
     - EV Charging Stations real-time status updates (Ministry OCPI / IDRO)
     - Schedule: Every 1 hour (24/7)
     - Duration: ~25 seconds per run
     - Logs: logs\ev_hourly.log

.USAGE
  .\setup-tasks.ps1
#>

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "=== FuelGR Windows Task Scheduler Setup ===" -ForegroundColor Cyan
Write-Host "Script Root: $PSScriptRoot"

# 1. Sanity Checks
function Assert-Tool([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required prerequisite: $Name. Please install it and ensure it is in your PATH."
  }
}

Assert-Tool gh
Assert-Tool node
Assert-Tool python

$ghAuth = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI is not authenticated. Please run 'gh auth login' first."
}

# Ensure logs directory exists
$logDir = Join-Path $PSScriptRoot "logs"
if (-not (Test-Path $logDir)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Write-Host "Created logs directory: $logDir" -ForegroundColor Green
}

$pwshExe = (Get-Command powershell.exe).Source
$publishScript = Join-Path $PSScriptRoot "publish-local.ps1"
$dailyLog = Join-Path $logDir "scraper_daily.log"
$evLog = Join-Path $logDir "ev_hourly.log"

# Task 1: FuelGR-DailyScraper (08:00 & 16:00)
$dailyTaskName = "FuelGR-DailyScraper"
Write-Host "`n[1/2] Configuring $dailyTaskName..." -ForegroundColor Cyan

$dailyAction = New-ScheduledTaskAction `
  -Execute $pwshExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$publishScript`" -LogFile `"$dailyLog`"" `
  -WorkingDirectory $PSScriptRoot

$triggerMorning = New-ScheduledTaskTrigger -Daily -At "08:00"
$triggerAfternoon = New-ScheduledTaskTrigger -Daily -At "16:00"

$dailySettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$dailyPrincipal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive

# Register Task 1
Register-ScheduledTask `
  -TaskName $dailyTaskName `
  -Action $dailyAction `
  -Trigger @($triggerMorning, $triggerAfternoon) `
  -Settings $dailySettings `
  -Principal $dailyPrincipal `
  -Description "FuelGR Gas Stations & EV Scraper. Runs daily at 08:00 & 16:00 and publishes dataset releases to GitHub." `
  -Force | Out-Null

Write-Host "  [OK] Registered $dailyTaskName (Daily at 08:00 & 16:00)" -ForegroundColor Green

# Task 2: FuelGR-EVHourly (Every 1 hour)
$evTaskName = "FuelGR-EVHourly"
Write-Host "`n[2/2] Configuring $evTaskName..." -ForegroundColor Cyan

$evAction = New-ScheduledTaskAction `
  -Execute $pwshExe `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$publishScript`" -EVOnly -LogFile `"$evLog`"" `
  -WorkingDirectory $PSScriptRoot

$evTrigger = New-ScheduledTaskTrigger `
  -Once -At "00:00" `
  -RepetitionInterval (New-TimeSpan -Hours 1)

$evSettings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$evPrincipal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive

# Register Task 2
Register-ScheduledTask `
  -TaskName $evTaskName `
  -Action $evAction `
  -Trigger $evTrigger `
  -Settings $evSettings `
  -Principal $evPrincipal `
  -Description "FuelGR EV Charging Station real-time status scraper. Runs every 1 hour and uploads chargers_latest assets to GitHub." `
  -Force | Out-Null

Write-Host "  [OK] Registered $evTaskName (Hourly interval)" -ForegroundColor Green

# Print Summary
Write-Host "`n========================================================" -ForegroundColor Yellow
Write-Host "Windows Scheduled Tasks Successfully Configured!" -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Yellow
Get-ScheduledTask -TaskName "FuelGR-*" | Select-Object TaskName, State | Format-Table -AutoSize

Write-Host "Recommended Schedule:" -ForegroundColor White
Write-Host "  - FuelGR-DailyScraper : 08:00 & 16:00 daily (full fuel + ev dataset)" -ForegroundColor Gray
Write-Host "  - FuelGR-EVHourly     : Every 1 hour (dynamic EV connector status)" -ForegroundColor Gray
Write-Host "`nLogs will be saved to:" -ForegroundColor White
Write-Host "  - $dailyLog" -ForegroundColor Gray
Write-Host "  - $evLog" -ForegroundColor Gray
Write-Host "`nTo manually trigger a task now:" -ForegroundColor White
Write-Host "  Start-ScheduledTask -TaskName 'FuelGR-DailyScraper'" -ForegroundColor Gray
Write-Host "  Start-ScheduledTask -TaskName 'FuelGR-EVHourly'" -ForegroundColor Gray
Write-Host "`nTo remove tasks:" -ForegroundColor White
Write-Host "  .\remove-tasks.ps1" -ForegroundColor Gray

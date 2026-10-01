#Requires -Version 5.1
<#
.SYNOPSIS
  Scrape fuel prices locally and upload artifacts to the GitHub Release
  (same assets as .github/workflows/update-database.yml).

.USAGE
  .\publish-local.ps1
  .\publish-local.ps1 -SkipPrefectures   # stations only
  .\publish-local.ps1 -UploadOnly        # publish existing dist/ (no scrape)
  npm run publish:local
  npm run publish:upload
#>
param(
  [switch]$SkipPrefectures,
  [switch]$UploadOnly
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Assert-Cmd([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Invoke-Gh {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GhArgs)
  & gh @GhArgs
  if ($LASTEXITCODE -ne 0) {
    throw "gh $($GhArgs -join ' ') failed (exit $LASTEXITCODE)"
  }
}

Assert-Cmd gh

Write-Host "==> Checking GitHub auth..." -ForegroundColor Cyan
gh auth status
if ($LASTEXITCODE -ne 0) {
  throw "Run 'gh auth login' once, then retry."
}

if (-not $UploadOnly) {
  Assert-Cmd node
  Assert-Cmd python

  if (-not (Test-Path 'node_modules')) {
    Write-Host "==> npm install..." -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  }

  if (-not $SkipPrefectures) {
    Write-Host "==> Prefecture scraper (scraper.py)..." -ForegroundColor Cyan
    python scraper.py
    if ($LASTEXITCODE -ne 0) { throw "scraper.py failed" }
  } else {
    Write-Host "==> Skipping prefecture scraper" -ForegroundColor Yellow
  }

  Write-Host "==> Station scraper (scraper.js)..." -ForegroundColor Cyan
  node scraper.js
  if ($LASTEXITCODE -ne 0) { throw "scraper.js failed (Cloudflare/HTML block or network)" }

  Write-Host "==> Packaging dataset..." -ForegroundColor Cyan
  python package_dataset.py
  if ($LASTEXITCODE -ne 0) { throw "package_dataset.py failed" }
} else {
  Write-Host "==> Upload-only: using existing dist/" -ForegroundColor Yellow
}

$tagFile = Join-Path 'dist' 'tag.txt'
if (-not (Test-Path $tagFile)) { throw "dist/tag.txt missing - run a full publish first" }
$TAG = (Get-Content $tagFile -Raw).Trim()
if (-not $TAG) { throw "Empty tag in dist/tag.txt" }

$assets = @(
  'dist/stations_latest.min.json',
  'dist/stations_latest.min.json.zst',
  'dist/stations_latest.json',
  'dist/price_ledger.min.json',
  'dist/price_ledger.min.json.zst',
  'dist/prefectures_latest.min.json',
  'dist/prefectures_latest.min.json.zst',
  'dist/prefectures_latest.json',
  'dist/reviews.min.json',
  'dist/reviews.min.json.zst'
)

foreach ($a in $assets) {
  if (-not (Test-Path $a)) { throw "Missing asset: $a" }
}

Write-Host "==> Publishing release $TAG ..." -ForegroundColor Cyan

# gh writes "release not found" to stderr; don't let that abort under Stop
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
gh release view $TAG 1>$null 2>$null
$exists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEap

if ($exists) {
  Invoke-Gh release edit $TAG --title "FuelGR Dataset $TAG" --notes-file dist/release_notes.md
  Invoke-Gh release upload $TAG @assets --clobber
} else {
  Write-Host "Release $TAG does not exist yet - creating as latest..." -ForegroundColor Yellow
  Invoke-Gh release create $TAG @assets `
    --title "FuelGR Dataset $TAG" `
    --notes-file dist/release_notes.md `
    --latest
}

Write-Host ""
Write-Host "Done. Release $TAG updated:" -ForegroundColor Green
Write-Host "  https://github.com/athanasso/fuelGR-scraper/releases/tag/$TAG"
Write-Host "  https://github.com/athanasso/fuelGR-scraper/releases/latest/download/stations_latest.min.json"

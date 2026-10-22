# Push the repo's Apps Script files to your Apps Script project with clasp.
# Usage (from the repo folder):  .\sync.ps1 ..\calendar-manager-clasp
param([Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path (Join-Path $Target '.clasp.json'))) { throw "No .clasp.json in $Target" }
Copy-Item CalendarManager-Code.gs (Join-Path $Target 'Code.js') -Force
Copy-Item calendar-manager-index.html (Join-Path $Target 'index.html') -Force
Push-Location $Target
try { clasp push -f } finally { Pop-Location }

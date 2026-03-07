$root = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $root 'meshcity_backend'
$frontendDir = Join-Path $root 'meshcity_frontend'

Start-Process powershell -ArgumentList @('-NoExit', '-Command', "Set-Location '$backendDir'; npm start")
Start-Process powershell -ArgumentList @('-NoExit', '-Command', "Set-Location '$frontendDir'; npm start")

Write-Host 'Started meshcity_backend and meshcity_frontend in separate terminals.'
Write-Host 'Frontend: http://localhost:4200'
Write-Host 'Backend:  http://localhost:4100/health'

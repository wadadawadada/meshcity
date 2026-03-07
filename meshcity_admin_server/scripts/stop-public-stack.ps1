$ports = @(4100, 4200)

foreach ($port in $ports) {
  $lines = netstat -ano -p tcp | Select-String ":$port\s"
  foreach ($line in $lines) {
    $parts = ($line.ToString() -replace '\s+', ' ').Trim().Split(' ')
    if ($parts.Length -ge 5 -and $parts[-1] -match '^\d+$') {
      taskkill /PID $parts[-1] /F | Out-Null
      Write-Host "Stopped PID $($parts[-1]) on port $port"
    }
  }
}

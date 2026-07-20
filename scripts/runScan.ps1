# Scheduled entry point: scan, then publish ledger + dashboard to GitHub.
Set-Location "C:\Users\hayde\BetFinder"
New-Item -ItemType Directory -Force logs | Out-Null
$log = "logs\scan-$(Get-Date -Format yyyy-MM).log"
"=== $(Get-Date -Format o) ===" | Add-Content $log

# Retry a few times: on wake the task can fire before Wi-Fi reconnects.
$attempt = 0
do {
  $attempt++
  cmd /c "node src\index.js --ci 2>&1" | Add-Content $log
  if ($LASTEXITCODE -eq 0) { break }
  "attempt $attempt failed (exit $LASTEXITCODE), retrying in 90s" | Add-Content $log
  Start-Sleep -Seconds 90
} while ($attempt -lt 3)
if ($LASTEXITCODE -ne 0) { "scan failed after $attempt attempts" | Add-Content $log; exit 1 }

# cmd /c merges git's stderr progress into stdout as plain text (PS 5.1 wraps
# native stderr in noisy error records otherwise)
cmd /c "git add data docs 2>&1" | Add-Content $log
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  cmd /c "git commit -m ""scan: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"" 2>&1" | Add-Content $log
  cmd /c "git pull --rebase origin main 2>&1" | Add-Content $log
  cmd /c "git push origin main 2>&1" | Add-Content $log
  "published" | Add-Content $log
} else {
  "no changes to publish" | Add-Content $log
}

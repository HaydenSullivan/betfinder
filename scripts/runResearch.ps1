# Weekly research job: re-validate signals, refit weights, publish findings.
Set-Location "C:\Users\hayde\BetFinder"
New-Item -ItemType Directory -Force logs | Out-Null
$log = "logs\research-$(Get-Date -Format yyyy-MM).log"
"=== $(Get-Date -Format o) ===" | Add-Content $log

cmd /c "node scripts\research.js 2>&1" | Add-Content $log
if ($LASTEXITCODE -ne 0) { "research failed with exit $LASTEXITCODE" | Add-Content $log; exit 1 }

cmd /c "git add data/research 2>&1" | Add-Content $log
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  cmd /c "git commit -m ""research: $(Get-Date -Format 'yyyy-MM-dd')"" 2>&1" | Add-Content $log
  cmd /c "git pull --rebase origin main 2>&1" | Add-Content $log
  cmd /c "git push origin main 2>&1" | Add-Content $log
  "published" | Add-Content $log
}

# dsh-token-heatmap — install into the DSH web profile.
# Installs as a `link:` dependency so future edits to this directory take
# effect after the next `dsh web` restart (no reinstall needed).
$ErrorActionPreference = "Stop"

$pluginDir = $PSScriptRoot
$spec = "link:$($pluginDir -replace '\\', '/')"

Write-Host "Installing dsh-token-heatmap into the web profile..."
Write-Host "  spec: $spec"

dsh plugin --profile web add $spec
if ($LASTEXITCODE -ne 0) {
    Write-Error "dsh plugin add failed (exit $LASTEXITCODE)."
}

Write-Host ""
Write-Host "Installed. Next steps:"
Write-Host "  1. Restart the running 'dsh web' (server half + client half both load at startup)."
Write-Host "  2. Hard-refresh the browser (Ctrl+Shift+R)."
Write-Host "  3. Open a new session or any conversation: the token heatmap card appears below the input box."
Write-Host ""
Write-Host "Remove with:  dsh plugin --profile web remove dsh-token-heatmap"

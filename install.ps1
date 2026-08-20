# Encylipedia Helper — one-line install for Windows.
# Usage: irm https://raw.githubusercontent.com/encyclipedia-ai/encyclipedia-agent/main/install.ps1 | iex
$ErrorActionPreference = "Stop"
$repo = if ($env:ENCYCLIPEDIA_AGENT_REPO) { $env:ENCYCLIPEDIA_AGENT_REPO } else { "encyclipedia-ai/encyclipedia-agent" }
$binDir = Join-Path $env:LOCALAPPDATA "Encylipedia\bin"
$bin = Join-Path $binDir "encyclipedia-agent.exe"
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Write-Host "Installing Encylipedia Helper…"
$url = "https://github.com/$repo/releases/latest/download/encyclipedia-agent-windows-x64.exe"
try {
  Invoke-WebRequest -Uri $url -OutFile $bin -UseBasicParsing
} catch {
  Write-Error "Could not download the Helper. Open https://github.com/$repo/releases and run the Windows file."
  exit 1
}

$old = [Environment]::GetEnvironmentVariable("Path", "User")
if ($old -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$old;$binDir", "User")
}
$env:Path = "$binDir;$env:Path"

Write-Host ""
Write-Host "Installed to $bin"
Write-Host "Next: sign in with your encyclipedia.ai email. The helper will keep running after that."
Write-Host ""
& $bin

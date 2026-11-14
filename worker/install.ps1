# One command to set the worker up on Windows: powershell -ExecutionPolicy Bypass -File install.ps1
# It installs uv (a small Python installer) for this user if it is missing, then the worker and what it needs.
param([string]$Extra = "gpu")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  $local = Join-Path $env:USERPROFILE ".local\bin"
  if (-not (Test-Path (Join-Path $local "uv.exe"))) {
    Write-Host "Installing uv for this user."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
  }
  $env:Path = "$local;$env:Path"
}
uv venv --python 3.12 --allow-existing .venv
uv pip install --python .venv -e ".[$Extra]"
if (-not (Test-Path worker.toml)) { Copy-Item worker.example.toml worker.toml }
Write-Host ""
Write-Host "Done. Put your site address and token in worker.toml, then run: .\run.ps1 check"

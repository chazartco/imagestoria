# Start the worker: .\run.ps1        Check the setup: .\run.ps1 check
Set-Location $PSScriptRoot
& .\.venv\Scripts\python.exe -m afterimage_worker @args
exit $LASTEXITCODE

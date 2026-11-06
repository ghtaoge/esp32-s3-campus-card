param([ValidateRange(1,65535)][int]$Port=18765,[switch]$NoBrowser)
$ErrorActionPreference='Stop'
$serverScript=Join-Path $PSScriptRoot 'serve_pc.py'
$pythonExecutable=Get-Command python -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if(-not $pythonExecutable){throw 'Python 3.9+ is required to start the local PC console.'}
$serverArgs=@($serverScript,'--port',"$Port")
if($NoBrowser){$serverArgs+='--no-browser'}
& $pythonExecutable.Source @serverArgs
exit $LASTEXITCODE

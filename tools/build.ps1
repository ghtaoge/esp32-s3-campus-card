param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$Environment = 'esp32-s3-n16r8',
    [switch]$Clean,
    [ValidateRange(1,32)]
    [int]$Jobs = 4,
    [ValidatePattern('^COM[1-9][0-9]*$')]
    [string]$UploadPort = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'platformio.ini') -PathType Leaf)) {
    throw 'platformio.ini was not found in this project.'
}

$pioExecutable = $null
foreach ($commandName in @('pio', 'platformio')) {
    $installed = Get-Command $commandName -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($installed) {
        $pioExecutable = $installed.Source
        break
    }
}
if (-not $pioExecutable) {
    $profileDirectory = [System.Environment]::GetFolderPath('UserProfile')
    if (-not $profileDirectory) { $profileDirectory = $env:USERPROFILE }
    if ($profileDirectory) {
        $candidate = Join-Path $profileDirectory '.platformio\penv\Scripts\platformio.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $pioExecutable = $candidate
        }
    }
}
if (-not $pioExecutable) {
    throw 'PlatformIO was not found. Install PlatformIO IDE or make pio/platformio available on PATH.'
}

$previousPackagesDirectory = [System.Environment]::GetEnvironmentVariable('PLATFORMIO_PACKAGES_DIR', 'Process')
$previousTempDirectory = [System.Environment]::GetEnvironmentVariable('TEMP', 'Process')
$previousTmpDirectory = [System.Environment]::GetEnvironmentVariable('TMP', 'Process')
$localCacheConfig = Join-Path $projectRoot '.local\platformio-packages.txt'
$resultCode = 0
try {
    $buildTempDirectory=Join-Path $projectRoot '.local\build-temp'
    New-Item -ItemType Directory -Path $buildTempDirectory -Force | Out-Null
    [System.Environment]::SetEnvironmentVariable('TEMP',$buildTempDirectory,'Process')
    [System.Environment]::SetEnvironmentVariable('TMP',$buildTempDirectory,'Process')
    if (Test-Path -LiteralPath $localCacheConfig -PathType Leaf) {
        $localPackagesDirectory = [System.IO.File]::ReadAllText($localCacheConfig).Trim()
        if (-not $localPackagesDirectory -or -not (Test-Path -LiteralPath $localPackagesDirectory -PathType Container)) {
            throw 'The configured local PlatformIO package cache does not exist. Update .local/platformio-packages.txt or remove this optional file.'
        }
        [System.Environment]::SetEnvironmentVariable('PLATFORMIO_PACKAGES_DIR', $localPackagesDirectory, 'Process')
        Write-Host 'Using the configured local PlatformIO package cache.'
    }

    if ($Clean) {
        & $pioExecutable run --project-dir $projectRoot --environment $Environment --target clean
        $resultCode = $LASTEXITCODE
    }
    if ($resultCode -eq 0) {
        Write-Host ('Building {0}.' -f $Environment)
        & $pioExecutable run --project-dir $projectRoot --environment $Environment -j $Jobs
        $resultCode = $LASTEXITCODE
    }
    if ($resultCode -eq 0) {
        $firmwareSource = Join-Path $projectRoot ('.pio\build\{0}\firmware.bin' -f $Environment)
        if (-not (Test-Path -LiteralPath $firmwareSource -PathType Leaf)) {
            throw 'Build completed without the expected firmware.bin output.'
        }
        $outputDirectory = Join-Path $projectRoot 'output'
        New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
        Copy-Item -LiteralPath $firmwareSource -Destination (Join-Path $outputDirectory 'firmware.bin') -Force
        Write-Host 'Exported output/firmware.bin (application image, not a full-flash image).'
    }
    if ($resultCode -eq 0 -and $UploadPort) {
        Write-Host ('Uploading to explicitly requested port {0}.' -f $UploadPort)
        & $pioExecutable run --project-dir $projectRoot --environment $Environment -j $Jobs --target upload --upload-port $UploadPort
        $resultCode = $LASTEXITCODE
    } elseif (-not $UploadPort) {
        Write-Host 'No upload requested. Firmware was not uploaded.'
    }
} finally {
    [System.Environment]::SetEnvironmentVariable('PLATFORMIO_PACKAGES_DIR', $previousPackagesDirectory, 'Process')
    [System.Environment]::SetEnvironmentVariable('TEMP',$previousTempDirectory,'Process')
    [System.Environment]::SetEnvironmentVariable('TMP',$previousTmpDirectory,'Process')
}
exit $resultCode

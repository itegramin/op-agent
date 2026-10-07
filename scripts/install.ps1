$ErrorActionPreference = 'Stop'

$nodeVersion = (& node --version 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $nodeVersion -or [int](($nodeVersion -replace '^v', '').Split('.')[0]) -lt 22) {
    throw 'op-agent requires Node.js 22 or newer. Install Node.js, then run this installer again.'
}
& npm --version *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'npm is required but was not found. Install Node.js with npm, then run this installer again.'
}

$source = if ($env:OP_AGENT_SOURCE) { $env:OP_AGENT_SOURCE } else { 'https://github.com/itegramin/op-agent/archive/refs/heads/main.zip' }
$prefix = if ($env:OP_AGENT_INSTALL_DIR) { $env:OP_AGENT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'op-agent' }
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$archive = Join-Path $tempDir 'source.zip'
$extractDir = Join-Path $tempDir 'source'

try {
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    if ($source -match '^https?://') {
        Invoke-WebRequest -Uri $source -OutFile $archive
    } elseif (Test-Path -LiteralPath $source -PathType Leaf) {
        Copy-Item -LiteralPath $source -Destination $archive
    } else {
        throw "OP_AGENT_SOURCE is not a file or HTTP(S) URL: $source"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $extractDir
    $packageDir = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $packageDir -or -not (Test-Path (Join-Path $packageDir.FullName 'package.json'))) {
        throw 'The source archive does not contain an op-agent package.json.'
    }

    & npm pack --pack-destination $tempDir $packageDir.FullName
    if ($LASTEXITCODE -ne 0) {
        throw 'npm failed to package op-agent.'
    }
    $packedArchive = Get-ChildItem -LiteralPath $tempDir -Filter '*.tgz' -File | Select-Object -First 1
    if (-not $packedArchive) {
        throw 'npm did not create an installable package archive.'
    }

    & npm install --global --prefix $prefix --ignore-scripts $packedArchive.FullName
    if ($LASTEXITCODE -ne 0) {
        throw 'npm failed to install op-agent.'
    }

    $binDir = $prefix
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathEntries = @($userPath -split ';' | Where-Object { $_ })
    if ($pathEntries -notcontains $binDir) {
        $newUserPath = (@($pathEntries) + $binDir) -join ';'
        [Environment]::SetEnvironmentVariable('Path', $newUserPath, 'User')
    }
    if (($env:Path -split ';') -notcontains $binDir) {
        $env:Path = "$binDir;$env:Path"
    }
    Write-Output "Installed op-agent to $binDir"
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

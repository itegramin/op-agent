$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 22 or later (includes npm) from https://nodejs.org, then rerun this script.'
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or later is required.' }
$installDir = if ($env:OP_AGENT_INSTALL_DIR) { $env:OP_AGENT_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'op-agent' }
$sourcePackage = if ($env:OP_AGENT_SOURCE) { $env:OP_AGENT_SOURCE } else { 'https://github.com/itegramin/op-agent/archive/refs/heads/main.tar.gz' }
& npm.cmd install --global --prefix $installDir --ignore-scripts --no-audit --no-fund $sourcePackage
if ($LASTEXITCODE -ne 0) { throw 'Installation failed.' }
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
    [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $installDir).TrimStart(';')), 'User')
}
$env:Path = "$installDir;$env:Path"
& (Join-Path $installDir 'op-agent.cmd') --version
if ($LASTEXITCODE -ne 0) { throw 'Installed command failed verification.' }
Write-Host @'
Installed op-agent. The command is available now and in new terminals.

Next steps:
1. Create an API key at https://console.anthropic.com/
2. Set it in this terminal: $env:ANTHROPIC_API_KEY = 'your-key'
3. Open your project: cd C:\path\to\your-project
4. Start op-agent: op-agent

To use OpenAI instead, set $env:OPENAI_API_KEY and $env:OP_AGENT_PROVIDER = 'openai'.
'@

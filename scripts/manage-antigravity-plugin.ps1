param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('install', 'uninstall')]
    [string]$Action,
    [string]$PluginsDirectory = (Join-Path $env:USERPROFILE '.gemini\config\plugins')
)

$ErrorActionPreference = 'Stop'

$pluginRoot = [IO.Path]::GetFullPath($PluginsDirectory).TrimEnd('\', '/')
$destination = [IO.Path]::GetFullPath((Join-Path $pluginRoot 'antidsh'))

if ((Split-Path -Parent $destination) -ne $pluginRoot -or (Split-Path -Leaf $destination) -ne 'antidsh') {
    throw "Invalid plugin destination: $destination"
}

if ($Action -eq 'uninstall') {
    if (Test-Path -LiteralPath $destination) {
        Remove-Item -LiteralPath $destination -Recurse -Force
        Write-Host "[antidsh] Removed Antigravity plugin from $destination"
    } else {
        Write-Host "[antidsh] Not installed: $destination"
    }
    exit 0
}

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\antigravity-plugin')).Path
if (-not (Test-Path -LiteralPath (Join-Path $source 'plugin.json'))) {
    throw "Source plugin manifest missing: $source\plugin.json"
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
& robocopy.exe $source $destination /MIR /XJ /NFL /NDL /NJH /NJS /NP /R:2 /W:1
if ($LASTEXITCODE -ge 8) {
    throw "Plugin copy failed (robocopy exit code $LASTEXITCODE)."
}

# Stamp the resolved absolute path of antidsh-bridge.mjs so Antigravity can
# spawn Node regardless of the active workspace cwd.
$bridgePath = [IO.Path]::GetFullPath((Join-Path $destination 'bridge\antidsh-bridge.mjs'))
$mcpConfigPath = Join-Path $destination 'mcp_config.json'
$mcpConfig = [ordered]@{
    mcpServers = [ordered]@{
        antidsh = [ordered]@{
            command = 'node'
            args = @($bridgePath)
            timeoutSeconds = 180
        }
    }
}
[IO.File]::WriteAllText(
    $mcpConfigPath,
    ($mcpConfig | ConvertTo-Json -Depth 10) + [Environment]::NewLine,
    [Text.UTF8Encoding]::new($false)
)

Write-Host "[antidsh] Installed/updated Antigravity plugin at $destination"
Write-Host "[antidsh] Bridge script: $bridgePath"
Write-Host "[antidsh] Enable 'AntiDSH' (antidsh) in Antigravity's Plugins panel."
exit 0

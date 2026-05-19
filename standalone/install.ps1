# Voice Claude Kenta4es — standalone installer (no Cowork plugin)
# Same logic as plugin/scripts/install.ps1 but reads files from ../plugin/

$ErrorActionPreference = 'Stop'
$pluginRoot = Resolve-Path "$PSScriptRoot\..\plugin"
Write-Host "Using plugin source: $pluginRoot" -ForegroundColor Cyan
& "$pluginRoot\scripts\install.ps1"

Write-Host ""
Write-Host "=== Next step: wire up MCP in Claude Desktop ===" -ForegroundColor Cyan
Write-Host "Edit %APPDATA%\Claude\claude_desktop_config.json and add:"
Write-Host ""
Write-Host '  "mcpServers": {'
Write-Host '    "claude-tts": {'
Write-Host '      "command": "node",'
Write-Host "      `"args`": [`"$env:LOCALAPPDATA\\VoiceClaudeKenta4es\\server.js`"]"
Write-Host '    }'
Write-Host '  }'
Write-Host ""
Write-Host "Then restart Claude Desktop."

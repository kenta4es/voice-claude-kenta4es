# Standalone install (no Cowork plugin)

Use this if you're not using Claude Desktop's plugin marketplace, or want to install the TTS stack independently and wire MCP up manually.

## Steps

1. Install prerequisites: Node.js LTS, AutoHotkey v2, Russian SAPI voices (see root README).

2. Run the installer:

   ```powershell
   .\install.ps1
   ```

   This copies all files to `%LOCALAPPDATA%\VoiceClaudeKenta4es`, installs npm deps, registers the Scheduled Task `VoiceClaudeKenta4es` (autostart at logon), and drops `claude-tts-hotkeys.ahk` into your Startup folder.

3. **Wire up MCP in Claude Desktop manually.** Open `%APPDATA%\Claude\claude_desktop_config.json` and add to `mcpServers`:

   ```json
   {
     "mcpServers": {
       "claude-tts": {
         "command": "node",
         "args": ["%LOCALAPPDATA%\\VoiceClaudeKenta4es\\server.js"]
       }
     }
   }
   ```

   Replace `%LOCALAPPDATA%` with the actual path (e.g., `C:\\Users\\YourName\\AppData\\Local\\VoiceClaudeKenta4es\\server.js`).

4. **Install the `voice-output` skill.** Copy `..\plugin\skills\voice-output\SKILL.md` into your Claude skills directory. (For a global Claude Desktop install, that's typically `%APPDATA%\Claude\skills\voice-output\SKILL.md`. Check your Claude Desktop docs for the current location.)

5. Restart Claude Desktop.

## Files installed

- `%LOCALAPPDATA%\VoiceClaudeKenta4es\server.js`
- `%LOCALAPPDATA%\VoiceClaudeKenta4es\tts-engine.ps1`
- `%LOCALAPPDATA%\VoiceClaudeKenta4es\start-tts-hidden.vbs`
- `%LOCALAPPDATA%\VoiceClaudeKenta4es\package.json` + `node_modules/`
- `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claude-tts-hotkeys.ahk`
- Scheduled Task: `VoiceClaudeKenta4es`

## Uninstall

```powershell
Unregister-ScheduledTask -TaskName 'VoiceClaudeKenta4es' -Confirm:$false
Remove-Item "$env:LOCALAPPDATA\VoiceClaudeKenta4es" -Recurse -Force
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\claude-tts-hotkeys.ahk"
Get-Process AutoHotkey64 -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*VoiceClaudeKenta4es*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

Then remove the `claude-tts` entry from `claude_desktop_config.json`.

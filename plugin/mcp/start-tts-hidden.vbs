' Hidden launcher for Claude TTS server.js
' Window style 0 = hidden, fourth arg false = don't wait for completion
Set objShell = CreateObject("WScript.Shell")
objShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\ClaudeTTS\server.js""", 0, False

#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook True

; Strict Left Ctrl + Left Alt — excludes AltGr (right Alt) which on RU layout
; generates Ctrl+Alt and can conflict with our hotkeys.
; Scan codes — layout-independent (physical key, not letter).

TtsLog := "D:\Claude\tts-hotkeys.log"

; Map raw server response to a friendly readable string.
PrettyResponse(label, resp) {
    r := Trim(resp)
    if (r = "PAUSED") {
        return "Paused"
    }
    if (r = "RESUMED") {
        return "Resumed"
    }
    if (r = "STOPPED") {
        return "Stopped"
    }
    if (r = "NOTHING") {
        return "Nothing playing"
    }
    if (r = "ENGINE_NOT_READY") {
        return "Engine not ready"
    }
    if (r = "ENGINE_EXIT") {
        return "Engine crashed"
    }
    if (RegExMatch(r, "^-?\d+$")) {
        return label . " " . r
    }
    if (StrLen(r) > 0 && StrLen(r) < 60) {
        return r
    }
    return label
}

Notify(text) {
    global TtsLog
    FileAppend(FormatTime(, "yyyy-MM-dd HH:mm:ss") . "  " . text . "`r`n", TtsLog)
    ToolTip("TTS: " . text)
    SetTimer(() => ToolTip(), -1500)
}

CallTTS(path, label) {
    global TtsLog
    resp := ""
    try {
        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.Open("GET", "http://127.0.0.1:48329" . path, false)
        http.SetTimeouts(2000, 2000, 2000, 2000)
        http.Send()
        try resp := http.ResponseText
    } catch as e {
        FileAppend("  ERROR: " . e.Message . "`r`n", TtsLog)
        Notify(label . " (error)")
        return
    }
    Notify(PrettyResponse(label, resp))
}

FileAppend("==== claude-tts-hotkeys started " . FormatTime(, "yyyy-MM-dd HH:mm:ss") . " ====`r`n", TtsLog)

; --- TTS playback control ---
<^<!sc02C::CallTTS("/toggle-pause", "Pause/Resume (Z)")
<^<!sc01E::CallTTS("/stop",         "Stop (A)")

; --- System mute (visual feedback via OS) ---
<^<!sc02E::{
    Notify("Mute toggle (C)")
    Send("{Volume_Mute}")
}

; --- Rate ---
<^<!Up::   CallTTS("/rate-up",   "Rate +")
<^<!Down:: CallTTS("/rate-down", "Rate -")

; --- Voice (Russian only) ---
<^<!Right::CallTTS("/voice-next", "Voice next")
<^<!Left:: CallTTS("/voice-prev", "Voice prev")

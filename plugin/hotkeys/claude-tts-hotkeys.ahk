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
<^<!sc02C::SpeakSelection()   ; Z: воспроизведение — озвучить выделенный текст (в очередь)
<^<!sc02D::CallTTS("/toggle-pause", "Pause/Resume (X)")   ; X: пауза / продолжить
<^<!sc02E::CallTTS("/stop", "Stop (C)")   ; C: стоп

; --- R: ПЕРЕЗАПУСК движка озвучки + возврат голоса Дмитрий ---
<^<!sc013::{
    Notify("Перезапуск озвучки...")
    Run('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ClaudeTTS\tts-restart.ps1"', , "Hide")
}

; --- Rate ---
<^<!Up::   CallTTS("/rate-up",   "Rate +")
<^<!Down:: CallTTS("/rate-down", "Rate -")

; --- Voice (Russian only) ---
<^<!Right::CallTTS("/voice-next", "Voice next")
<^<!Left:: CallTTS("/voice-prev", "Voice prev")


; --- Reset (R = sc013): снимает зависшую озвучку и возвращает голос ---
ResetTTS() {
    CallTTS("/stop", "Сброс озвучки")
    Sleep(400)
    CallTTS("/voice-set?name=Dmitry", "Голос Дмитрий")
    Sleep(600)
    try {
        txt := "Система переозвучки перезапущена. Голос восстановлен."
        n := StrPut(txt, "UTF-8") - 1
        buf := Buffer(n + 1)
        StrPut(txt, buf, "UTF-8")
        arr := ComObjArray(0x11, n)
        i := 0
        while (i < n) {
            arr[i] := NumGet(buf, i, "UChar")
            i += 1
        }
        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.Open("POST", "http://127.0.0.1:48329/speak", false)
        http.SetRequestHeader("Content-Type", "text/plain; charset=utf-8")
        http.SetTimeouts(2000, 2000, 5000, 5000)
        http.Send(arr)
    } catch as e {
        Notify("Reset error: " . e.Message)
    }
}

; --- Speak selection (Z = sc02C): озвучивает выделенный текст В ОЧЕРЕДЬ ---
SpeakSelection() {
    saved := ClipboardAll()
    A_Clipboard := ""
    ; ВАЖНО: модификаторы хоткея (Ctrl+Alt) ещё физически зажаты. Если послать ^c
    ; как есть, ОС видит Ctrl+Alt+C — то есть наш же хоткей STOP, и озвучка
    ; глушится, а копирование не срабатывает. Поэтому сначала "отпускаем" их.
    Send("{LAlt up}{RAlt up}{LCtrl up}{RCtrl up}")
    Sleep(40)
    Send("^c")
    if (!ClipWait(0.5) || StrLen(Trim(A_Clipboard)) = 0) {
        A_Clipboard := saved
        Notify("Нет выделения")
        return
    }
    txt := A_Clipboard
    A_Clipboard := saved
    ; Текст пишем в файл и озвучиваем ТЕМ ЖЕ путём, что и Ctrl+Alt+R
    ; (stop + POST сырых UTF-8 байт из PowerShell) — этот путь проверен и звучит.
    try {
        FileDelete("C:\ClaudeTTS\speak-sel.txt")
    } catch {
    }
    try {
        FileAppend(txt, "C:\ClaudeTTS\speak-sel.txt", "UTF-8-RAW")
        Run('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ClaudeTTS\speak-file.ps1"', , "Hide")
        Notify("Читаю выделение: " . StrLen(txt) . " симв.")
    } catch as e {
        Notify("Speak error: " . e.Message)
    }
}

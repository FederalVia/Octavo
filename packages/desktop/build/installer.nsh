; Octavo installer customisations (picked up automatically by electron-builder).

; Replaces electron-builder's "is the app running?" check.
;
; Octavo can be running twice: the app itself, and the copy Claude Desktop starts
; in the background as its memory (MCP) server. Both keep Octavo.exe in use. Close
; every Octavo.exe started from the install folder, retrying for a few seconds in
; case Claude starts it again; if one still won't close, say why and how to fix it.
!macro customCheckAppRunning
  StrCpy $R1 0
  octavo_close:
    IntOp $R1 $R1 + 1
    ; PowerShell: only processes started from this install folder.
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq '${APP_EXECUTABLE_FILENAME}' -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $R0
    ; Fallback if PowerShell is missing or blocked: this user's Octavo.exe processes.
    nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $R0
    Sleep 1000
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${if} $R0 == 0
      ${if} $R1 < 6
        DetailPrint `Waiting for Octavo to close…`
        Goto octavo_close
      ${endIf}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Octavo is still running, most likely because Claude Desktop is using it as its memory.$\r$\n$\r$\nQuit Claude (right-click its icon next to the clock, then Quit), then click Retry.$\r$\n$\r$\nOpen Claude again when the installation has finished." /SD IDCANCEL IDRETRY octavo_retry
      Quit
      octavo_retry:
        StrCpy $R1 0
        Goto octavo_close
    ${endIf}
!macroend

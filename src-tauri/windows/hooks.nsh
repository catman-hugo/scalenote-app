; ScaleNote in "Send to" and "Open with" (0.6.6), for the -setup.exe installer. The .msi gets the
; same from windows/capture.wxs.
;
; "Open with": a program entry (ScaleNote.Open) and its name under OpenWithProgids of each file
; type. That adds ScaleNote to the list without making it the default program for anything: the
; default stays what the person chose. "Send to": a shortcut in the person's Send to folder.
; Both are removed again when ScaleNote is uninstalled.

!macro SCALENOTE_OPEN_WITH EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "ScaleNote.Open" ""
!macroend

!macro SCALENOTE_NOT_OPEN_WITH EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "ScaleNote.Open"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\ScaleNote.Open" "" "ScaleNote"
  WriteRegStr SHCTX "Software\Classes\ScaleNote.Open\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\ScaleNote.Open\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  !insertmacro SCALENOTE_OPEN_WITH "png"
  !insertmacro SCALENOTE_OPEN_WITH "jpg"
  !insertmacro SCALENOTE_OPEN_WITH "jpeg"
  !insertmacro SCALENOTE_OPEN_WITH "gif"
  !insertmacro SCALENOTE_OPEN_WITH "webp"
  !insertmacro SCALENOTE_OPEN_WITH "pdf"
  !insertmacro SCALENOTE_OPEN_WITH "md"
  !insertmacro SCALENOTE_OPEN_WITH "markdown"
  CreateShortCut "$SENDTO\ScaleNote.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  ; Tells Windows the list of programs per file type changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro SCALENOTE_NOT_OPEN_WITH "png"
  !insertmacro SCALENOTE_NOT_OPEN_WITH "jpg"
  !insertmacro SCALENOTE_NOT_OPEN_WITH "jpeg"
  !insertmacro SCALENOTE_NOT_OPEN_WITH "gif"
  !insertmacro SCALENOTE_NOT_OPEN_WITH "webp"
  !insertmacro SCALENOTE_NOT_OPEN_WITH "pdf"
  !insertmacro SCALENOTE_NOT_OPEN_WITH "md"
  !insertmacro SCALENOTE_NOT_OPEN_WITH "markdown"
  DeleteRegKey SHCTX "Software\Classes\ScaleNote.Open"
  Delete "$SENDTO\ScaleNote.lnk"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

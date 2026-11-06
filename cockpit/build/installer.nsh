; The language picked in the installer, for the app's first start: it is
; read once when the app has no language of its own saved yet.
!macro customInstall
  FileOpen $0 "$INSTDIR\installer-language" w
  FileWrite $0 "$LANGUAGE"
  FileClose $0
!macroend

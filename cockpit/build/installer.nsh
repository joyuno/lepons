; The language picked in the installer, for the app's first start: it is
; read once when the app has no language of its own saved yet.
!macro customInstall
  FileOpen $0 "$INSTDIR\installer-language" w
  FileWrite $0 "$LANGUAGE"
  FileClose $0
!macroend

; The Explorer entries the app writes on each start (src/main/open-with.ts).
; An update runs the old uninstaller too; the new app writes them again.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\*\shell\Lepons"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Lepons"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Lepons"
  ${endIf}
!macroend

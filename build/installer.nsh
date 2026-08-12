; =============================================================================
; Custom NSIS uninstall script (nsis.include)
;
; Purpose: Root-fix Windows MAX_PATH (260) leftover files on uninstall.
;   - Default uninstaller `RMDir /r $INSTDIR` fails to delete files whose
;     paths exceed 260 chars, leaving residue. During upgrade, the old
;     uninstaller's atomicRMDir Rename then fails -> Abort -> "cannot close".
;   - robocopy has no MAX_PATH limit (uses \\?\ internally). Mirroring an
;     empty dir onto $INSTDIR with /MIR force-deletes any-depth files.
;
; Mechanism: electron-builder's uninstaller.nsh does:
;   `!ifmacrodef customRemoveFiles !insertmacro customRemoveFiles`
;   Defining this macro replaces the default RMDir deletion logic.
;   This macro is expanded INSIDE the Uninstall section, so runtime commands
;   (IfFileExists, nsExec, LogicLib ${if}, StdUtils isUpdated) are all legal.
;   (Do NOT put runtime commands in customUnInstallSection - that hook sits at
;   top level after SectionEnd and only compiles if kept to preprocessor ops.)
;
; NOTE: keep this file pure ASCII. NSIS reads .nsh without a BOM as the ANSI
; code page, so any non-ASCII byte (e.g. an em dash) breaks isolated compiles
; and is fragile under electron-builder's text splicing.
; =============================================================================

!macro customRemoveFiles
  ; ---- Step 1: normal deletion (fast path, most files) ----
  RMDir /r "$INSTDIR"

  ; ---- Step 2: robocopy empty-dir mirror to purge MAX_PATH leftovers ----
  ; Only if the install dir still exists (skip if step 1 already removed it).
  IfFileExists "$INSTDIR" 0 done_cleanup

    ; Create an empty dir as mirror source ($PLUGINSDIR is in temp, available
    ; during uninstall)
    CreateDirectory "$PLUGINSDIR\empty-mirror"

    ; /MIR = mirror mode: mirror source (empty) onto target, deleting extra
    ;        files in target.
    ; /NFL /NDL /NJH /NJS /NC /NS /NP suppress progress output (silent)
    ; /R:0 /W:0 disable retry waits (uninstaller must not hang)
    ; robocopy exit codes 0-7 are all success (0 none, 1 copied, 2 deleted...)
    nsExec::ExecToLog 'cmd /c ""$SYSDIR\robocopy.exe" "$PLUGINSDIR\empty-mirror" "$INSTDIR" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP /R:0 /W:0 > "$PLUGINSDIR\robocopy-uninstall.log" 2>&1"'
    Pop $R0

    ; Remove the empty mirror source dir
    RMDir "$PLUGINSDIR\empty-mirror"

    ; Finally try to remove the (now empty) install dir itself
    RMDir "$INSTDIR"

  done_cleanup:

  ; ---- Step 3 (removed): delayed cleanup of the empty install-dir shell ----
  ; A retry-loop batch was tried and abandoned. Root cause: the uninstaller's
  ; cwd is $INSTDIR and the spawned cmd inherits it, so the cleanup process
  ; itself pins $INSTDIR as its working directory. Windows cannot delete any
  ; process's cwd -> rmdir always failed with "used by another process".
  ; Decision (2026-08-10): accept the harmless empty dir shell. It contains no
  ; files, so it cannot re-trigger MAX_PATH or the upgrade "cannot close" bug;
  ; it only looks untidy in Explorer. Uninstall now ends cleanly with no
  ; orphaned cleanup process.
!macroend

@echo off
rem Installs Job Finder Helper (top-right notifications above every window; the pinned window on every desktop).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause

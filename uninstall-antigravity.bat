@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-antigravity-plugin.ps1" -Action uninstall
if errorlevel 1 pause

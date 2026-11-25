@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-antigravity-plugin.ps1" -Action install
if errorlevel 1 pause

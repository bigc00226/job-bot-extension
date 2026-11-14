@echo off
rem Double-click to open the Slack setup window:
rem   1. add the Slack app's scopes (files:read, files:write, ...) with an App Configuration Token
rem   2. check your user token and create the channels (#lancers ... #alert, #package, #portfolio)
start "" powershell -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0setup-slack.ps1"

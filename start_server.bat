@echo off
title Osekkai Hamamatsu Server
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "start_server.ps1"
pause

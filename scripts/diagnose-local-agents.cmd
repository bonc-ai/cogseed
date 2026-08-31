@echo off
REM Windows wrapper for the cross-platform CLI-agent diagnosis script.
setlocal
node "%~dp0diagnose-local-agents.mjs" %*
exit /b %ERRORLEVEL%

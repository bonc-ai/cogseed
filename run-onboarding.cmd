@echo off
REM Force the onboarding screen in the source runtime (Windows equivalent of run-onboarding.sh).
setlocal
set "COGSEED_ONBOARDING_ALWAYS=1"
call "%~dp0run.cmd"
exit /b %ERRORLEVEL%

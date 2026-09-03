@echo off
REM Test the onboarding user journey (Windows equivalent of test-onboarding.sh).
setlocal EnableExtensions
echo === Onboarding Test Script ===
echo 1. Setting COGSEED_ONBOARDING_ALWAYS=1
set "COGSEED_ONBOARDING_ALWAYS=1"

echo 2. Checking onboarding-state.json
set "STATE=%USERPROFILE%\.cogseed\data\onboarding-state.json"
if exist "%STATE%" (
  echo    File exists:
  type "%STATE%"
) else (
  echo    File does NOT exist (good for first run)
)

echo 3. Launching Electron with environment variable...
call "%~dp0run.cmd"
exit /b %ERRORLEVEL%

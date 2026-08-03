@echo off
REM Mate Agent source launcher with isolated runtime variants.
setlocal EnableExtensions EnableDelayedExpansion
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "VARIANT=expense"
set "VARIANT_SET=0"

:parse_args
if "%~1"=="" goto args_done
set "ARG=%~1"
if /I "!ARG!"=="--help" goto usage_ok
if /I "!ARG!"=="-h" goto usage_ok
if /I "!ARG!"=="--variant" (
  if "%~2"=="" goto missing_variant
  set "VALUE=%~2"
  shift
) else if /I "!ARG:~0,10!"=="--variant=" (
  set "VALUE=!ARG:~10!"
) else (
  echo [Mate Agent] Unknown argument: !ARG! 1>&2
  goto usage_error
)

if /I "!VALUE!"=="main" goto valid_variant
if /I "!VALUE!"=="cognition" goto valid_variant
if /I "!VALUE!"=="expense" goto valid_variant
if /I "!VALUE!"=="integration" goto valid_variant
echo [Mate Agent] Invalid variant: !VALUE! 1>&2
goto usage_error

:valid_variant
if "!VARIANT_SET!"=="1" if /I not "!VARIANT!"=="!VALUE!" (
  echo [Mate Agent] Conflicting --variant values: !VARIANT! and !VALUE! 1>&2
  exit /b 2
)
set "VARIANT=!VALUE!"
set "VARIANT_SET=1"
shift
goto parse_args

:args_done
if defined ORKAS_RUNTIME_VARIANT if /I not "%ORKAS_RUNTIME_VARIANT%"=="!VARIANT!" (
  echo [Mate Agent] --variant !VARIANT! conflicts with ORKAS_RUNTIME_VARIANT=%ORKAS_RUNTIME_VARIANT% 1>&2
  exit /b 2
)
set "ORKAS_RUNTIME_VARIANT=!VARIANT!"

if not exist "%APP_DIR%\package.json" (
  echo [Mate Agent] %APP_DIR%\package.json not found; check the project directory layout. 1>&2
  exit /b 1
)

echo [Mate Agent] Starting source runtime: !VARIANT!

set "ORKAS_BUILD_CHANNEL=dev"
for /f "delims=" %%G in ('git -C "%APP_DIR%" rev-parse HEAD 2^>nul') do set "ORKAS_BUILD_COMMIT=%%G"
set "ORKAS_BUILD_DIRTY=0"
for /f "delims=" %%G in ('git -C "%APP_DIR%" status --porcelain 2^>nul') do set "ORKAS_BUILD_DIRTY=1"
for /f "delims=" %%G in ('powershell -NoLogo -NoProfile -Command "[DateTime]::UtcNow.ToString('o')"') do set "ORKAS_BUILD_TIME=%%G"
echo [Mate Agent] Build identity: !ORKAS_BUILD_CHANNEL! !ORKAS_BUILD_COMMIT! dirty=!ORKAS_BUILD_DIRTY!

node --version >nul 2>nul
if errorlevel 1 (
  echo [Mate Agent] Node.js is unavailable; preparing the pinned bundled runtime...
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%APP_DIR%\scripts\bootstrap-node.ps1"
  if errorlevel 1 exit /b 1
  set "RUNTIME_KEY=win32-x64"
  if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "RUNTIME_KEY=win32-arm64"
  if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "RUNTIME_KEY=win32-arm64"
  set "PATH=%APP_DIR%\resources\runtime\node\!RUNTIME_KEY!;%PATH%"
)
node --version >nul 2>nul
if errorlevel 1 (
  echo [Mate Agent] Node.js is still unavailable after bootstrap. 1>&2
  exit /b 1
)

call node "%APP_DIR%\scripts\ensure-deps.cjs"
if errorlevel 1 exit /b 1
call node "%APP_DIR%\scripts\ensure-dev-dependencies.cjs"
if errorlevel 1 exit /b 1

set "KSTAR_ENGINE_DIR=%APP_DIR%\packages\nseap-meta-skill-engine"
set "KSTAR_ENGINE_ENTRY=%KSTAR_ENGINE_DIR%\dist\index.js"
if exist "%KSTAR_ENGINE_ENTRY%" (
  if not defined ORKAS_KSTAR_ENGINE_COMMAND set "ORKAS_KSTAR_ENGINE_COMMAND=node"
  set "KSTAR_ENGINE_ENTRY_JSON=%KSTAR_ENGINE_ENTRY:\=/%"
  if not defined ORKAS_KSTAR_ENGINE_ARGS set "ORKAS_KSTAR_ENGINE_ARGS=[""!KSTAR_ENGINE_ENTRY_JSON!"",""--stdio""]"
  if not defined ORKAS_KSTAR_ENGINE_CWD set "ORKAS_KSTAR_ENGINE_CWD=%KSTAR_ENGINE_DIR%"
  if not defined ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR set "ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR=%KSTAR_ENGINE_DIR%\ontologies"
  echo [Mate Agent] KSTAR engine configured: %KSTAR_ENGINE_ENTRY%
) else (
  echo [Mate Agent] KSTAR engine not found at %KSTAR_ENGINE_ENTRY%; continuing without external KSTAR engine.
)

pushd "%APP_DIR%"
call npm run start:electron -- --orkas-runtime-variant=!VARIANT!
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%

:missing_variant
echo [Mate Agent] --variant requires a value. 1>&2
:usage_error
echo Usage: run.cmd [--variant main^|cognition^|expense^|integration] 1>&2
exit /b 2

:usage_ok
echo Usage: run.cmd [--variant main^|cognition^|expense^|integration]
echo This expense worktree defaults to --variant expense.
exit /b 0

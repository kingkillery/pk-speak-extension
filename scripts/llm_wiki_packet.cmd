@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "SCRIPT_PATH=%SCRIPT_DIR%llm_wiki_packet.py"

if not exist "%SCRIPT_PATH%" (
  echo Missing packet CLI script: %SCRIPT_PATH% 1>&2
  exit /b 1
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
  python "%SCRIPT_PATH%" %*
  exit /b %ERRORLEVEL%
)

where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py -3 "%SCRIPT_PATH%" %*
  exit /b %ERRORLEVEL%
)

echo Python is required to run llm_wiki_packet.cmd 1>&2
exit /b 1

@ECHO OFF
SETLOCAL

SET "SCRIPT_DIR=%~dp0"
SET "WRAPPER_SCRIPT=%SCRIPT_DIR%llm_wiki_agent_failure_capture.py"

IF NOT EXIST "%WRAPPER_SCRIPT%" (
  ECHO Missing agent failure wrapper: %WRAPPER_SCRIPT% 1>&2
  EXIT /B 1
)

WHERE py >NUL 2>NUL
IF %ERRORLEVEL% EQU 0 (
  py -3 "%WRAPPER_SCRIPT%" %*
  EXIT /B %ERRORLEVEL%
)

WHERE python >NUL 2>NUL
IF %ERRORLEVEL% EQU 0 (
  python "%WRAPPER_SCRIPT%" %*
  EXIT /B %ERRORLEVEL%
)

ECHO Python is required to run run_llm_wiki_agent.cmd 1>&2
EXIT /B 1

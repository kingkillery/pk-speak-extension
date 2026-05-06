@ECHO OFF
SETLOCAL
SET "RUNTIME_SCRIPT=%~dp0llm_wiki_memory_runtime.py"

IF NOT EXIST "%RUNTIME_SCRIPT%" (
  ECHO Missing shared runtime: %RUNTIME_SCRIPT% 1>&2
  EXIT /B 1
)

WHERE py >NUL 2>NUL
IF %ERRORLEVEL% EQU 0 (
  py -3 "%RUNTIME_SCRIPT%" check %*
  EXIT /B %ERRORLEVEL%
)

WHERE python >NUL 2>NUL
IF %ERRORLEVEL% EQU 0 (
  python "%RUNTIME_SCRIPT%" check %*
  EXIT /B %ERRORLEVEL%
)

ECHO Python is required to run check_llm_wiki_memory.cmd 1>&2
EXIT /B 1

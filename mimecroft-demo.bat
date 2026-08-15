@echo off
REM ─────────────────────────────────────────────────────────────────
REM mimecroft-demo.bat — serve the shell page locally and open the
REM MIMEcroft demo (?demo=mimecroft.sh — the demo allow-list is
REM [ "mimecroft.sh" ]; see SECURITY.md).
REM
REM   double-click, or:  mimecroft-demo.bat
REM
REM The page's modules resolve ../src/… relative to /www/, so the
REM webserver's document root must be the REPO ROOT (this file's
REM folder), and the page lives at /www/.
REM
REM PUSHD, not `cd /d`: cmd.exe cannot set the current directory to a
REM UNC path (\\server\share\…) — it has no drive letter.  pushd maps
REM the path to a temporary drive (Z:, …) automatically, so the script
REM (and the server it starts) works when this file lives on a network
REM share too; popd releases the mapping when we are done.
REM ─────────────────────────────────────────────────────────────────
setlocal EnableExtensions
pushd "%~dp0"

REM ── pick a random port (8000-8999) — %RANDOM% is 0..32767 ──────
set /a PORT=%RANDOM% * 1000 / 32768 + 8000

REM ── start the python webserver (python first, then the py launcher)
REM    in a minimized window, bound to localhost only ──────────────
where python >nul 2>nul
if %ERRORLEVEL%==0 (
  start "mimecroft-httpd" /min python -m http.server %PORT% --bind 127.0.0.1
) else (
  start "mimecroft-httpd" /min py -m http.server %PORT% --bind 127.0.0.1
)

REM ── give the server a moment to bind, then open the demo ────────
timeout /t 1 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/www/?demo=mimecroft.sh"

echo.
echo  MIMEcroft demo:  http://127.0.0.1:%PORT%/www/?demo=mimecroft.sh
echo  (the server runs in the minimized "mimecroft-httpd" window; close it to stop)
echo.
popd
endlocal

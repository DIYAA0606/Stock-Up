@echo off
REM ============================================================
REM  Guess the Growth - Event Day Launcher
REM  Edit the two lines below before the event, then double-click.
REM ============================================================

set SESSION_SECRET=CHANGE_ME_replace_with_any_long_random_string
set ADMIN_PIN=CHANGE_ME_4_to_8_digit_number

REM ---- Do not edit below this line ----
cd /d "%~dp0"

echo.
echo  Starting Guess the Growth...
echo  Press Ctrl+C to stop the server.
echo.

node src/server.js
pause

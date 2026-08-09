@echo off
if "1"=="1" (echo eq) else (echo ne)
if "1"=="2" (echo yes) else (echo no)
if "%unsetvar%"=="b" (echo wrong) else (echo right)

@echo off
set myvar=hello
if defined myvar (echo defined) else (echo not-defined)
if not defined nosuch (echo not-defined-2)
if exist . (echo passwd-exists) else (echo missing)
if errorlevel 0 (echo ok) else (echo fail)
for /l %%i in (1 1 3) do echo num %%i
echo one^
two

@echo off
for %%v in (alpha beta) do (
    echo item %%v
    if "%%v"=="beta" (echo last) else (echo first)
)
for /l %%i in (1 1 3) do (
    echo num %%i
)

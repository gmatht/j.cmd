@echo off
rem posix tools: cat rm
echo before
type nosuch.txt 2>nul
if errorlevel 1 (echo failed) else (echo ok)
type nosuch.txt 2>nul
echo err=%errorlevel%
echo hi>ok.txt
type ok.txt
echo err2=%errorlevel%
del /q ok.txt

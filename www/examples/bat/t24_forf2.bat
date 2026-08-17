@echo off
echo alpha beta gamma>f.txt
for /f "tokens=*" %%a in (f.txt) do echo whole=%%a
for /f %%a in ("hello world") do echo first=%%a
echo one,two three>f2.txt
for /f "delims=," %%a in (f2.txt) do echo item=%%a
del /q f.txt f2.txt

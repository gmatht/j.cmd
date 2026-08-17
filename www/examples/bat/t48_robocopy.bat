@echo off
rem posix tools: rsync echo mkdir rm
mkdir rcsrc
echo one>rcsrc\a.txt
robocopy rcsrc rcdst /E >nul
type rcdst\a.txt
echo extra>rcdst\old.txt
echo two>rcsrc\b.txt
robocopy rcsrc rcdst /MIR >nul
type rcdst\b.txt
if exist rcdst\old.txt (echo stale) else (echo purged)
echo three>rcdst\keep.txt
robocopy rcsrc rcdst /PURGE >nul
if exist rcdst\keep.txt (echo kept) else (echo gone)
del /q rcsrc\a.txt rcsrc\b.txt rcdst\a.txt rcdst\b.txt
rmdir rcsrc
rmdir rcdst
echo done

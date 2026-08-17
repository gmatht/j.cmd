@echo off
echo data>probe.txt
if exist probe.txt (echo exists) else (echo missing)
if not exist nope.txt (echo not-there) else (echo there)
del /q probe.txt

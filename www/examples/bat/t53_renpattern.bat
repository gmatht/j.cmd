@echo off
rem v1.2: ren *.cxx *.cpp — the extension-change pattern form (a For
rem loop with a basename-derived destination; basename strips the LAST
rem suffix, cmd's exact rule). posix tools: mv basename cat rm
echo one>a.cxx
echo two>b.cxx
ren *.cxx *.cpp
type a.cpp
type b.cpp
del /q a.cpp b.cpp

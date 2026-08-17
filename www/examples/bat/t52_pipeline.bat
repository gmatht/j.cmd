@echo off
rem v1.2: pipelines (the A1 pipeline Call; the core's `a | b` shape).
rem posix tools: cat grep rm
echo alpha>f.txt
echo beta>>f.txt
type f.txt | find "beta"
echo pipe-end
del /q f.txt

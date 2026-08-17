@echo off
rem posix tools: rm echo
echo alpha beta > batf.txt
echo gamma delta >> batf.txt
for /f %%w in (batf.txt) do echo word %%w
for /f "delims=," %%a in ("one,two three,four") do echo item %%a
echo x y > batf2.txt
for /f "tokens=1,2" %%a in (batf2.txt) do echo pair %%a-%%b
for /f %%x in ('echo from command') do echo got %%x
del /q batf.txt batf2.txt

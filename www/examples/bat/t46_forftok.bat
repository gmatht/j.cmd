@echo off
echo a,b,c>f.txt
for /f "delims=, tokens=1,2" %%a in (f.txt) do echo got %%a-%%b
echo x y z>g.txt
for /f "tokens=1,2,3" %%a in (g.txt) do echo triple %%a-%%b-%%c
del /q f.txt g.txt

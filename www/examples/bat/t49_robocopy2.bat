@echo off
rem posix tools: rsync echo mkdir rm rmdir
mkdir s
echo one>s\top.txt
md s\sub
echo two>s\sub\deep.txt
echo three>s\sub\x.log
echo four>s\skipme.txt

rem no recursion flag: top-level files only, subdirs not traversed
robocopy s d1 >nul
if exist d1\top.txt (echo top-ok) else (echo top-no)
if exist d1\sub\deep.txt (echo sub-copied) else (echo sub-no)

rem /L dry run: nothing is copied
robocopy s d2 /L >nul
if exist d2\top.txt (echo dry-copied) else (echo dry-clean)

rem file filters: only *.txt, still recursive with /E
robocopy s d3 *.txt /E >nul
if exist d3\sub\deep.txt (echo txt-ok) else (echo txt-no)
if exist d3\sub\x.log (echo log-copied) else (echo log-filtered)

rem /XD excludes a directory
robocopy s d4 /E /XD sub >nul
if exist d4\top.txt (echo xd-top-ok) else (echo xd-top-no)
if exist d4\sub\deep.txt (echo sub-copied) else (echo sub-excluded)

rem /XF excludes a file
robocopy s d5 /E /XF skipme.txt >nul
if exist d5\top.txt (echo xf-top-ok) else (echo xf-top-no)
if exist d5\skipme.txt (echo skip-copied) else (echo skip-excluded)

rem /LOG writes a log file, the copy itself is unaffected
robocopy s d6 /E /LOG:rlog.txt >nul
if exist d6\top.txt (echo log-copy-ok) else (echo log-copy-no)
if exist rlog.txt (echo log-written) else (echo log-missing)

rem /MOV removes the source files after copying
robocopy s d7 /E /MOV >nul
if exist d7\top.txt (echo moved-ok) else (echo moved-no)
if exist s\top.txt (echo src-kept) else (echo src-moved)

rem cleanup
del /q d1\top.txt d1\skipme.txt d3\top.txt d3\skipme.txt d3\sub\deep.txt d4\top.txt d4\skipme.txt d5\top.txt d5\sub\deep.txt d5\sub\x.log d6\top.txt d6\skipme.txt d6\sub\deep.txt d6\sub\x.log d7\top.txt d7\skipme.txt d7\sub\deep.txt d7\sub\x.log rlog.txt
rmdir d1 d3\sub d3 d4 d5\sub d5 d6\sub d6 d7\sub d7
if exist d2 rmdir d2
rmdir s\sub
rmdir s
echo done

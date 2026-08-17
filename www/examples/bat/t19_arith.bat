@echo off
set /a x=(1+2)*3
echo x=%x%
set /a m=10%%3
echo m=%m%
set /a y=%x%+%m%
echo y=%y%
set /a z=%y%/2
echo z=%z%
set /a n=%y%*2
echo n=%n%
set /a s=%y%-3
echo s=%s%

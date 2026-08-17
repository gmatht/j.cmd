@echo off
set filled=value
set empty=
if defined filled (echo filled-defined) else (echo filled-not)
if defined empty (echo empty-defined) else (echo empty-not)
if not defined empty (echo empty-not-2) else (echo empty-defined-2)
if not defined missing (echo missing-not) else (echo missing-defined)

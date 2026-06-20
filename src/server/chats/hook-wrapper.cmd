@echo off
set "ELECTRON_RUN_AS_NODE=1"
{{{NODE}}} {{{FORWARDER}}} {{{ENDPOINT}}} "%~1" >NUL 2>NUL
exit /B 0

#!/bin/sh
ELECTRON_RUN_AS_NODE=1 {{{NODE}}} {{{FORWARDER}}} {{{ENDPOINT}}} >/dev/null 2>&1
exit 0

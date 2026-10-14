#!/bin/bash
# Starts Mallow on a Mac or Linux. Needs Python 3, which macOS offers to install the first time you type python3 in Terminal.
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  nohup python3 mallow.py >/dev/null 2>&1 &
elif [ "$(uname)" = "Darwin" ]; then
  osascript -e 'display dialog "Mallow needs Python 3. Open Terminal, type python3 and press Return, and macOS will offer to install it." buttons {"OK"}'
else
  echo "Mallow needs Python 3 (python3)."
fi

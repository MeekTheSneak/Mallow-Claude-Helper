#!/bin/bash
# Starts Mallow on a Mac or Linux. Needs Python 3.9 or newer.
cd "$(dirname "$0")"
# on a Mac, /usr/bin/python3 exists even before Python is installed, so ask it to actually run
if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
  nohup python3 mallow.py >/dev/null 2>&1 &
elif [ "$(uname)" = "Darwin" ]; then
  osascript -e 'display dialog "Mallow needs Python 3.9 or newer. Open Terminal, type python3 and press Return, and macOS will offer to install it. Or get it from python.org." buttons {"OK"}'
else
  echo "Mallow needs Python 3.9 or newer (python3)."
fi

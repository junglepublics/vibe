#!/bin/sh
# Push the repo's Apps Script files to your Apps Script project with clasp.
# Usage: ./sync.sh /path/to/folder-created-by-clasp-clone
set -e
[ -f "$1/.clasp.json" ] || { echo "Usage: $0 <folder containing .clasp.json>"; exit 1; }
cp CalendarManager-Code.gs "$1/Code.js"
cp calendar-manager-index.html "$1/index.html"
cd "$1" && clasp push -f

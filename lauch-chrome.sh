#!/usr/bin/env bash

# Launch Chrome with Remote Debugging Port for Manual Chrome Mode on macOS
# Does NOT close existing Chrome windows

ChromePath="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DebugPort=9222
TempProfile="${TMPDIR:-/tmp}/chrome-debug-profile-${DebugPort}"

RED="\033[0;31m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
GRAY="\033[0;90m"
NC="\033[0m"

# Check if Chrome exists
if [ ! -x "$ChromePath" ]; then
    echo -e "${RED}❌ Chrome not found at: $ChromePath${NC}"
    echo ""
    echo -e "${YELLOW}Please install Google Chrome from: https://www.google.com/chrome/${NC}"
    exit 1
fi

# Check if debug port is already in use
if lsof -nP -iTCP:"$DebugPort" -sTCP:LISTEN >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Port $DebugPort is already in use.${NC}"
    echo -e "${CYAN}Chrome debugging may already be running at:${NC}"
    echo -e "${GREEN}http://127.0.0.1:$DebugPort${NC}"
    echo ""
    echo -e "${GRAY}Existing Chrome windows are NOT closed.${NC}"
    exit 0
fi

echo -e "${GREEN}✅ Found Chrome at: $ChromePath${NC}"
echo ""
echo -e "${CYAN}Starting Chrome with Remote Debugging Port $DebugPort...${NC}"
echo -e "${GRAY}Using isolated temporary profile at: $TempProfile${NC}"
echo -e "${GREEN}Existing Chrome windows will NOT be closed.${NC}"
echo ""

# Ensure temp profile directory exists
mkdir -p "$TempProfile"

# Launch Chrome with debugging port and isolated profile
"$ChromePath" \
  --remote-debugging-port="$DebugPort" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$TempProfile" \
  --new-window \
  about:blank

echo ""
echo -e "${YELLOW}⚠️  Debug Chrome closed. The server will no longer be able to access manual tabs.${NC}"
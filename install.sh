#!/usr/bin/env bash
# install.sh — Setup Hari's Pi configuration and extensions across devices (Work, Home, Cafe)
set -euo pipefail

MODE="link"
for arg in "$@"; do
  case "$arg" in
    --copy)
      MODE="copy"
      ;;
    --link)
      MODE="link"
      ;;
    -h|--help)
      echo "Usage: ./install.sh [--link | --copy]"
      echo "  --link  (default) Symlink settings and footer configs to ~/.pi/agent/"
      echo "  --copy  Copy settings and footer configs instead of symlinking"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${HOME}/.pi/agent"
EXTENSIONS_DIR="${PI_AGENT_DIR}/extensions"

echo "=========================================================="
echo "  Setting up Pi coding agent configuration (${MODE} mode)"
echo "=========================================================="

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not found. Please install Node.js (v20+ or v22+) first."
  exit 1
fi
echo "✅ Node.js: $(node -v)"

# 2. Check Pi CLI
if ! command -v pi >/dev/null 2>&1; then
  echo "⚠️  Pi CLI not found. Installing globally via npm..."
  npm install -g @earendil-works/pi-coding-agent
fi
echo "✅ Pi CLI: $(command -v pi)"

# 3. Prepare ~/.pi/agent directories
mkdir -p "${EXTENSIONS_DIR}"

backup_if_needed() {
  local target="$1"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    local backup="${target}.bak.$(date +%Y%m%d%H%M%S)"
    echo "📦 Backing up existing $(basename "$target") -> $(basename "$backup")"
    mv "$target" "$backup"
  fi
}

# 4. Deploy Settings & 2-Line Footer Config
SETTINGS_SRC="${SCRIPT_DIR}/config/settings.json"
FOOTER_SRC="${SCRIPT_DIR}/config/pi-footer.json"

if [ "$MODE" = "link" ]; then
  backup_if_needed "${PI_AGENT_DIR}/settings.json"
  backup_if_needed "${EXTENSIONS_DIR}/pi-footer.json"

  ln -sf "${SETTINGS_SRC}" "${PI_AGENT_DIR}/settings.json"
  ln -sf "${FOOTER_SRC}" "${EXTENSIONS_DIR}/pi-footer.json"
  echo "🔗 Symlinked settings.json -> ${PI_AGENT_DIR}/settings.json"
  echo "🔗 Symlinked pi-footer.json -> ${EXTENSIONS_DIR}/pi-footer.json"
else
  backup_if_needed "${PI_AGENT_DIR}/settings.json"
  backup_if_needed "${EXTENSIONS_DIR}/pi-footer.json"

  cp "${SETTINGS_SRC}" "${PI_AGENT_DIR}/settings.json"
  cp "${FOOTER_SRC}" "${EXTENSIONS_DIR}/pi-footer.json"
  echo "📄 Copied settings.json -> ${PI_AGENT_DIR}/settings.json"
  echo "📄 Copied pi-footer.json -> ${EXTENSIONS_DIR}/pi-footer.json"
fi

echo ""
echo "=========================================================="
echo "🎉 Pi setup complete!"
echo "=========================================================="
echo "• Default Provider: antigravity"
echo "• Default Model:    gemini-3.8-flash (thinking: high)"
echo "• Footer Layout:    2-line status bar (Line 1: Model/Context/Time, Line 2: Git)"
echo "• Custom Bundles:   Antigravity/Cursor meter + Live Footer + md-log"
echo ""
echo "Next step (if setting up a new device):"
echo "  Run 'pi' to auto-download packages, then authenticate your providers:"
echo "    /login antigravity"
echo "    /login cursor"
echo "=========================================================="

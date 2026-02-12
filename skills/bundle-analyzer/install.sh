#!/usr/bin/env bash
set -e

SKILL_NAME="bundle-analyzer"
INSTALL_DIR="$HOME/.claude/skills/$SKILL_NAME"
BIN_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "🔧 Installing $SKILL_NAME skill to Claude Code..."

# Create directories if they don't exist
mkdir -p "$HOME/.claude/skills"
mkdir -p "$BIN_DIR"

# Build the binary
echo "📦 Building binary..."
cd "$SCRIPT_DIR"
bun build --compile cli.mjs --outfile bundle-analyzer

# Install binary to ~/.local/bin
echo "📦 Installing binary to $BIN_DIR..."
cp bundle-analyzer "$BIN_DIR/"
chmod +x "$BIN_DIR/bundle-analyzer"

# Create/update skill directory
echo "📁 Installing skill to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

# Copy only the skill documentation
cp SKILL.md "$INSTALL_DIR/"

echo "✅ Installation complete!"
echo ""
echo "Binary installed to: $BIN_DIR/bundle-analyzer"
echo "Skill files installed to: $INSTALL_DIR"
echo ""
echo "Make sure $BIN_DIR is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "Usage in Claude Code:"
echo "  /bundle-analyzer"

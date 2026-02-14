#!/usr/bin/env bash
set -e

SKILL_NAME="bundle-analyzer"
INSTALL_DIR="$HOME/.claude/skills/$SKILL_NAME"
BIN_DIR="$HOME/.local/bin"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing $SKILL_NAME skill to Claude Code..."

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# Copy source files
echo "Copying source files..."
cd "$SCRIPT_DIR"
cp -r lib "$INSTALL_DIR/"
cp cli.mjs "$INSTALL_DIR/"
cp SKILL.md "$INSTALL_DIR/"

if [ -f "bun.lock" ]; then
  cp bun.lock "$INSTALL_DIR/"
fi

# Create package.json without postinstall hook to avoid recursion
cat > "$INSTALL_DIR/package.json" << 'PKG'
{
  "name": "bundle-analyzer",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@swc/core": "^1.11.24"
  },
  "trustedDependencies": [
    "@swc/core"
  ]
}
PKG

# Install dependencies
echo "Installing dependencies..."
cd "$INSTALL_DIR"
bun install --production

# Create wrapper script
echo "Creating wrapper script..."
cat > "$BIN_DIR/bundle-analyzer" << 'WRAPPER'
#!/usr/bin/env bash
exec bun "$HOME/.claude/skills/bundle-analyzer/cli.mjs" "$@"
WRAPPER
chmod +x "$BIN_DIR/bundle-analyzer"

echo ""
echo "Installation complete!"
echo "Wrapper script: $BIN_DIR/bundle-analyzer"
echo "Source files:    $INSTALL_DIR"
echo ""
echo "Make sure $BIN_DIR is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "Usage in Claude Code:"
echo "  /bundle-analyzer"

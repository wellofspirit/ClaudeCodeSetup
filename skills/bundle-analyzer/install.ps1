$ErrorActionPreference = "Stop"

$SkillName = "bundle-analyzer"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallDir = Join-Path $env:USERPROFILE ".claude\skills\$SkillName"
$BinDir = Join-Path $env:USERPROFILE ".local\bin"

Write-Host "Installing $SkillName skill to Claude Code..."

# Create directories
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# Copy source files
Write-Host "Copying source files..."
Copy-Item -Path (Join-Path $ScriptDir "lib") -Destination $InstallDir -Recurse -Force
Copy-Item -Path (Join-Path $ScriptDir "cli.mjs") -Destination $InstallDir -Force
Copy-Item -Path (Join-Path $ScriptDir "SKILL.md") -Destination $InstallDir -Force

$LockFile = Join-Path $ScriptDir "bun.lock"
if (Test-Path $LockFile) {
    Copy-Item -Path $LockFile -Destination $InstallDir -Force
}

# Create package.json without postinstall hook to avoid recursion
$PackageJson = @'
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
'@
Set-Content -Path (Join-Path $InstallDir "package.json") -Value $PackageJson -Encoding UTF8

# Install dependencies
Write-Host "Installing dependencies..."
Push-Location $InstallDir
try {
    bun install --production
} finally {
    Pop-Location
}

# Create .cmd wrapper for cmd / PowerShell
$CmdWrapper = "@echo off`r`nbun `"$InstallDir\cli.mjs`" %*"
Set-Content -Path (Join-Path $BinDir "bundle-analyzer.cmd") -Value $CmdWrapper -Encoding ASCII

Write-Host ""
Write-Host "Installation complete!"
Write-Host "Wrapper script: $BinDir\bundle-analyzer.cmd"
Write-Host "Source files:    $InstallDir"
Write-Host ""

# Check if BinDir is already in PATH
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -and $UserPath.Split(";") -contains $BinDir) {
    Write-Host "$BinDir is already in your PATH."
} else {
    Write-Host "$BinDir is NOT in your PATH. Add it with:"
    Write-Host ""
    Write-Host "  `$p = [Environment]::GetEnvironmentVariable('PATH','User')"
    Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `"`$p;$BinDir`", 'User')"
    Write-Host ""
    Write-Host "Then restart your terminal."
}

Write-Host ""
Write-Host "Usage in Claude Code:"
Write-Host "  /bundle-analyzer"

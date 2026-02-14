#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

if (process.platform === "win32") {
  console.log("Detected Windows — running PowerShell install script...");
  execFileSync("powershell", ["-ExecutionPolicy", "Bypass", "-File", join(scriptsDir, "install.ps1")], { stdio: "inherit" });
} else {
  console.log(`Detected ${process.platform} — running bash install script...`);
  execFileSync("bash", [join(scriptsDir, "install.sh")], { stdio: "inherit" });
}

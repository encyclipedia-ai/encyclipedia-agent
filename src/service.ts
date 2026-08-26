import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homeDir, logPath } from "./paths.js";

const MAC_LABEL = "ai.encyclipedia.helper";
const LINUX_UNIT = "encyclipedia-helper.service";
const WIN_TASK = "Encylipedia Helper";

export function helperInvocation(): { command: string; args: string[] } {
  const execPath = process.execPath;
  const selfName = path.basename(execPath).replace(/\.exe$/i, "");
  if (
    selfName === "encyclipedia-agent" ||
    selfName === "encyclipedia-librarian" ||
    selfName === "Encylipedia Helper" ||
    selfName === "Encyclipedia Librarian"
  ) {
    return { command: execPath, args: ["start"] };
  }
  const script = process.argv[1];
  if (script) {
    return { command: execPath, args: [path.resolve(script), "start"] };
  }
  return { command: execPath, args: ["start"] };
}

function macPlistPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function linuxUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", LINUX_UNIT);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeMacPlist(command: string, args: string[]): string {
  const plistPath = macPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const argXml = [command, ...args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(homeDir())}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath())}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, body, { mode: 0o644 });
  return plistPath;
}

function writeLinuxUnit(command: string, args: string[]): string {
  const unitPath = linuxUnitPath();
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  const exec = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  const body = `[Unit]
Description=Encyclipedia Librarian
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=5
WorkingDirectory=${homeDir()}
StandardOutput=append:${logPath()}
StandardError=append:${logPath()}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, body, { mode: 0o644 });
  return unitPath;
}

function run(cmd: string, args: string[]): { status: number; stderr: string } {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: result.status ?? 1, stderr: result.stderr ?? "" };
}

export async function installBackgroundService(): Promise<void> {
  const { command, args } = helperInvocation();
  if (process.platform === "darwin") {
    const plist = writeMacPlist(command, args);
    const uid = process.getuid?.() ?? 0;
    const domain = `gui/${uid}`;
    run("launchctl", ["bootout", domain, MAC_LABEL]);
    const loaded = run("launchctl", ["bootstrap", domain, plist]);
    if (loaded.status !== 0 && !loaded.stderr.includes("already")) {
      // Older macOS: load instead of bootstrap.
      const legacy = run("launchctl", ["load", "-w", plist]);
      if (legacy.status !== 0) {
        throw new Error(legacy.stderr.trim() || loaded.stderr.trim() || "launchctl failed");
      }
    }
    run("launchctl", ["kickstart", "-k", `${domain}/${MAC_LABEL}`]);
    return;
  }
  if (process.platform === "linux") {
    writeLinuxUnit(command, args);
    const enable = run("systemctl", ["--user", "enable", "--now", LINUX_UNIT]);
    if (enable.status !== 0) {
      throw new Error(enable.stderr.trim() || "systemctl --user failed");
    }
    return;
  }
  if (process.platform === "win32") {
    const tr = [`"${command}"`, ...args.map((a) => `"${a}"`)].join(" ");
    run("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"]);
    const created = run("schtasks", [
      "/Create",
      "/TN",
      WIN_TASK,
      "/TR",
      tr,
      "/SC",
      "ONLOGON",
      "/RL",
      "LIMITED",
      "/F",
    ]);
    if (created.status !== 0) {
      throw new Error(created.stderr.trim() || "Could not create a Windows startup task");
    }
    run("schtasks", ["/Run", "/TN", WIN_TASK]);
    return;
  }
  throw new Error(`Background install is not supported on ${process.platform}`);
}

export function uninstallBackgroundService(): void {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    run("launchctl", ["bootout", `gui/${uid}`, MAC_LABEL]);
    run("launchctl", ["unload", "-w", macPlistPath()]);
    fs.rmSync(macPlistPath(), { force: true });
    return;
  }
  if (process.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", LINUX_UNIT]);
    fs.rmSync(linuxUnitPath(), { force: true });
    return;
  }
  if (process.platform === "win32") {
    run("schtasks", ["/End", "/TN", WIN_TASK]);
    run("schtasks", ["/Delete", "/TN", WIN_TASK, "/F"]);
  }
}

export function stopBackgroundService(): void {
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 0;
    run("launchctl", ["bootout", `gui/${uid}`, MAC_LABEL]);
    return;
  }
  if (process.platform === "linux") {
    run("systemctl", ["--user", "stop", LINUX_UNIT]);
    return;
  }
  if (process.platform === "win32") {
    run("schtasks", ["/End", "/TN", WIN_TASK]);
  }
}

/** Used when LaunchAgent/task creation fails — run in this window instead. */
export function spawnForegroundDetached(): void {
  const { command, args } = helperInvocation();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

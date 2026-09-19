import { spawn } from "child_process";
import os from "os";

/**
 * Copies text to the system clipboard using the platform's native clipboard
 * utility (clip.exe on Windows, pbcopy on macOS, xclip on Linux/X11).
 * Resolves true on success, false if the utility couldn't be spawned
 * (e.g. xclip not installed on a headless Linux box).
 */
export function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const platform = os.platform();
    let cmd: string;
    let args: string[];
    if (platform === "darwin") {
      cmd = "pbcopy";
      args = [];
    } else if (platform === "win32") {
      cmd = "clip";
      args = [];
    } else {
      cmd = "xclip";
      args = ["-selection", "clipboard"];
    }
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(cmd, args);
      child.on("error", () => finish(false));
      child.on("close", (code) => finish(code === 0));
      child.stdin.write(text);
      child.stdin.end();
    } catch {
      finish(false);
    }
  });
}

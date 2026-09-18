import os from "os";

/**
 * Best-effort detection of legacy Windows console hosts (old `cmd.exe` / classic
 * `powershell.exe` launched outside Windows Terminal) that may lack VT100/ANSI
 * escape-sequence and true-color support. terminal-kit degrades gracefully on these
 * hosts, but layout/color glitches are more likely, so we surface a one-time,
 * non-blocking warning instead of failing silently.
 *
 * Returns a warning string to print, or null if the host looks modern enough
 * (Windows Terminal, ConEmu/Cmder, Windows 10 1909+ conhost with VT enabled via
 * ENABLE_VIRTUAL_TERMINAL_PROCESSING, or any non-Windows platform).
 */
export function checkWindowsConsoleCapabilities(env: NodeJS.ProcessEnv = process.env, platform: string = os.platform()): string | null {
  if (!platform.startsWith("win")) return null;

  // Windows Terminal, VS Code's integrated terminal, ConEmu/Cmder, and most modern
  // third-party hosts set one of these to signal proper VT100/true-color support.
  if (env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === "ON" || env.COLORTERM) {
    return null;
  }

  // Windows 10 (build 1909+) conhost supports VT sequences once a process opts in;
  // Node/terminal-kit generally handle this automatically on modern builds. Only
  // warn on releases predating that support (Windows 10 pre-1909 / Windows 8.1 and
  // earlier report an NT kernel version below 10.0.18363).
  const release = os.release();
  const [major, , build] = release.split(".").map((part) => Number.parseInt(part, 10));
  const isModernConhost = major > 10 || (major === 10 && build >= 18363);
  if (isModernConhost) return null;

  return (
    "Legacy Windows console detected (no Windows Terminal / VT100 support signaled). " +
    "Display glitches or missing colors may occur. For the best experience, run llama-manager " +
    "in Windows Terminal with PowerShell 7 (pwsh)."
  );
}

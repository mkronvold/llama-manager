#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import terminalKit from "terminal-kit";
import { LlamaManagerApp } from "./LlamaManagerApp";
import { checkWindowsConsoleCapabilities } from "./lib/termcaps";
import { checkNodeVersionCompatibility } from "./lib/nodeversion";
import { getLogsDir, loadConfig } from "./lib/config";
import { detectExistingSession, stopServer } from "./lib/server";

async function runStopCli(): Promise<never> {
  // Handles `llama-manager --stop`: stops a server left running detached by
  // a previous "Exit Now" (or one that survived a crash), without launching
  // the TUI at all. Relies on the same session marker file / stop logic the
  // app itself uses for reattach, so behavior stays consistent.
  const config = await loadConfig().catch(() => null);
  const session = detectExistingSession({ monitor: false, config });
  if (!session) {
    console.log("No running server found.");
    process.exit(0);
  }
  if (!session.verified) {
    console.error(`A Strata session marker names PID ${session.pid}, but ${session.reason}.`);
    console.error("It was not stopped. Check that process manually, then clear the marker from the Dashboard.");
    process.exit(1);
  }
  const label = session.runtime === "strata" ? "Strata service" : "server";
  console.log(`Stopping ${label} (PID ${session.pid})...`);
  const result = await stopServer({ mode: "force-on-failure" });
  if (!result.ok) {
    console.error(`Stop failed: ${result.reason}`);
    process.exit(1);
  }
  if (result.forced && result.reason) console.log(`Cooperative unload failed (${result.reason}); force-stopped.`);
  console.log("Stopped.");
  process.exit(0);
}

function main(): void {
  const nodeVersionWarning = checkNodeVersionCompatibility();
  if (nodeVersionWarning) {
    console.warn(`[llama-manager] ${nodeVersionWarning}`);
  }

  const consoleWarning = checkWindowsConsoleCapabilities();
  if (consoleWarning) {
    // Printed before entering fullscreen mode so it's visible to the user even if
    // the app itself can't render it well on this console host.
    console.warn(`[llama-manager] ${consoleWarning}`);
  }

  const term = terminalKit.terminal;

  term.fullscreen(true);
  term.grabInput({ mouse: 'motion' });
  term.hideCursor();

  const app = new LlamaManagerApp(term);
  app.start();

  function restoreTerminal(): void {
    try {
      term.grabInput(false);
      term.fullscreen(false);
      term.styleReset();
    } catch {
      // best-effort; terminal may already be in a bad state
    }
  }

  function logCrash(err: unknown): void {
    try {
      const logsDir = getLogsDir();
      fs.mkdirSync(logsDir, { recursive: true });
      const stack = err instanceof Error ? (err.stack || err.message) : String(err);
      fs.appendFileSync(
        path.join(logsDir, "crash.log"),
        `[${new Date().toISOString()}] ${stack}\n`
      );
    } catch {
      // if we can't write the crash log, there's nothing more we can do
    }
  }

  // Known-recoverable bug in terminal-kit's SGR mouse-protocol parser: a resize
  // event racing with an in-flight mouse-motion report can leave
  // `this.state.button.left` null, causing a TypeError deep inside the
  // library's stdin handler. Swallow only that specific, well-understood
  // crash (still logged) so a window resize during mouse tracking doesn't
  // take down the whole app; anything else is treated as fatal.
  function isRecoverableMouseProtocolBug(err: unknown): boolean {
    if (!(err instanceof TypeError)) return false;
    const stack = err.stack || "";
    return stack.includes("mouseSGRProtocol") || stack.includes("mouseButtonProtocol") || stack.includes("mouseX10Protocol");
  }

  process.on('uncaughtException', (err) => {
    logCrash(err);
    if (isRecoverableMouseProtocolBug(err)) {
      // Any partial output from the crash may have reached the terminal mid-frame;
      // force a full repaint on the next tick so the screen recovers cleanly.
      setImmediate(() => app.forceRedraw());
      return; // ignore and keep running
    }
    restoreTerminal();
    console.error("[llama-manager] Fatal error:", err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logCrash(reason);
  });

  process.on('SIGINT', () => {
    app.dispose();
    restoreTerminal();
    term.processExit(0);
  });
}

if (process.argv.includes("--stop")) {
  runStopCli();
} else {
  main();
}

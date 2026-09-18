#!/usr/bin/env node

import terminalKit from "terminal-kit";
import { LlamaManagerApp } from "./LlamaManagerApp";
import { checkWindowsConsoleCapabilities } from "./lib/termcaps";
import { checkNodeVersionCompatibility } from "./lib/nodeversion";

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

process.on('SIGINT', () => {
  app.dispose();
  term.grabInput(false);
  term.fullscreen(false);
  term.styleReset();
  term.processExit(0);
});

import { fg } from "./theme";
import type { Color } from "./theme";
import type { FramebufferCanvas } from "./framebuffer-canvas";

export interface LogSegment {
  text: string;
  color: Color;
}

const mainLineRegex = /^(\d+\.\d+\.\d+\.\d+)\s+([IEW])\s+(.*?):\s+(.*)$/;

export function parseLogLine(line: string): LogSegment[] {
  if (line.includes("ERROR") || line.includes("FATAL")) {
    return [{ text: line, color: "danger" }];
  }

  const match = line.match(mainLineRegex);
  if (!match) {
    return [{ text: line, color: "text" }];
  }

  const [, timestamp, severity, component, rest] = match;

  const sevColor: Color =
    severity === "E" ? "danger" :
    severity === "W" ? "warning" :
    "info";

  return [
    { text: timestamp, color: "textMuted" },
    { text: " ", color: "canvas" },
    { text: severity, color: sevColor },
    { text: " ", color: "canvas" },
    { text: component, color: "textMuted" },
    { text: ": ", color: "textMuted" },
    { text: rest, color: "text" },
  ];
}

export function renderLogLine(canvas: FramebufferCanvas, x: number, y: number, width: number, line: string): void {
  canvas.moveTo(x, y);
  const segments = parseLogLine(line);
  renderLogSegments(canvas, x, y, width, segments);
}

export function renderLogSegments(canvas: FramebufferCanvas, x: number, y: number, width: number, segments: LogSegment[]): void {
  canvas.moveTo(x, y);
  let remainingWidth = width;

  for (const seg of segments) {
    if (remainingWidth <= 0) break;
    const truncated = seg.text.substring(0, remainingWidth);
    fg(canvas, seg.color, truncated);
    remainingWidth -= truncated.length;
  }
}

/** Splits a log line's colored segments into rows that each fit within `width`
 *  columns, preserving segment coloring across the wrap boundaries. Used by the
 *  Logs viewer's word-wrap mode; a line shorter than `width` yields a single row. */
export function wrapLogLine(line: string, width: number): LogSegment[][] {
  if (width <= 0) return [parseLogLine(line)];
  const segments = parseLogLine(line);
  const rows: LogSegment[][] = [];
  let current: LogSegment[] = [];
  let currentWidth = 0;

  for (const seg of segments) {
    let text = seg.text;
    while (text.length > 0) {
      const space = width - currentWidth;
      if (space <= 0) {
        rows.push(current);
        current = [];
        currentWidth = 0;
        continue;
      }
      const chunk = text.substring(0, space);
      current.push({ text: chunk, color: seg.color });
      currentWidth += chunk.length;
      text = text.substring(chunk.length);
    }
  }

  if (current.length > 0 || rows.length === 0) rows.push(current);
  return rows;
}

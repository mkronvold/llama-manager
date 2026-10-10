import { StringDecoder } from "node:string_decoder";
import fs from "fs-extra";

export interface FileTail {
  /** Synchronously reads everything appended since the last read. */
  drainSync(): void;
  /** Stops polling; flushes a trailing partial line first when `flush` is set. */
  stop(flush?: boolean): void;
}

/**
 * Tails `file` from byte `startOffset`, emitting complete lines (CRLF or LF)
 * once. Partial lines and split UTF-8 sequences are held until completed. A
 * file that shrinks below the read position (truncation/rotation) restarts
 * from 0; a missing file is retried until it appears.
 */
export function createFileTail(
  file: string,
  startOffset: number,
  onLine: (line: string) => void,
  intervalMs = 1000,
): FileTail {
  let position = Math.max(0, startOffset);
  let decoder = new StringDecoder("utf8");
  let pending = "";
  let stopped = false;
  let busy = false;

  const consume = (buf: Buffer) => {
    pending += decoder.write(buf);
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.endsWith("\r") ? part.slice(0, -1) : part;
      if (line.trim()) onLine(line);
    }
  };

  const reset = () => {
    position = 0;
    decoder = new StringDecoder("utf8");
    pending = "";
  };

  const drainSync = () => {
    let fd: number | null = null;
    try {
      const size = fs.statSync(file).size;
      if (size < position) reset();
      if (size === position) return;
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(size - position);
      const read = fs.readSync(fd, buf, 0, buf.length, position);
      position += read;
      consume(buf.subarray(0, read));
    } catch {
      // missing or locked: retry on the next poll
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  };

  const poll = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const size = (await fs.stat(file)).size;
      if (size < position) reset();
      if (size === position) return;
      const from = position;
      const fd = await fs.open(file, "r");
      try {
        const buf = Buffer.alloc(size - from);
        const { bytesRead } = await fs.read(fd, buf, 0, buf.length, from);
        // A synchronous drain may have consumed these bytes meanwhile.
        if (stopped || position !== from) return;
        position += bytesRead;
        consume(buf.subarray(0, bytesRead));
      } finally {
        await fs.close(fd);
      }
    } catch {
      // missing or locked: retry on the next poll
    } finally {
      busy = false;
    }
  };

  drainSync();
  const timer = setInterval(() => { void poll(); }, intervalMs);
  timer.unref?.();

  return {
    drainSync,
    stop(flush = false) {
      if (stopped) return;
      clearInterval(timer);
      if (flush) {
        drainSync();
        const rest = pending + decoder.end();
        pending = "";
        if (rest.trim()) onLine(rest.replace(/\r$/, ""));
      }
      stopped = true;
    },
  };
}

/** Current size of `file`, or 0 when it does not exist yet. */
export function fileSizeOrZero(file: string | null): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

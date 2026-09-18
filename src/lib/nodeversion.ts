/**
 * Best-effort detection of a Node.js runtime version outside this fork's tested
 * range. Confirmed root cause of a real "extraction hangs forever" report: Node.js
 * v24.17.0's built-in zlib inflate stream stalls indefinitely partway through
 * decompressing some larger zip entries (reproduced independently of this app —
 * directly against `extract-zip`, and again against a bare `yauzl` + zlib
 * readStream with zero disk I/O involved — always stalling at the identical byte
 * offset, ruling out antivirus/disk/corruption as the cause). This is a Node.js
 * runtime regression, not a bug in this fork's extraction/backpressure/retry logic.
 *
 * We can't practically detect "will this exact zlib stream hang" ahead of time, but
 * we *can* warn when running on a Node major version outside the range this fork
 * has verified working (18–22), since that's the only actionable signal available
 * before an install is attempted.
 */
export const MIN_SUPPORTED_NODE_MAJOR = 18;
export const MAX_SUPPORTED_NODE_MAJOR = 22;

export function checkNodeVersionCompatibility(nodeVersion: string = process.version): string | null {
  const match = /^v?(\d+)\./.exec(nodeVersion);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);

  if (major >= MIN_SUPPORTED_NODE_MAJOR && major <= MAX_SUPPORTED_NODE_MAJOR) return null;

  if (major > MAX_SUPPORTED_NODE_MAJOR) {
    return (
      `Running on Node.js ${nodeVersion}, newer than this fork's tested range (${MIN_SUPPORTED_NODE_MAJOR}-${MAX_SUPPORTED_NODE_MAJOR}). ` +
      "Node 24+ has a known zlib streaming issue that can make version installs hang forever during extraction " +
      "of larger zip entries. If installs hang at \"Extracting...\", switch to Node 22.x — note that as of late " +
      "2025 Node 24 is itself the \"LTS\" release line, so installing via a generic \"LTS\" label/alias will not " +
      "avoid this; pin an explicit 22.x install (e.g. via nvm-windows/fnm) instead."
    );
  }

  return (
    `Running on Node.js ${nodeVersion}, older than this fork's minimum supported version (${MIN_SUPPORTED_NODE_MAJOR}). ` +
    "Some features may not work correctly; please upgrade to Node 18 or later."
  );
}

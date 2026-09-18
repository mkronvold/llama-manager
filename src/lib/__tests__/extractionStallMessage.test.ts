import { describe, it, expect } from "vitest";
import { extractionStallMessage } from "../versions";

describe("extractionStallMessage", () => {
  it("blames slow disk / antivirus for shorter stalls", () => {
    const msg = extractionStallMessage(15000);
    expect(msg).toMatch(/antivirus/i);
    expect(msg).not.toMatch(/zlib/i);
  });

  it("mentions the known Node 24+ zlib hang for prolonged stalls", () => {
    const msg = extractionStallMessage(60000);
    expect(msg).toMatch(/zlib/i);
    expect(msg).toMatch(/Node\.js 24/i);
    expect(msg).toMatch(process.version);
  });
});

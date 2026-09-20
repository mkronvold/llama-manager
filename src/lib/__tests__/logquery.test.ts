import { describe, it, expect } from "vitest";
import { compileLogQuery } from "../logquery";

describe("compileLogQuery", () => {
  it("returns null for an empty/blank query", () => {
    expect(compileLogQuery("")).toBeNull();
    expect(compileLogQuery("   ")).toBeNull();
  });

  it("does plain case-insensitive substring matching when no operators are present", () => {
    const q = compileLogQuery("Tokens n_gen");
    expect(q).not.toBeNull();
    expect(q!("prompt eval: tokens n_gen=128")).toBe(true);
    expect(q!("TOKENS N_GEN done")).toBe(true);
    expect(q!("unrelated line")).toBe(false);
  });

  it("supports [and] to combine terms (both must be present)", () => {
    const q = compileLogQuery("tokens [and] n_gen")!;
    expect(q("tokens processed n_gen=5")).toBe(true);
    expect(q("tokens processed only")).toBe(false);
    expect(q("n_gen=5 only")).toBe(false);
  });

  it("supports [or] as a comma synonym", () => {
    const q = compileLogQuery("error [or] warning")!;
    expect(q("an error occurred")).toBe(true);
    expect(q("just a warning")).toBe(true);
    expect(q("all good")).toBe(false);
  });

  it("supports ! negation", () => {
    const q = compileLogQuery("!task")!;
    expect(q("no match here")).toBe(true);
    expect(q("task started")).toBe(false);
  });

  it("supports * wildcard for any run of characters", () => {
    const q = compileLogQuery("token*")!;
    expect(q("tokens=5")).toBe(true);
    expect(q("token")).toBe(true);
    expect(q("no match")).toBe(false);
  });

  it("supports . wildcard for any single character", () => {
    const q = compileLogQuery("t.ken")!;
    expect(q("token found")).toBe(true);
    expect(q("taken found")).toBe(true);
    expect(q("tken found")).toBe(false);
  });

  it("honors comma precedence: a, b, c -> a OR b OR c", () => {
    const q = compileLogQuery("a, b, c")!;
    expect(q("contains a in it")).toBe(true);
    expect(q("contains b in it")).toBe(true);
    expect(q("contains c in it")).toBe(true);
    expect(q("xyz only")).toBe(false);
  });

  it("honors comma precedence: a, b [and] c -> a OR (b AND c)", () => {
    const q = compileLogQuery("a, b [and] c")!;
    expect(q("only a")).toBe(true);
    expect(q("only b")).toBe(false);
    expect(q("both b and c")).toBe(true);
  });

  it("honors comma precedence: a [and] b, c -> (a AND b) OR c", () => {
    const q = compileLogQuery("a [and] b, c")!;
    expect(q("both a and b")).toBe(true);
    expect(q("only a")).toBe(false);
    expect(q("only c")).toBe(true);
  });

  it("treats {braced} terms as literal phrases with spaces", () => {
    const q = compileLogQuery("{prompt processing} [and] tokens")!;
    expect(q("prompt processing tokens=5")).toBe(true);
    expect(q("prompt tokens processing")).toBe(false);
  });

  it("treats \\. and \\* as literal escapes outside braces", () => {
    const q = compileLogQuery("model\\.gguf")!;
    expect(q("loaded model.gguf successfully")).toBe(true);
    expect(q("loaded modelXgguf")).toBe(false);
  });
});

// Shared query engine for the Logs tab's "find" (f) and "highlight" (h)
// features. Plain text with none of the operators below behaves exactly like
// the historical literal, case-insensitive substring match (backward
// compatible). When operators are present, the query is parsed as:
//
//   Query    = OrGroup ("," OrGroup)*
//   OrGroup  = Term ("[and]" Term)*
//   Term     = ["!"] (BraceLiteral | WildcardWord)
//
// "[or]" is accepted as a synonym for "," (same precedence) since both were
// requested. Comma/`[or]` bind the loosest (evaluated last), so:
//   "a, b, c"       -> a OR b OR c
//   "a, b [and] c"  -> a OR (b AND c)
//   "a [and] b, c"  -> (a AND b) OR c
//
// Outside `{...}` braces, "*" matches any run of characters and "." matches
// any single character (both compiled per-term into a case-insensitive
// regex, escaping all other regex metacharacters); "\." / "\*" escape a
// literal dot/star. `{...}` braces make their contents a literal phrase
// (useful for multi-word terms, since bare spaces are not a delimiter, and
// for literal text containing operator characters).
//
// A bare "*" or "." alone (e.g. "token*") already activates this parser per
// the original request - a literal "." or "*" in that case needs "\." /
// "\*" or "{...}" to be taken literally.

export type LogQueryPredicate = (line: string) => boolean;

interface ParsedTerm {
  negate: boolean;
  regex: RegExp;
}

const OPERATOR_HINT_RE = /[!,*{.]/;
const AND_TOKEN_RE = /\[and\]/i;
const OR_TOKEN_RE = /\[or\]/i;
const AND_TOKEN_STICKY_RE = /\[and\]/iy;
const OR_TOKEN_STICKY_RE = /\[or\]/iy;

function usesQueryOperators(raw: string): boolean {
  return OPERATOR_HINT_RE.test(raw) || AND_TOKEN_RE.test(raw) || OR_TOKEN_RE.test(raw);
}

function escapeRegexChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits `input` on top-level occurrences of `,` or the case-insensitive
 *  `[or]` token, never splitting inside `{...}` braces. */
function splitTopLevelOr(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (let i = 0; i < input.length; ) {
    const char = input[i]!;
    if (char === "{") { braceDepth++; current += char; i++; continue; }
    if (char === "}") { if (braceDepth > 0) braceDepth--; current += char; i++; continue; }
    if (braceDepth === 0) {
      if (char === ",") { parts.push(current); current = ""; i++; continue; }
      OR_TOKEN_STICKY_RE.lastIndex = i;
      if (OR_TOKEN_STICKY_RE.test(input)) { parts.push(current); current = ""; i += 4; continue; }
    }
    current += char;
    i++;
  }
  parts.push(current);
  return parts;
}

/** Splits `input` on top-level occurrences of the case-insensitive `[and]`
 *  token, never splitting inside `{...}` braces. */
function splitTopLevelAnd(input: string): string[] {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  for (let i = 0; i < input.length; ) {
    const char = input[i]!;
    if (char === "{") { braceDepth++; current += char; i++; continue; }
    if (char === "}") { if (braceDepth > 0) braceDepth--; current += char; i++; continue; }
    if (braceDepth === 0) {
      AND_TOKEN_STICKY_RE.lastIndex = i;
      if (AND_TOKEN_STICKY_RE.test(input)) { parts.push(current); current = ""; i += 5; continue; }
    }
    current += char;
    i++;
  }
  parts.push(current);
  return parts;
}

/** Compiles a single term (already trimmed of surrounding whitespace and any
 *  leading "!") into a case-insensitive regex source, honoring `{...}`
 *  literal wrapping and `*`/`.` wildcards with `\*`/`\.` escapes. */
function compileTermRegexSource(term: string): string {
  const trimmed = term.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return escapeRegexChar(trimmed.slice(1, -1));
  }

  let source = "";
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (char === "\\" && (trimmed[i + 1] === "." || trimmed[i + 1] === "*")) {
      source += escapeRegexChar(trimmed[i + 1]!);
      i++;
      continue;
    }
    if (char === ".") { source += "."; continue; }
    if (char === "*") { source += ".*"; continue; }
    source += escapeRegexChar(char);
  }
  return source;
}

function compileTerm(rawTerm: string): ParsedTerm | null {
  let term = rawTerm.trim();
  let negate = false;
  if (term.startsWith("!")) {
    negate = true;
    term = term.slice(1).trim();
  }
  if (!term) return null;
  const source = compileTermRegexSource(term);
  if (!source) return null;
  return { negate, regex: new RegExp(source, "i") };
}

/** Compiles `raw` into a predicate that tests whether a log line matches.
 *  Returns null if the query is empty/has no usable terms. */
export function compileLogQuery(raw: string): LogQueryPredicate | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (!usesQueryOperators(trimmed)) {
    const needle = trimmed.toLowerCase();
    return (line: string) => line.toLowerCase().includes(needle);
  }

  const orGroups: ParsedTerm[][] = [];
  for (const groupText of splitTopLevelOr(trimmed)) {
    const terms: ParsedTerm[] = [];
    for (const termText of splitTopLevelAnd(groupText)) {
      const compiled = compileTerm(termText);
      if (compiled) terms.push(compiled);
    }
    if (terms.length > 0) orGroups.push(terms);
  }

  if (orGroups.length === 0) return null;

  return (line: string) => {
    for (const group of orGroups) {
      let allMatch = true;
      for (const term of group) {
        const matched = term.regex.test(line);
        if (matched === term.negate) { allMatch = false; break; }
      }
      if (allMatch) return true;
    }
    return false;
  };
}

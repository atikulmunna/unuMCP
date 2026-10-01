import ts from "typescript";

/**
 * The executable view of a TS/JS source: its comments and documentation
 * strings blanked out with spaces (newlines kept, so every offset, line, and
 * column still matches the original). Behavioural rules (exfiltration hosts,
 * eval/shell, obfuscation) run on this view, so a docs link inside a schema
 * description no longer reads as a network call, while code is scanned as
 * before.
 *
 * A documentation string is a plain string literal that is
 *   - an argument of `.describe(...)` (Zod schema docs),
 *   - the description argument of `.tool(name, description, ...)` (MCP SDK), or
 *   - the value of a `description` or `title` property.
 * Template literals with `${}` expressions are never treated as documentation.
 *
 * Returns `null` when the file does not parse cleanly: callers then scan the
 * raw text, so malformed input is never scanned less strictly.
 */
export function codeView(path: string, content: string): string | null {
  return sourceViews(path, content)?.code ?? null;
}

export interface SourceViews {
  /** What can execute: comments and documentation strings blanked. */
  code: string;
  /** Only the documentation strings (agent-facing text); everything else blanked. */
  docs: string;
}

/**
 * Both views of a TS/JS source, offset-for-offset with the original (see
 * {@link codeView}). `docs` holds the text an MCP client hands to the agent
 * (tool and field descriptions), which matters on its own: it can carry
 * instructions aimed at the agent. Returns `null` when the file doesn't parse.
 */
export function sourceViews(path: string, content: string): SourceViews | null {
  const kind = /\.[cm]?jsx?$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  // `parseDiagnostics` is internal but long-stable; any syntax error means the
  // AST may not reflect what a runtime would execute, so don't trust the mask.
  const syntaxErrors = (source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (syntaxErrors === undefined || syntaxErrors.length > 0) return null;

  const code = content.split("");
  const docRanges: Array<[number, number]> = [];
  const blank = (chars: string[], start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };

  // Comments: the parser attaches them as trivia around tokens, which (unlike a
  // raw scan) can't be fooled by `//` inside a string or regex literal.
  const visitTokens = (node: ts.Node) => {
    for (const range of ts.getLeadingCommentRanges(content, node.pos) ?? []) blank(code, range.pos, range.end);
    for (const range of ts.getTrailingCommentRanges(content, node.end) ?? []) blank(code, range.pos, range.end);
    for (const child of node.getChildren(source)) visitTokens(child);
  };
  visitTokens(source);

  const visitAst = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isDocString(node)) {
      const range: [number, number] = [node.getStart(source) + 1, node.end - 1]; // inside the quotes
      blank(code, ...range);
      docRanges.push(range);
    }
    ts.forEachChild(node, visitAst);
  };
  visitAst(source);

  const docs = content.split("");
  blank(docs, 0, docs.length);
  for (const [start, end] of docRanges) {
    for (let i = start; i < end; i++) docs[i] = content[i]!;
  }

  return { code: code.join(""), docs: docs.join("") };
}

function isDocString(literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): boolean {
  const parent = literal.parent;
  if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    const index = parent.arguments.indexOf(literal);
    if (method === "describe" && index >= 0) return true;
    if (method === "tool" && index === 1 && parent.arguments.length >= 3) return true;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === literal) {
    const key = ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name) ? parent.name.text : "";
    return key === "description" || key === "title";
  }
  return false;
}

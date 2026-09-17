/**
 * Safe expression evaluator for workflow guards — a CEL-flavored subset (D1).
 *
 * Non-Turing-complete by construction (no user loops/recursion/IO), so every
 * expression terminates. Supports: number/string/bool/null literals, member
 * access (`a.b.c`), indexing (`a[0]`), the arithmetic / comparison / equality /
 * logical / unary / ternary operators, and the `size()` and `has()` builtins.
 *
 * Resolution: a top-level identifier missing from the context throws; member
 * access on an absent field yields `undefined` (so `has()` can probe softly).
 * Swapping in a full CEL host later is possible without changing call sites.
 */

export type CelValue = unknown;

type Token =
  | { t: "num"; n: number }
  | { t: "str"; s: string }
  | { t: "ident"; s: string }
  | { t: "op"; s: string }
  | { t: "eof" };

const OPS3 = ["&&", "||", "==", "!=", "<=", ">="];

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] ?? "";
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c >= "0" && c <= "9") {
      const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
      const lit = m ? m[0] : c;
      tokens.push({ t: "num", n: Number(lit) });
      i += lit.length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== c) {
        s += src[j];
        j++;
      }
      if (j >= n) {
        throw new Error("CEL: unterminated string literal");
      }
      tokens.push({ t: "str", s });
      i = j + 1;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
      const word = m ? m[0] : c;
      tokens.push({ t: "ident", s: word });
      i += word.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS3.includes(two)) {
      tokens.push({ t: "op", s: two });
      i += 2;
      continue;
    }
    if ("()[],.?:!<>+-*/%".includes(c)) {
      tokens.push({ t: "op", s: c });
      i++;
      continue;
    }
    throw new Error(`CEL: unexpected character "${c}"`);
  }
  tokens.push({ t: "eof" });
  return tokens;
}

type Node =
  | { k: "lit"; v: CelValue }
  | { k: "id"; name: string }
  | { k: "member"; obj: Node; key: string }
  | { k: "index"; obj: Node; idx: Node }
  | { k: "call"; name: string; args: Node[] }
  | { k: "list"; items: Node[] }
  | { k: "unary"; op: string; e: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "ternary"; c: Node; a: Node; b: Node };

class Parser {
  private pos = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.pos] ?? { t: "eof" };
  }
  private next(): Token {
    const t = this.peek();
    this.pos++;
    return t;
  }
  private eatOp(s: string): void {
    const t = this.peek();
    if (t.t !== "op" || t.s !== s) {
      throw new Error(`CEL: expected "${s}"`);
    }
    this.pos++;
  }
  private isOp(s: string): boolean {
    const t = this.peek();
    return t.t === "op" && t.s === s;
  }

  parse(): Node {
    const e = this.ternary();
    if (this.peek().t !== "eof") {
      throw new Error("CEL: trailing tokens after expression");
    }
    return e;
  }

  private ternary(): Node {
    const c = this.or();
    if (this.isOp("?")) {
      this.eatOp("?");
      const a = this.ternary();
      this.eatOp(":");
      const b = this.ternary();
      return { k: "ternary", c, a, b };
    }
    return c;
  }
  private or(): Node {
    let l = this.and();
    while (this.isOp("||")) {
      this.eatOp("||");
      l = { k: "bin", op: "||", l, r: this.and() };
    }
    return l;
  }
  private and(): Node {
    let l = this.equality();
    while (this.isOp("&&")) {
      this.eatOp("&&");
      l = { k: "bin", op: "&&", l, r: this.equality() };
    }
    return l;
  }
  private equality(): Node {
    let l = this.comparison();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = (this.next() as { s: string }).s;
      l = { k: "bin", op, l, r: this.comparison() };
    }
    return l;
  }
  private comparison(): Node {
    let l = this.additive();
    while (this.isOp("<") || this.isOp("<=") || this.isOp(">") || this.isOp(">=")) {
      const op = (this.next() as { s: string }).s;
      l = { k: "bin", op, l, r: this.additive() };
    }
    return l;
  }
  private additive(): Node {
    let l = this.multiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.next() as { s: string }).s;
      l = { k: "bin", op, l, r: this.multiplicative() };
    }
    return l;
  }
  private multiplicative(): Node {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = (this.next() as { s: string }).s;
      l = { k: "bin", op, l, r: this.unary() };
    }
    return l;
  }
  private unary(): Node {
    if (this.isOp("!") || this.isOp("-")) {
      const op = (this.next() as { s: string }).s;
      return { k: "unary", op, e: this.unary() };
    }
    return this.postfix();
  }
  private postfix(): Node {
    let e = this.primary();
    for (;;) {
      if (this.isOp(".")) {
        this.eatOp(".");
        const t = this.next();
        if (t.t !== "ident") {
          throw new Error("CEL: expected field name after '.'");
        }
        e = { k: "member", obj: e, key: t.s };
      } else if (this.isOp("[")) {
        this.eatOp("[");
        const idx = this.ternary();
        this.eatOp("]");
        e = { k: "index", obj: e, idx };
      } else {
        return e;
      }
    }
  }
  private primary(): Node {
    const t = this.next();
    if (t.t === "num") {
      return { k: "lit", v: t.n };
    }
    if (t.t === "str") {
      return { k: "lit", v: t.s };
    }
    if (t.t === "ident") {
      if (t.s === "true") {
        return { k: "lit", v: true };
      }
      if (t.s === "false") {
        return { k: "lit", v: false };
      }
      if (t.s === "null") {
        return { k: "lit", v: null };
      }
      if (this.isOp("(")) {
        this.eatOp("(");
        const args: Node[] = [];
        if (!this.isOp(")")) {
          args.push(this.ternary());
          while (this.isOp(",")) {
            this.eatOp(",");
            args.push(this.ternary());
          }
        }
        this.eatOp(")");
        return { k: "call", name: t.s, args };
      }
      return { k: "id", name: t.s };
    }
    if (t.t === "op" && t.s === "(") {
      const e = this.ternary();
      this.eatOp(")");
      return e;
    }
    if (t.t === "op" && t.s === "[") {
      const items: Node[] = [];
      if (!this.isOp("]")) {
        items.push(this.ternary());
        while (this.isOp(",")) {
          this.eatOp(",");
          items.push(this.ternary());
        }
      }
      this.eatOp("]");
      return { k: "list", items };
    }
    throw new Error("CEL: unexpected token in expression");
  }
}

const MISSING = Symbol("missing");

function evalNode(node: Node, ctx: Record<string, CelValue>): CelValue {
  switch (node.k) {
    case "lit":
      return node.v;
    case "id": {
      if (!(node.name in ctx)) {
        throw new Error(`CEL: unknown identifier "${node.name}"`);
      }
      return ctx[node.name];
    }
    case "member": {
      const obj = evalNode(node.obj, ctx);
      if (obj === null || typeof obj !== "object") {
        return undefined;
      }
      return (obj as Record<string, CelValue>)[node.key];
    }
    case "index": {
      const obj = evalNode(node.obj, ctx);
      const idx = evalNode(node.idx, ctx);
      if (Array.isArray(obj) && typeof idx === "number") {
        return obj[idx];
      }
      if (obj !== null && typeof obj === "object" && typeof idx === "string") {
        return (obj as Record<string, CelValue>)[idx];
      }
      return undefined;
    }
    case "list":
      return node.items.map((item) => evalNode(item, ctx));
    case "call":
      return evalCall(node, ctx);
    case "unary": {
      const v = evalNode(node.e, ctx);
      return node.op === "!" ? !truthy(v) : -toNum(v);
    }
    case "bin":
      return evalBin(node, ctx);
    case "ternary":
      return truthy(evalNode(node.c, ctx)) ? evalNode(node.a, ctx) : evalNode(node.b, ctx);
  }
}

function evalCall(node: Extract<Node, { k: "call" }>, ctx: Record<string, CelValue>): CelValue {
  if (node.name === "size") {
    const arg = node.args[0];
    if (node.args.length !== 1 || !arg) {
      throw new Error("CEL: size() takes one argument");
    }
    const v = evalNode(arg, ctx);
    if (typeof v === "string" || Array.isArray(v)) {
      return v.length;
    }
    if (v !== null && typeof v === "object") {
      return Object.keys(v).length;
    }
    throw new Error("CEL: size() argument has no length");
  }
  if (node.name === "has") {
    const arg = node.args[0];
    if (node.args.length !== 1 || !arg) {
      throw new Error("CEL: has() takes one argument");
    }
    let v: CelValue | typeof MISSING = MISSING;
    try {
      v = evalNode(arg, ctx);
    } catch {
      return false;
    }
    return v !== undefined && v !== MISSING;
  }
  if (node.name === "string") {
    const arg = node.args[0];
    if (node.args.length !== 1 || !arg) {
      throw new Error("CEL: string() takes one argument");
    }
    const v = evalNode(arg, ctx);
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return String(v);
    }
    throw new Error("CEL: string() expects a string, number, or bool");
  }
  throw new Error(`CEL: unknown function "${node.name}"`);
}

function evalBin(node: Extract<Node, { k: "bin" }>, ctx: Record<string, CelValue>): CelValue {
  if (node.op === "&&") {
    return truthy(evalNode(node.l, ctx)) && truthy(evalNode(node.r, ctx));
  }
  if (node.op === "||") {
    return truthy(evalNode(node.l, ctx)) || truthy(evalNode(node.r, ctx));
  }
  const l = evalNode(node.l, ctx);
  const r = evalNode(node.r, ctx);
  switch (node.op) {
    case "==":
      return l === r;
    case "!=":
      return l !== r;
    case "<":
      return toNum(l) < toNum(r);
    case "<=":
      return toNum(l) <= toNum(r);
    case ">":
      return toNum(l) > toNum(r);
    case ">=":
      return toNum(l) >= toNum(r);
    case "+":
      return typeof l === "string" || typeof r === "string"
        ? String(l) + String(r)
        : toNum(l) + toNum(r);
    case "-":
      return toNum(l) - toNum(r);
    case "*":
      return toNum(l) * toNum(r);
    case "/":
      return toNum(l) / toNum(r);
    case "%":
      return toNum(l) % toNum(r);
    default:
      throw new Error(`CEL: unknown operator "${node.op}"`);
  }
}

function truthy(v: CelValue): boolean {
  return v === true;
}

function toNum(v: CelValue): number {
  if (typeof v !== "number") {
    throw new Error("CEL: expected a number");
  }
  return v;
}

/** Parse and evaluate a guard expression against a read-only context. */
export function evalCel(expr: string, ctx: Record<string, CelValue>): CelValue {
  const ast = new Parser(lex(expr)).parse();
  return evalNode(ast, ctx);
}

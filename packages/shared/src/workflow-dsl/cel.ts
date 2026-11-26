/**
 * Safe expression evaluator for workflow guards — a CEL-flavored subset (D1).
 *
 * List comprehensions share a bounded evaluation budget, so every
 * expression terminates. Supports: number/string/bool/null literals, member
 * access (`a.b.c`), indexing (`a[0]`), the arithmetic / comparison / equality /
 * logical / unary / ternary operators, and the `size()` and `has()` builtins.
 *
 * Resolution: a top-level identifier missing from the context throws; member
 * access on an absent field yields `undefined` (so `has()` can probe softly).
 * Map lookup is restricted to own fields. Expressions cannot invoke host methods.
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
        if (src[j] === "\\") {
          const escaped = src[++j];
          const escapes: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            '"': '"',
            "'": "'",
            "\\": "\\",
          };
          if (escaped === undefined || !Object.hasOwn(escapes, escaped))
            throw new Error("CEL: invalid string escape");
          s += escapes[escaped];
        } else s += src[j];
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
    if ("()[]{},.?:!<>+-*/%".includes(c)) {
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
  | { k: "map"; entries: [string, Node][] }
  | { k: "method"; obj: Node; name: string; args: Node[] }
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
  private isIn(): boolean {
    const t = this.peek();
    return t.t === "ident" && t.s === "in";
  }
  private comparison(): Node {
    let l = this.additive();
    while (this.isIn() || this.isOp("<") || this.isOp("<=") || this.isOp(">") || this.isOp(">=")) {
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
        e = this.isOp("(")
          ? { k: "method", obj: e, name: t.s, args: this.args() }
          : { k: "member", obj: e, key: t.s };
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
  private args(): Node[] {
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
    return args;
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
        return { k: "call", name: t.s, args: this.args() };
      }
      return { k: "id", name: t.s };
    }
    if (t.t === "op" && t.s === "(") {
      const e = this.ternary();
      this.eatOp(")");
      return e;
    }
    if (t.t === "op" && t.s === "{") {
      const entries: [string, Node][] = [];
      const keys = new Set<string>();
      while (!this.isOp("}")) {
        const key = this.next();
        if (key.t !== "str" || keys.has(key.s))
          throw new Error("CEL: expected unique string map key");
        keys.add(key.s);
        this.eatOp(":");
        entries.push([key.s, this.ternary()]);
        if (!this.isOp(",")) break;
        this.eatOp(",");
      }
      this.eatOp("}");
      return { k: "map", entries };
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
class CelBudgetExceeded extends Error {}
type EvaluationBudget = { remaining: number };
function charge(budget: EvaluationBudget, cost = 1) {
  budget.remaining -= cost;
  if (budget.remaining < 0)
    throw new CelBudgetExceeded("CEL: expression evaluation limit exceeded");
}
const mathFunctions = new Map<string, { arity: number; fn: (...args: number[]) => number }>([
  ["abs", { arity: 1, fn: Math.abs }],
  ["floor", { arity: 1, fn: Math.floor }],
  ["ceil", { arity: 1, fn: Math.ceil }],
  ["round", { arity: 1, fn: Math.round }],
  ["sqrt", { arity: 1, fn: Math.sqrt }],
  ["pow", { arity: 2, fn: Math.pow }],
  ["min", { arity: 2, fn: Math.min }],
  ["max", { arity: 2, fn: Math.max }],
]);

function evalNode(node: Node, ctx: Record<string, CelValue>, budget: EvaluationBudget): CelValue {
  charge(budget);
  switch (node.k) {
    case "lit":
      return node.v;
    case "id": {
      if (!Object.hasOwn(ctx, node.name)) {
        throw new Error(`CEL: unknown identifier "${node.name}"`);
      }
      return ctx[node.name];
    }
    case "member": {
      const obj = evalNode(node.obj, ctx, budget);
      if (obj === null || typeof obj !== "object") {
        return undefined;
      }
      return Object.hasOwn(obj, node.key) ? (obj as Record<string, CelValue>)[node.key] : undefined;
    }
    case "index": {
      const obj = evalNode(node.obj, ctx, budget);
      const idx = evalNode(node.idx, ctx, budget);
      if (Array.isArray(obj) && typeof idx === "number") {
        return obj[idx];
      }
      if (obj !== null && typeof obj === "object" && typeof idx === "string") {
        return Object.hasOwn(obj, idx) ? (obj as Record<string, CelValue>)[idx] : undefined;
      }
      return undefined;
    }
    case "map":
      return Object.fromEntries(
        node.entries.map(([key, value]) => [key, evalNode(value, ctx, budget)]),
      );
    case "method": {
      if (node.obj.k === "id" && node.obj.name === "math") {
        const fn = mathFunctions.get(node.name);
        if (!fn || node.args.length !== fn.arity)
          throw new Error("CEL: unknown math function or wrong arity");
        const result = fn.fn(...node.args.map((arg) => toNum(evalNode(arg, ctx, budget))));
        if (!Number.isFinite(result)) throw new Error("CEL: non-finite math result");
        return result;
      }
      const receiver = evalNode(node.obj, ctx, budget);
      if (node.name === "map" || node.name === "filter") {
        const [variable, body] = node.args;
        if (!Array.isArray(receiver) || variable?.k !== "id" || !body || node.args.length !== 2)
          throw new Error("CEL: map/filter require a list, a variable and an expression");
        charge(budget, receiver.length);
        const local = { ...ctx, [variable.name]: null };
        const output = [];
        for (const item of receiver) {
          local[variable.name] = item;
          const result = evalNode(body, local, budget);
          if (node.name === "map") output.push(result);
          else if (typeof result !== "boolean")
            throw new Error("CEL: filter predicate must return a boolean");
          else if (result) output.push(item);
        }
        return output;
      }
      const [argument] = node.args;
      if (typeof receiver !== "string" || !argument || node.args.length !== 1)
        throw new Error("CEL: string method requires a string argument");
      const value = evalNode(argument, ctx, budget);
      if (typeof value !== "string") throw new Error("CEL: expected a string");
      charge(budget, receiver.length + value.length);
      if (node.name === "contains") return receiver.includes(value);
      if (node.name === "startsWith") return receiver.startsWith(value);
      if (node.name === "endsWith") return receiver.endsWith(value);
      throw new Error(`CEL: unknown string method "${node.name}"`);
    }
    case "list":
      return node.items.map((item) => evalNode(item, ctx, budget));
    case "call":
      return evalCall(node, ctx, budget);
    case "unary": {
      const v = evalNode(node.e, ctx, budget);
      return node.op === "!" ? !truthy(v) : -toNum(v);
    }
    case "bin":
      return evalBin(node, ctx, budget);
    case "ternary":
      return truthy(evalNode(node.c, ctx, budget))
        ? evalNode(node.a, ctx, budget)
        : evalNode(node.b, ctx, budget);
  }
}

function evalCall(
  node: Extract<Node, { k: "call" }>,
  ctx: Record<string, CelValue>,
  budget: EvaluationBudget,
): CelValue {
  if (node.name === "size") {
    const arg = node.args[0];
    if (node.args.length !== 1 || !arg) {
      throw new Error("CEL: size() takes one argument");
    }
    const v = evalNode(arg, ctx, budget);
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
      v = evalNode(arg, ctx, budget);
    } catch (error) {
      if (error instanceof CelBudgetExceeded) throw error;
      return false;
    }
    return v !== undefined && v !== MISSING;
  }
  if (node.name === "string") {
    const arg = node.args[0];
    if (node.args.length !== 1 || !arg) {
      throw new Error("CEL: string() takes one argument");
    }
    const v = evalNode(arg, ctx, budget);
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      return String(v);
    }
    throw new Error("CEL: string() expects a string, number, or bool");
  }
  throw new Error(`CEL: unknown function "${node.name}"`);
}

function evalBin(
  node: Extract<Node, { k: "bin" }>,
  ctx: Record<string, CelValue>,
  budget: EvaluationBudget,
): CelValue {
  if (node.op === "&&") {
    return truthy(evalNode(node.l, ctx, budget)) && truthy(evalNode(node.r, ctx, budget));
  }
  if (node.op === "||") {
    return truthy(evalNode(node.l, ctx, budget)) || truthy(evalNode(node.r, ctx, budget));
  }
  const l = evalNode(node.l, ctx, budget);
  const r = evalNode(node.r, ctx, budget);
  switch (node.op) {
    case "in":
      if (Array.isArray(r)) {
        charge(budget, r.length);
        return r.includes(l);
      }
      if (r !== null && typeof r === "object" && typeof l === "string") return Object.hasOwn(r, l);
      throw new Error("CEL: in requires a list or a string-keyed map");
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
    case "+": {
      if (typeof l !== "string" && typeof r !== "string") return toNum(l) + toNum(r);
      if ((l !== null && typeof l === "object") || (r !== null && typeof r === "object"))
        throw new Error("CEL: string concatenation requires scalars");
      const left = String(l);
      const right = String(r);
      charge(budget, left.length + right.length);
      return left + right;
    }
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
  const budget = { remaining: 1_000_000 };
  const value = evalNode(ast, ctx, budget);
  // A map can emit the same large input many times. Consumers serialize each
  // occurrence, so account for the expanded result, including repeated references.
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") charge(budget, item.length);
    else if (Array.isArray(item)) {
      charge(budget, item.length + 1);
      for (const child of item) pending.push(child);
    } else if (item !== null && typeof item === "object") {
      charge(budget);
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        charge(budget, key.length + 1);
        pending.push((item as Record<string, unknown>)[key]);
      }
    }
  }
  return value;
}

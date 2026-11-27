import type { Shape } from "./types.js";

/** Infer a structural shape from a JSON sample. */
export function inferShape(value: unknown, depth = 0): Shape {
  if (depth > 8) return { kind: "unknown" };
  if (value === null || value === undefined) return { kind: "null" };
  if (Array.isArray(value)) {
    let items: Shape | undefined;
    for (const v of value.slice(0, 20)) {
      const s = inferShape(v, depth + 1);
      items = items ? mergeShapes(items, s) : s;
    }
    return { kind: "array", items: items ?? { kind: "unknown" } };
  }
  switch (typeof value) {
    case "string":
      return { kind: "string" };
    case "number":
      return { kind: Number.isInteger(value) ? "integer" : "number" };
    case "boolean":
      return { kind: "boolean" };
    case "object": {
      const props: Record<string, Shape> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) props[k] = inferShape(v, depth + 1);
      return { kind: "object", props };
    }
    default:
      return { kind: "unknown" };
  }
}

/** Merge two shapes observed for the same value position. */
export function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.kind === "null") return b;
  if (b.kind === "null") return a;
  if (a.kind === b.kind) {
    if (a.kind === "array" && b.kind === "array") return { kind: "array", items: mergeShapes(a.items, b.items) };
    if (a.kind === "object" && b.kind === "object") {
      const props: Record<string, Shape> = { ...a.props };
      for (const [k, v] of Object.entries(b.props)) props[k] = props[k] ? mergeShapes(props[k]!, v) : v;
      return { kind: "object", props };
    }
    return a;
  }
  const numeric = new Set(["integer", "number"]);
  if (numeric.has(a.kind) && numeric.has(b.kind)) return { kind: "number" };
  return { kind: "unknown" };
}

/** Infer the type of a string value coming from a query string / form field. */
export function inferScalarShape(values: string[]): Shape {
  const vs = values.filter((v) => v !== "");
  if (vs.length === 0) return { kind: "string" };
  if (vs.every((v) => /^-?\d{1,15}$/.test(v) && !(v.length > 1 && v.startsWith("0")))) return { kind: "integer" };
  if (vs.every((v) => /^-?\d+\.\d+$/.test(v))) return { kind: "number" };
  if (vs.every((v) => v === "true" || v === "false")) return { kind: "boolean" };
  return { kind: "string" };
}

/** Human readable one-line summary of a shape, e.g. `{ items: [{ id, name, price }], total }`. */
export function describeShape(shape: Shape, depth = 0): string {
  switch (shape.kind) {
    case "object": {
      const keys = Object.keys(shape.props);
      if (depth >= 2) return keys.length ? `{ ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""} }` : "{}";
      const parts = keys.slice(0, 8).map((k) => {
        const s = shape.props[k]!;
        return s.kind === "object" || s.kind === "array" ? `${k}: ${describeShape(s, depth + 1)}` : k;
      });
      return `{ ${parts.join(", ")}${keys.length > 8 ? ", …" : ""} }`;
    }
    case "array":
      return `[${describeShape(shape.items, depth + 1)}]`;
    default:
      return shape.kind;
  }
}

/** Keep samples small: cut arrays to `maxItems` and long strings to `maxString`. */
export function trimSample(value: unknown, maxItems = 3, maxString = 500, depth = 0): unknown {
  if (depth > 10) return null;
  if (Array.isArray(value)) return value.slice(0, maxItems).map((v) => trimSample(v, maxItems, maxString, depth + 1));
  if (typeof value === "string") return value.length > maxString ? value.slice(0, maxString) + "…" : value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = trimSample(v, maxItems, maxString, depth + 1);
    return out;
  }
  return value;
}

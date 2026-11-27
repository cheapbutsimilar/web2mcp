import { describeShape, inferScalarShape, inferShape, mergeShapes } from "./shape.js";
import type { CapturedRequest, Session, Shape, ToolParam, ToolSpec, UserAction } from "./types.js";

// ---------------------------------------------------------------------------
// Path templating
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Does a path segment look like an identifier rather than a resource name? */
export function isIdSegment(seg: string): boolean {
  if (/^\d+$/.test(seg)) return true;
  if (UUID.test(seg)) return true;
  if (/^[0-9a-f]{12,}$/i.test(seg) && /\d/.test(seg)) return true;
  // long opaque tokens / slugs with digits, e.g. "AbC123xYz0987" or "blue-shirt-1234"
  if (seg.length >= 10 && /\d/.test(seg) && /[a-z]/i.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg)) return true;
  return false;
}

export function singular(word: string): string {
  if (/ies$/i.test(word)) return word.slice(0, -3) + "y";
  if (/(sses|xes|ches|shes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1);
  return word;
}

export function camel(input: string): string {
  const parts = input.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1))).join("");
}

export function snake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export interface PathTemplate {
  template: string;
  /** Names of path params in order, with their segment index. */
  params: { name: string; index: number }[];
  segments: string[];
}

export function templatePath(pathname: string): PathTemplate {
  const segments = pathname.split("/").filter((s) => s !== "");
  const params: { name: string; index: number }[] = [];
  const used = new Set<string>();
  const out = segments.map((seg, i) => {
    const decoded = safeDecode(seg);
    if (!isIdSegment(decoded)) return seg;
    const prev = i > 0 ? segments[i - 1]! : "";
    let name = prev && !isIdSegment(prev) ? camel(singular(prev)) + "Id" : "id";
    if (!/^[A-Za-z_]/.test(name)) name = "id";
    let unique = name;
    for (let n = 2; used.has(unique); n++) unique = `${name}${n}`;
    used.add(unique);
    params.push({ name: unique, index: i });
    return `{${unique}}`;
  });
  return { template: "/" + out.join("/"), params, segments };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface Group {
  key: string;
  method: string;
  origin: string;
  path: PathTemplate;
  graphqlOperation?: string;
  requests: CapturedRequest[];
}

function graphqlOperationOf(req: CapturedRequest): string | undefined {
  const json = req.body?.json as Record<string, unknown> | undefined;
  if (!/graphql/i.test(req.url) || !json || typeof json !== "object" || Array.isArray(json)) return undefined;
  if (typeof json.operationName === "string" && json.operationName) return json.operationName;
  if (typeof json.query === "string") {
    const m = /^\s*(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(json.query);
    if (m) return m[1];
  }
  return undefined;
}

export function groupRequests(requests: CapturedRequest[]): Group[] {
  const groups = new Map<string, Group>();
  for (const req of requests) {
    const url = new URL(req.url);
    const path = templatePath(url.pathname);
    const op = graphqlOperationOf(req);
    const key = `${req.method} ${url.origin}${path.template}${op ? `#${op}` : ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, method: req.method, origin: url.origin, path, graphqlOperation: op, requests: [] };
      groups.set(key, g);
    }
    g.requests.push(req);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const NOISE_SEGMENTS = /^(api|apis|rest|v\d+(\.\d+)?|public|ajax|json|services?|svc|internal|web|graphql|gql|rpc|endpoint|data)$/i;

const ACTION_WORDS = [
  "search", "find", "query", "lookup", "autocomplete", "suggest", "list", "get", "fetch", "load",
  "create", "add", "new", "update", "edit", "save", "set", "remove", "delete", "login", "logout",
  "signin", "signup", "register", "submit", "send", "check", "verify", "subscribe", "like", "follow",
  "upload", "download", "export", "import", "start", "stop", "cancel", "confirm", "apply", "book",
];

const SEARCH_PARAMS = /^(q|query|keyword|keywords|search|term|text|searchterm|search_query|k)$/i;

function responseIsList(shape: Shape | undefined): boolean {
  if (!shape) return false;
  if (shape.kind === "array") return true;
  if (shape.kind === "object") return Object.values(shape.props).some((s) => s.kind === "array" && s.items.kind === "object");
  return false;
}

export function toolNameFor(g: Pick<Group, "method" | "path" | "graphqlOperation">, query: string[], responseShape?: Shape): string {
  if (g.graphqlOperation) return snake(g.graphqlOperation).slice(0, 64) || "graphql_query";
  const segs = g.path.segments
    .map((s, i) => (g.path.params.some((p) => p.index === i) ? null : snake(safeDecode(s))))
    .filter((s): s is string => !!s && !NOISE_SEGMENTS.test(s));
  const endsWithParam = g.path.params.some((p) => p.index === g.path.segments.length - 1);

  let resource = segs.slice(-3);
  const last = resource[resource.length - 1];
  let verb: string | undefined;
  if (last) {
    const head = last.split("_")[0]!;
    if (ACTION_WORDS.includes(head)) {
      verb = last;
      resource = resource.slice(0, -1);
    }
  }
  if (!verb) {
    const m = g.method.toUpperCase();
    // `/notes/{noteId}` addresses a single item → singular resource name
    if (endsWithParam && resource.length) resource[resource.length - 1] = singular(resource[resource.length - 1]!);
    if (m === "GET" || m === "HEAD") {
      if (endsWithParam) verb = "get";
      else if (query.some((q) => SEARCH_PARAMS.test(q))) verb = "search";
      else verb = responseIsList(responseShape) ? "list" : "get";
    } else if (m === "POST") verb = endsWithParam ? "update" : "create";
    else if (m === "PUT" || m === "PATCH") verb = "update";
    else if (m === "DELETE") verb = "delete";
    else verb = m.toLowerCase();
  }
  const name = [verb, ...resource].filter(Boolean).join("_") || "call_root";
  return name.replace(/_+/g, "_").slice(0, 64);
}

function titleFromName(name: string): string {
  const s = name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

function sanitizeArg(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  if (!s || /^\d/.test(s)) s = `p_${s}`;
  return s.slice(0, 64);
}

function fmt(v: unknown): string {
  const s = JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + "…" : String(s);
}

function scalarParams(
  location: "query" | "form",
  samples: Record<string, string>[],
  secret: Set<string>,
): ToolParam[] {
  const names = [...new Set(samples.flatMap((s) => Object.keys(s)))].filter((n) => !secret.has(n));
  return names.map((name) => {
    const values = samples.map((s) => s[name]).filter((v): v is string => v !== undefined);
    const redacted = values.some((v) => v === "<redacted>");
    const shape = inferScalarShape(values.filter((v) => v !== "<redacted>"));
    const distinct = [...new Set(values)];
    const inAll = values.length === samples.length;
    const last = values[values.length - 1];
    const example = redacted || last === undefined ? undefined : coerce(last, shape);
    const label = location === "query" ? "Query parameter" : "Form field";
    const seenStr = redacted
      ? " (sensitive — value not captured)"
      : ` (captured: ${distinct.slice(0, 3).map((v) => fmt(coerce(v, shape))).join(", ")})`;
    // Free-text search inputs are what the user actually wants to vary: make them required.
    const isSearch = location === "query" && SEARCH_PARAMS.test(name);
    return {
      arg: name,
      name,
      in: location,
      shape,
      required: redacted || isSearch,
      example: inAll ? example : undefined,
      description: `${label} \`${name}\`${seenStr}`,
    } satisfies ToolParam;
  });
}

function coerce(v: string, shape: Shape): unknown {
  if (shape.kind === "integer" || shape.kind === "number") return Number(v);
  if (shape.kind === "boolean") return v === "true";
  return v;
}

function jsonObjectParams(samples: Record<string, unknown>[]): ToolParam[] {
  const names = [...new Set(samples.flatMap((s) => Object.keys(s)))];
  return names.map((name) => {
    const present = samples.filter((s) => name in s);
    let shape: Shape | undefined;
    for (const s of present) shape = shape ? mergeShapes(shape, inferShape(s[name])) : inferShape(s[name]);
    const values = present.map((s) => s[name]);
    const distinct = [...new Set(values.map((v) => JSON.stringify(v)))];
    return {
      arg: name,
      name,
      in: "body",
      shape: shape ?? { kind: "unknown" },
      required: false,
      example: present.length === samples.length ? values[values.length - 1] : undefined,
      description: `JSON body field \`${name}\` (captured: ${distinct.slice(0, 3).map((d) => (d.length > 60 ? d.slice(0, 57) + "…" : d)).join(", ")})`,
    } satisfies ToolParam;
  });
}

function dedupeArgs(params: ToolParam[]): ToolParam[] {
  const used = new Set<string>();
  // path params first so they keep their clean names
  const order: Record<string, number> = { path: 0, query: 1, body: 2, form: 2 };
  const sorted = [...params].sort((a, b) => order[a.in]! - order[b.in]!);
  for (const p of sorted) {
    let arg = sanitizeArg(p.arg);
    if (used.has(arg)) arg = sanitizeArg(`${p.in}_${arg}`);
    for (let n = 2; used.has(arg); n++) arg = `${sanitizeArg(p.arg)}_${n}`;
    used.add(arg);
    p.arg = arg;
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Context (what the user did right before the call)
// ---------------------------------------------------------------------------

function describeAction(a: UserAction | undefined): string | undefined {
  if (!a) return undefined;
  const where = (() => {
    try {
      return new URL(a.url).pathname;
    } catch {
      return a.url;
    }
  })();
  switch (a.type) {
    case "click":
      return `clicking ${a.text ? `"${a.text}"` : a.selector ?? "an element"} on ${where}`;
    case "change":
    case "input":
      return `typing into ${a.selector ?? "a field"} on ${where}`;
    case "submit":
      return `submitting a form on ${where}`;
    case "keydown":
      return `pressing Enter in ${a.selector ?? "a field"} on ${where}`;
    case "navigate":
      return `opening ${where}`;
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function analyzeSession(session: Session): ToolSpec[] {
  const actionsById = new Map(session.actions.map((a) => [a.id, a]));
  const groups = groupRequests(session.requests);
  const usedNames = new Set<string>();
  const tools: ToolSpec[] = [];

  for (const g of groups) {
    const reqs = g.requests;
    const lastReq = reqs[reqs.length - 1]!;
    const secretQuery = new Set(reqs.flatMap((r) => r.secretQuery));
    const params: ToolParam[] = [];

    // path params
    for (const p of g.path.params) {
      const values = reqs.map((r) => safeDecode(new URL(r.url).pathname.split("/").filter(Boolean)[p.index] ?? ""));
      const shape = inferScalarShape(values);
      const distinct = [...new Set(values)];
      params.push({
        arg: p.name,
        name: p.name,
        in: "path",
        shape,
        required: true,
        example: coerce(values[values.length - 1]!, shape),
        description: `Path parameter \`${p.name}\` (captured: ${distinct.slice(0, 3).map((v) => fmt(coerce(v, shape))).join(", ")})`,
      });
    }

    params.push(...scalarParams("query", reqs.map((r) => r.query), secretQuery));

    // body
    let rawJsonBody = false;
    let graphqlQuery: string | undefined;
    const jsonBodies = reqs.map((r) => r.body?.json).filter((b) => b !== undefined);
    const formBodies = reqs.map((r) => r.body?.form).filter((b): b is Record<string, string> => !!b);
    if (g.graphqlOperation) {
      const last = lastReq.body?.json as Record<string, unknown>;
      graphqlQuery = typeof last.query === "string" ? last.query : undefined;
      const vars = jsonBodies.map((b) => ((b as Record<string, unknown>).variables ?? {}) as Record<string, unknown>);
      params.push(...jsonObjectParams(vars).map((p) => ({ ...p, description: p.description.replace("JSON body field", "GraphQL variable") })));
    } else if (jsonBodies.length) {
      if (jsonBodies.every((b) => b && typeof b === "object" && !Array.isArray(b))) {
        params.push(...jsonObjectParams(jsonBodies as Record<string, unknown>[]));
      } else {
        rawJsonBody = true;
        let shape: Shape | undefined;
        for (const b of jsonBodies) shape = shape ? mergeShapes(shape, inferShape(b)) : inferShape(b);
        params.push({
          arg: "body",
          name: "body",
          in: "body",
          shape: shape ?? { kind: "unknown" },
          required: false,
          example: jsonBodies[jsonBodies.length - 1],
          description: "Full JSON request body",
        });
      }
    } else if (formBodies.length) {
      params.push(...scalarParams("form", formBodies, new Set()));
    }

    let responseShape: Shape | undefined;
    for (const r of reqs) {
      if (r.response.json === undefined) continue;
      const s = inferShape(r.response.json);
      responseShape = responseShape ? mergeShapes(responseShape, s) : s;
    }

    const queryNames = params.filter((p) => p.in === "query").map((p) => p.name);
    let name = toolNameFor(g, queryNames, responseShape);
    const base = name;
    for (let n = 2; usedNames.has(name); n++) name = `${base}_${n}`.slice(0, 64);
    usedNames.add(name);

    const host = new URL(g.origin).host;
    const contexts = [...new Set(reqs.map((r) => describeAction(r.actionId ? actionsById.get(r.actionId) : undefined)).filter(Boolean))];
    const method = g.method.toUpperCase();
    const isGraphqlQuery = !!graphqlQuery && /^\s*(query\b|\{)/.test(graphqlQuery);
    const descLines = [
      g.graphqlOperation
        ? `GraphQL operation \`${g.graphqlOperation}\` (${method} ${g.path.template} on ${host}).`
        : `${method} ${g.path.template} on ${host}.`,
      contexts.length ? `Recorded after ${contexts.slice(0, 2).join("; ")}.` : undefined,
      responseShape ? `Returns ${describeShape(responseShape)}.` : undefined,
      reqs.length > 1 ? `Observed ${reqs.length} times during recording.` : undefined,
    ].filter(Boolean);

    // static headers: take from the last sample; content-type matters for body encoding
    const headers = { ...lastReq.headers };

    tools.push({
      name,
      title: titleFromName(name),
      description: descLines.join(" "),
      method,
      origin: g.origin,
      pathTemplate: g.path.template,
      params: dedupeArgs(params),
      rawJsonBody,
      headers,
      secretHeaders: [...new Set(reqs.flatMap((r) => r.secretHeaders))],
      secretQuery: [...secretQuery],
      usesCookies: reqs.some((r) => r.cookieNames.length > 0),
      readOnly: method === "GET" || method === "HEAD" || isGraphqlQuery,
      responseShape,
      samples: reqs.length,
      ...(graphqlQuery ? { graphql: { operationName: g.graphqlOperation!, query: graphqlQuery } } : {}),
    });
  }
  return tools;
}

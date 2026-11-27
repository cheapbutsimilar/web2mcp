/** Shape of a JSON value inferred from one or more captured samples. */
export type Shape =
  | { kind: "string" | "number" | "integer" | "boolean" | "null" | "unknown" }
  | { kind: "array"; items: Shape }
  | { kind: "object"; props: Record<string, Shape> };

export interface CapturedBody {
  contentType: string;
  /** Parsed JSON body (trimmed: long arrays are cut down). */
  json?: unknown;
  /** application/x-www-form-urlencoded body. */
  form?: Record<string, string>;
  /** Raw text preview for anything else. */
  raw?: string;
}

export interface CapturedResponse {
  status: number;
  contentType: string;
  size: number;
  json?: unknown;
  textPreview?: string;
}

export interface CapturedRequest {
  id: string;
  timestamp: number;
  pageUrl: string;
  method: string;
  url: string;
  resourceType: string;
  /** Non-sensitive request headers worth replaying (accept, content-type, x-requested-with, ...). */
  headers: Record<string, string>;
  /** Names of sensitive headers that were present (values are never stored in session.json). */
  secretHeaders: string[];
  /** Names of cookies sent with the request. */
  cookieNames: string[];
  /** Names of query params that look like credentials (values redacted). */
  secretQuery: string[];
  query: Record<string, string>;
  body?: CapturedBody;
  response: CapturedResponse;
  /** id of the most recent user action that happened before this request. */
  actionId?: string;
}

export type UserActionType = "click" | "input" | "change" | "submit" | "keydown" | "navigate";

export interface UserAction {
  id: string;
  timestamp: number;
  type: UserActionType;
  url: string;
  selector?: string;
  text?: string;
  value?: string;
}

export interface Session {
  version: 1;
  tool: "web2mcp";
  startUrl: string;
  origin: string;
  createdAt: string;
  requests: CapturedRequest[];
  actions: UserAction[];
  /** Counters for transparency: how much noise was filtered out. */
  stats: { seen: number; kept: number; dropped: Record<string, number> };
}

export type ParamLocation = "path" | "query" | "body" | "form";

export interface ToolParam {
  /** Name exposed to the MCP client (sanitized identifier). */
  arg: string;
  /** Original name on the wire. */
  name: string;
  in: ParamLocation;
  shape: Shape;
  required: boolean;
  example?: unknown;
  description: string;
}

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  method: string;
  origin: string;
  /** Path template, e.g. /api/products/{productId} */
  pathTemplate: string;
  params: ToolParam[];
  /** JSON body that is not an object (e.g. array) — sent as a single `body` arg. */
  rawJsonBody: boolean;
  /** Static headers replayed on every call. */
  headers: Record<string, string>;
  secretHeaders: string[];
  secretQuery: string[];
  usesCookies: boolean;
  readOnly: boolean;
  responseShape?: Shape;
  samples: number;
  /** Present for GraphQL operations: the captured query document is replayed with new variables. */
  graphql?: { operationName: string; query: string };
}

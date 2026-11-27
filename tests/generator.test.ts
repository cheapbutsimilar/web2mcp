import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generate, serverNameFor, zodFor } from "../src/generator.js";
import { buildGeneratedOffline } from "../src/selftest.js";
import type { Session } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "web2mcp-gen-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const session: Session = {
  version: 1,
  tool: "web2mcp",
  startUrl: "https://www.example.com/",
  origin: "https://www.example.com",
  createdAt: new Date(0).toISOString(),
  actions: [],
  stats: { seen: 3, kept: 3, dropped: {} },
  requests: [
    {
      id: "r1", timestamp: 1, pageUrl: "https://www.example.com/", method: "GET",
      url: "https://api.example.com/v2/search", resourceType: "fetch",
      headers: { accept: "application/json" }, secretHeaders: ["x-api-key"], cookieNames: ["sid"],
      secretQuery: ["access_token"], query: { q: "hello \"world\"", access_token: "<redacted>" },
      response: { status: 200, contentType: "application/json", size: 10, json: { results: [{ id: 1, title: "t", meta: { a: null } }] } },
    },
    {
      id: "r2", timestamp: 2, pageUrl: "https://www.example.com/", method: "PUT",
      url: "https://www.example.com/api/notes/12", resourceType: "xhr",
      headers: { "content-type": "application/json" }, secretHeaders: [], cookieNames: [], secretQuery: [], query: {},
      body: { contentType: "application/json", json: { text: "hi", tags: ["a"], nested: { deep: { deeper: { deepest: { x: 1 } } } }, nothing: null } },
      response: { status: 200, contentType: "application/json", size: 2, json: { ok: true } },
    },
    {
      id: "r3", timestamp: 3, pageUrl: "https://www.example.com/", method: "POST",
      url: "https://www.example.com/api/batch", resourceType: "fetch",
      headers: {}, secretHeaders: [], cookieNames: [], secretQuery: [], query: {},
      body: { contentType: "application/json", json: [{ op: "a" }, { op: "b" }] },
      response: { status: 200, contentType: "application/json", size: 2, json: [] },
    },
  ],
};

describe("generate", () => {
  const res = generate({ session, outDir: join(dir, "out") });

  it("derives a server name and writes the project files", () => {
    expect(serverNameFor("https://www.example.com")).toBe("example-com");
    expect(serverNameFor("http://127.0.0.1:8080")).toBe("local-8080");
    expect(res.name).toBe("example-com");
    expect(res.files).toEqual(
      expect.arrayContaining(["src/index.ts", "package.json", "tsconfig.json", ".env.example", "README.md", "mcp-config.json"]),
    );
    const pkg = JSON.parse(readFileSync(join(res.outDir, "package.json"), "utf8"));
    expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeDefined();
    expect(pkg.dependencies.zod).toBeDefined();
  });

  it("emits env vars for every credential, with a security warning", () => {
    const env = readFileSync(join(res.outDir, ".env.example"), "utf8");
    expect(env).toContain("SECURITY WARNING");
    expect(env).toContain("WEB2MCP_COOKIE=");
    expect(env).toContain("WEB2MCP_HEADER_X_API_KEY=");
    expect(env).toContain("WEB2MCP_QUERY_ACCESS_TOKEN=");
    expect(readFileSync(join(res.outDir, ".gitignore"), "utf8")).toContain(".env");
  });

  it("never exposes secret query params as tool inputs", () => {
    const search = res.tools.find((t) => t.name === "search")!;
    expect(search.params.map((p) => p.arg)).toEqual(["q"]);
  });

  it("produces mcpServers snippets for Claude Desktop, Cursor and Claude Code", () => {
    const cfg = JSON.parse(res.configSnippets.claudeDesktop);
    expect(cfg.mcpServers["example-com"].command).toBe("node");
    expect(cfg.mcpServers["example-com"].args[0]).toMatch(/dist[\\/]index\.js$/);
    expect(res.configSnippets.claudeCode).toMatch(/^claude mcp add example-com -- node /);
  });

  it("maps shapes to zod", () => {
    expect(zodFor({ kind: "array", items: { kind: "integer" } })).toBe("z.array(z.number().int())");
    expect(zodFor({ kind: "object", props: {} })).toBe("z.record(z.any())");
  });

  it("generated server type-checks and compiles with tsc (strict)", async () => {
    await buildGeneratedOffline(res.outDir);
    const js = readFileSync(join(res.outDir, "dist", "index.js"), "utf8");
    for (const name of ["search", "update_note", "create_batch"]) expect(js).toMatch(new RegExp(`registerTool\\(\\s*"${name}"`));
  });
});

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DEMO_TOKEN, startMockSite } from "./demo/mock-site.js";
import { generate, type GenerateResult } from "./generator.js";
import { record } from "./recorder.js";
import type { Session } from "./types.js";

const require = createRequire(import.meta.url);

/** Locate the node_modules directory that holds web2mcp's own copy of the MCP SDK / zod / typescript. */
export function findDepsNodeModules(): string {
  let dir = dirname(require.resolve("zod"));
  while (dir !== dirname(dir)) {
    if (dir.endsWith("node_modules") && existsSync(join(dir, "@modelcontextprotocol", "sdk")) && existsSync(join(dir, "typescript"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("Could not locate node_modules containing @modelcontextprotocol/sdk and typescript");
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
  });
}

/**
 * Type-check and compile a generated server *without* hitting the npm registry,
 * by linking web2mcp's own dependencies into it.
 */
export async function buildGeneratedOffline(outDir: string): Promise<void> {
  const nm = join(outDir, "node_modules");
  if (!existsSync(nm)) symlinkSync(findDepsNodeModules(), nm, "dir");
  const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
  const { code, output } = await run(process.execPath, [tsc, "-p", join(outDir, "tsconfig.json")], outDir);
  if (code !== 0) throw new Error(`Generated server failed to type-check:\n${output}`);
}

export interface SelfTestStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SelfTestResult {
  ok: boolean;
  steps: SelfTestStep[];
  outDir: string;
  session?: Session;
  generated?: GenerateResult;
}

/**
 * End-to-end check: mock site → headless recording → codegen → tsc build →
 * spawn the generated MCP server over stdio → list & call tools against the mock backend.
 */
export async function runSelfTest(opts: { outDir?: string; log?: (m: string) => void; keep?: boolean } = {}): Promise<SelfTestResult> {
  const log = opts.log ?? (() => {});
  const work = opts.outDir ? resolve(opts.outDir) : mkdtempSync(join(tmpdir(), "web2mcp-selftest-"));
  const steps: SelfTestStep[] = [];
  const step = (name: string, ok: boolean, detail?: string) => {
    steps.push({ name, ok, detail });
    log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) throw new Error(`${name} failed${detail ? `: ${detail}` : ""}`);
  };

  const site = await startMockSite();
  let session: Session | undefined;
  let generated: GenerateResult | undefined;
  let client: Client | undefined;
  try {
    log(`Mock site running at ${site.url}`);

    // 1. record
    const rec = await record({
      url: site.url,
      headless: true,
      sessionDir: join(work, ".web2mcp"),
      saveSecrets: true,
      log: () => {},
      drive: async (page) => {
        await page.fill("#q", "keyboard");
        await page.click("#search-btn");
        await page.waitForSelector("[data-testid=product-101]");
        await page.fill("#q", "mouse");
        await page.click("#search-btn");
        await page.waitForSelector("[data-testid=product-102]");
        await page.click("[data-testid=product-102]");
        await page.waitForSelector("#add-to-cart");
        await page.click("#add-to-cart");
        await page.waitForFunction(() => document.getElementById("cart-count")?.textContent === "1");
      },
    });
    session = rec.session;
    const paths = session.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    const noise = session.requests.filter((r) => /collect|beacon|static|\.png|\.css|\.woff/.test(r.url));
    step("record: captured API calls", paths.includes("GET /api/v1/products/search") && paths.includes("POST /api/v1/cart/items"), paths.join(", "));
    step("record: filtered static assets & trackers", noise.length === 0, `kept ${session.stats.kept}/${session.stats.seen}, dropped ${JSON.stringify(session.stats.dropped)}`);
    step("record: secrets redacted from session.json", !JSON.stringify(session).includes(DEMO_TOKEN));

    // 2. generate
    const outDir = join(work, "output", "mcp-server");
    generated = generate({ session, outDir, name: "demo-shop", secretsPath: rec.secretsPath });
    const names = generated.tools.map((t) => t.name);
    step("generate: tools", ["search_products", "get_product", "create_cart_items"].every((n) => names.includes(n)), names.join(", "));

    // 3. build
    await buildGeneratedOffline(outDir);
    step("build: generated server type-checks & compiles", existsSync(join(outDir, "dist", "index.js")));

    // 4. run via MCP stdio client
    client = new Client({ name: "web2mcp-selftest", version: "0.1.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(outDir, "dist", "index.js")],
        env: { ...process.env, WEB2MCP_BASE_URL: site.url } as Record<string, string>,
        stderr: "ignore",
      }),
    );
    const listed = await client.listTools();
    step("mcp: tools/list", listed.tools.length === generated.tools.length, `${listed.tools.length} tools`);

    const search = await client.callTool({ name: "search_products", arguments: { q: "monitor" } });
    const searchText = (search.content as { type: string; text: string }[])[0]?.text ?? "";
    step("mcp: search_products(q=monitor) hits real backend", !search.isError && searchText.includes("4K Monitor"));

    const detail = await client.callTool({ name: "get_product", arguments: { productId: 101 } });
    const detailText = (detail.content as { type: string; text: string }[])[0]?.text ?? "";
    step("mcp: get_product(101)", !detail.isError && detailText.includes("Mechanical Keyboard"));

    const add = await client.callTool({ name: "create_cart_items", arguments: { productId: 103, quantity: 2 } });
    const addText = (add.content as { type: string; text: string }[])[0]?.text ?? "";
    step("mcp: create_cart_items uses token from .env", !add.isError && addText.includes('"count": 3'), addText.split("\n")[2]);

    return { ok: true, steps, outDir: work, session, generated };
  } catch (err) {
    if (!steps.some((s) => !s.ok)) steps.push({ name: "error", ok: false, detail: (err as Error).message });
    return { ok: false, steps, outDir: work, session, generated };
  } finally {
    await client?.close().catch(() => {});
    await site.close();
    if (!opts.keep && !opts.outDir) rmSync(work, { recursive: true, force: true });
  }
}

#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { generate, type GenerateResult } from "./generator.js";
import { record } from "./recorder.js";
import { runSelfTest } from "./selftest.js";
import type { Session } from "./types.js";

const program = new Command();

program
  .name("web2mcp")
  .description("No official API? Record once, get a local MCP server.")
  .version("0.1.0");

function printResult(res: GenerateResult): void {
  const rel = relative(process.cwd(), res.outDir) || ".";
  console.log(`\n✔ Generated MCP server "${res.name}" with ${res.tools.length} tool(s) → ${rel}/`);
  for (const t of res.tools) console.log(`   • ${t.name.padEnd(28)} ${t.method} ${t.pathTemplate}`);
  console.log(`\nNext:\n   cd ${rel} && npm install && npm run build`);
  if (res.tools.some((t) => t.secretHeaders.length || t.usesCookies || t.secretQuery.length)) {
    console.log(
      res.files.includes(".env")
        ? "   ⚠ .env contains your captured session credentials — keep it private."
        : "   ⚠ This site needs credentials: cp .env.example .env and fill in cookies/tokens.",
    );
  }
  console.log(`\nClaude Desktop / Cursor (mcpServers):\n${res.configSnippets.claudeDesktop}`);
  console.log(`\nClaude Code:\n   ${res.configSnippets.claudeCode}\n`);
}

function npm(args: string[], cwd: string): Promise<void> {
  return new Promise((ok, fail) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
    child.on("close", (code) => (code === 0 ? ok() : fail(new Error(`npm ${args.join(" ")} exited with ${code}`))));
  });
}

async function maybeBuild(res: GenerateResult, build: boolean): Promise<void> {
  if (!build) return;
  console.log("Installing & building generated server…");
  await npm(["install", "--no-audit", "--no-fund"], res.outDir);
  await npm(["run", "build"], res.outDir);
  console.log(`✔ Built ${join(res.outDir, "dist", "index.js")}`);
}

program
  .command("record")
  .argument("<url>", "website to record")
  .description("open a browser, let you use the site, capture its API calls, then generate an MCP server")
  .option("-s, --session-dir <dir>", "where to store session.json", ".web2mcp")
  .option("-o, --out <dir>", "output directory for the generated server", "output/mcp-server")
  .option("-n, --name <name>", "MCP server name (default: derived from host)")
  .option("--headless", "run the browser headless (useful with --timeout)", false)
  .option("-t, --timeout <seconds>", "stop recording automatically after N seconds", (v) => Number(v), 0)
  .option("--save-secrets", "write captured cookies/tokens to <session-dir>/secrets.env and the generated .env", false)
  .option("--no-generate", "only record, don't generate the server")
  .option("--build", "npm install && npm run build the generated server", false)
  .action(async (url: string, o) => {
    const rec = await record({
      url: /^https?:\/\//.test(url) ? url : `https://${url}`,
      sessionDir: o.sessionDir,
      headless: o.headless,
      timeoutSec: o.timeout,
      saveSecrets: o.saveSecrets,
    });
    if (!o.generate) return;
    if (rec.session.requests.length === 0) {
      console.error("No API requests captured — nothing to generate. Try interacting more (search, open details, paginate).");
      process.exitCode = 1;
      return;
    }
    const res = generate({ session: rec.session, outDir: o.out, name: o.name, secretsPath: rec.secretsPath });
    printResult(res);
    await maybeBuild(res, o.build);
  });

program
  .command("generate")
  .description("generate an MCP server from a recorded session")
  .option("-s, --session <file>", "session file", ".web2mcp/session.json")
  .option("-o, --out <dir>", "output directory", "output/mcp-server")
  .option("-n, --name <name>", "MCP server name (default: derived from host)")
  .option("--build", "npm install && npm run build the generated server", false)
  .action(async (o) => {
    const file = resolve(o.session);
    if (!existsSync(file)) throw new Error(`Session not found: ${file}. Run \`web2mcp record <url>\` first.`);
    const session = JSON.parse(readFileSync(file, "utf8")) as Session;
    const res = generate({ session, outDir: o.out, name: o.name, secretsPath: join(dirname(file), "secrets.env") });
    printResult(res);
    await maybeBuild(res, o.build);
  });

program
  .command("test")
  .description("self-test: record a local mock shop headlessly, generate + build an MCP server, and call its tools")
  .option("--keep", "keep the temporary output directory", false)
  .option("-o, --out <dir>", "write the demo session and server here instead of a temp dir")
  .action(async (o) => {
    console.log("web2mcp self-test\n");
    const res = await runSelfTest({ outDir: o.out, keep: o.keep, log: (m) => console.log("  " + m) });
    if (res.ok) {
      console.log(`\n✔ All ${res.steps.length} checks passed.${o.keep || o.out ? ` Output: ${res.outDir}` : ""}`);
    } else {
      const failed = res.steps.find((s) => !s.ok);
      console.error(`\n✘ Self-test failed: ${failed?.name} ${failed?.detail ?? ""}`);
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`✘ ${err.message}`);
  process.exit(1);
});

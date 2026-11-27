import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type Request } from "playwright";
import { parseCookieNames, isSecretParam, shouldCapture, splitHeaders } from "./filter.js";
import { trimSample } from "./shape.js";
import type { CapturedBody, CapturedRequest, Session, UserAction } from "./types.js";

export interface RecordOptions {
  url: string;
  /** Directory where session.json is written (default `.web2mcp`). */
  sessionDir?: string;
  headless?: boolean;
  /** Stop automatically after N seconds (0 = wait for the browser window to be closed). */
  timeoutSec?: number;
  /**
   * Also write captured secret values (cookies / auth headers) to `<sessionDir>/secrets.env`.
   * Off by default — session.json itself never contains secret values.
   */
  saveSecrets?: boolean;
  /** Programmatic driver (used by tests / `web2mcp test`). Recording stops when it resolves. */
  drive?: (page: Page) => Promise<void>;
  log?: (msg: string) => void;
}

export interface RecordResult {
  session: Session;
  sessionPath: string;
  secretsPath?: string;
}

const MAX_BODY_BYTES = 512 * 1024;

/** Injected into every page: reports clicks, inputs and submits back to the recorder. */
const ACTION_SCRIPT = `(() => {
  if (window.__web2mcpInstalled) return;
  window.__web2mcpInstalled = true;
  const send = (p) => { try { window.__web2mcpAction && window.__web2mcpAction(p); } catch (e) {} };
  const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
  const selectorOf = (el) => {
    if (!el || el.nodeType !== 1) return undefined;
    if (el.id) return '#' + cssEscape(el.id);
    for (const a of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'placeholder']) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) return el.tagName.toLowerCase() + '[' + a + '="' + v.replace(/"/g, '\\\\"') + '"]';
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 4) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const textOf = (el) => ((el && (el.innerText || el.value || el.getAttribute('aria-label') || el.title)) || '').trim().slice(0, 80);
  const isSecretField = (el) => el && (el.type === 'password' || /pass|token|secret|otp|card|cvc|ssn/i.test(el.name || el.id || ''));
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? (e.target.closest('a,button,[role=button],input,select,label,[onclick]') || e.target) : e.target;
    send({ type: 'click', selector: selectorOf(el), text: textOf(el) });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    send({ type: 'change', selector: selectorOf(el), value: isSecretField(el) ? '<redacted>' : String(el.value || '').slice(0, 200) });
  }, true);
  document.addEventListener('submit', (e) => send({ type: 'submit', selector: selectorOf(e.target) }), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send({ type: 'keydown', selector: selectorOf(e.target), value: 'Enter' });
  }, true);
})();`;

export async function record(opts: RecordOptions): Promise<RecordResult> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const sessionDir = opts.sessionDir ?? ".web2mcp";
  const startUrl = new URL(opts.url).toString();
  const origin = new URL(startUrl).origin;

  const requests: CapturedRequest[] = [];
  const actions: UserAction[] = [];
  const dropped: Record<string, number> = {};
  const secrets: Record<string, string> = {};
  let seen = 0;
  let seq = 0;
  const pending = new Set<Promise<void>>();

  const browser = await chromium.launch({ headless: opts.headless ?? false });
  const context = await browser.newContext();

  const pushAction = (a: Omit<UserAction, "id" | "timestamp">) => {
    const action: UserAction = { id: `a${++seq}`, timestamp: Date.now(), ...a };
    // Collapse "keydown Enter" directly following a change on the same element.
    actions.push(action);
    log(`  • ${action.type}${action.selector ? ` ${action.selector}` : ""}${action.text ? ` "${action.text}"` : ""}${action.type === "navigate" ? ` ${action.url}` : ""}`);
  };

  await context.exposeBinding("__web2mcpAction", (source, payload: Partial<UserAction>) => {
    pushAction({
      type: (payload.type ?? "click") as UserAction["type"],
      url: source.frame.url(),
      selector: payload.selector,
      text: payload.text || undefined,
      value: payload.value,
    });
  });
  await context.addInitScript(ACTION_SCRIPT);

  const handle = async (req: Request) => {
    seen++;
    const res = await req.response().catch(() => null);
    if (!res) return;
    const resHeaders = await res.allHeaders().catch(() => ({}) as Record<string, string>);
    const contentType = resHeaders["content-type"] ?? "";
    const verdict = shouldCapture({
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status: res.status(),
      responseContentType: contentType,
    });
    if (!verdict.keep) {
      dropped[verdict.reason] = (dropped[verdict.reason] ?? 0) + 1;
      return;
    }

    const allHeaders = await req.allHeaders().catch(() => req.headers());
    const { replay, secret } = splitHeaders(allHeaders);
    const cookieNames = parseCookieNames(secret["cookie"]);
    for (const [k, v] of Object.entries(secret)) secrets[k] = v;

    const url = new URL(req.url());
    const query: Record<string, string> = {};
    const secretQuery: string[] = [];
    for (const [k, v] of url.searchParams) {
      if (isSecretParam(k)) {
        secretQuery.push(k);
        secrets[`query:${k}`] = v;
        query[k] = "<redacted>";
      } else {
        query[k] = v;
      }
    }

    let body: CapturedBody | undefined;
    const postData = req.postData();
    if (postData) {
      const ct = (allHeaders["content-type"] ?? "").toLowerCase();
      body = { contentType: ct };
      if (ct.includes("json") || /^\s*[[{]/.test(postData)) {
        try {
          body.json = trimSample(JSON.parse(postData), 20, 50_000);
        } catch {
          body.raw = postData.slice(0, 2000);
        }
      } else if (ct.includes("x-www-form-urlencoded")) {
        body.form = Object.fromEntries(new URLSearchParams(postData));
        for (const k of Object.keys(body.form)) if (isSecretParam(k)) body.form[k] = "<redacted>";
      } else {
        body.raw = postData.slice(0, 2000);
      }
    }

    let size = 0;
    let json: unknown;
    let textPreview: string | undefined;
    try {
      const buf = await res.body();
      size = buf.length;
      if (size <= MAX_BODY_BYTES) {
        const text = buf.toString("utf8");
        try {
          json = trimSample(JSON.parse(text));
        } catch {
          textPreview = text.slice(0, 1000);
        }
      }
    } catch {
      /* body unavailable (e.g. navigation) */
    }

    const lastAction = actions[actions.length - 1];
    const captured: CapturedRequest = {
      id: `r${++seq}`,
      timestamp: Date.now(),
      pageUrl: req.frame()?.url() ?? "",
      method: req.method(),
      url: `${url.origin}${url.pathname}`,
      resourceType: req.resourceType(),
      headers: replay,
      secretHeaders: Object.keys(secret).filter((h) => h !== "cookie"),
      cookieNames,
      secretQuery,
      query,
      body,
      response: { status: res.status(), contentType, size, json, textPreview },
      actionId: lastAction?.id,
    };
    requests.push(captured);
    log(`  ✓ ${captured.method} ${url.pathname}${url.search ? url.search.slice(0, 60) : ""} → ${res.status()}`);
  };

  context.on("requestfinished", (req) => {
    const p = handle(req).catch((e) => log(`  ! capture error: ${(e as Error).message}`));
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });

  const page = await context.newPage();
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) pushAction({ type: "navigate", url: frame.url() });
  });

  log(`● Recording ${startUrl}`);
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });

  if (opts.drive) {
    await opts.drive(page);
    await page.waitForLoadState("networkidle").catch(() => {});
  } else {
    log("  Use the browser like a normal user (log in, search, open items...).");
    log(`  Close the browser window${opts.timeoutSec ? ` or wait ${opts.timeoutSec}s` : ""} (or press Ctrl+C) to finish.`);
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        process.off("SIGINT", done);
        resolve();
      };
      if (opts.timeoutSec) timer = setTimeout(done, opts.timeoutSec * 1000);
      process.once("SIGINT", done);
      browser.once("disconnected", done);
      context.once("close", done);
      page.once("close", () => {
        if (context.pages().length === 0) done();
      });
    });
  }

  await Promise.allSettled([...pending]);
  await browser.close().catch(() => {});

  const session: Session = {
    version: 1,
    tool: "web2mcp",
    startUrl,
    origin,
    createdAt: new Date().toISOString(),
    requests,
    actions,
    stats: { seen, kept: requests.length, dropped },
  };

  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "session.json");
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));
  writeFileSync(join(sessionDir, ".gitignore"), "*\n");

  let secretsPath: string | undefined;
  if (opts.saveSecrets && Object.keys(secrets).length) {
    secretsPath = join(sessionDir, "secrets.env");
    writeFileSync(secretsPath, secretsToEnv(secrets), { mode: 0o600 });
    chmodSync(secretsPath, 0o600);
  }

  log(`■ Captured ${requests.length} API request(s) from ${seen} total (${Object.values(dropped).reduce((a, b) => a + b, 0)} filtered). Saved ${sessionPath}`);
  return { session, sessionPath, secretsPath };
}

/** Map captured secret values to the env variable names the generated server reads. */
export function secretsToEnv(secrets: Record<string, string>): string {
  const lines = ["# Captured by `web2mcp record --save-secrets`. DO NOT COMMIT.", ""];
  for (const [k, v] of Object.entries(secrets)) {
    const name = k === "cookie" ? "WEB2MCP_COOKIE" : k.startsWith("query:") ? queryEnvName(k.slice(6)) : headerEnvName(k);
    lines.push(`${name}=${JSON.stringify(v)}`);
  }
  return lines.join("\n") + "\n";
}

export function headerEnvName(header: string): string {
  return `WEB2MCP_HEADER_${header.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

export function queryEnvName(param: string): string {
  return `WEB2MCP_QUERY_${param.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

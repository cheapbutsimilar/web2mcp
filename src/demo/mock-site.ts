import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny "website without a public API": an HTML shop whose frontend talks to private
 * JSON endpoints, plus the usual noise (images, fonts, CSS, analytics beacons).
 * Used by `web2mcp test` and the test-suite.
 */

export const DEMO_TOKEN = "demo-token-123";

const PRODUCTS = [
  { id: 101, name: "Mechanical Keyboard", price: 129, tags: ["keyboard", "peripherals"] },
  { id: 102, name: "Wireless Mouse", price: 49, tags: ["mouse", "peripherals"] },
  { id: 103, name: "4K Monitor", price: 399, tags: ["monitor", "display"] },
  { id: 104, name: "Keyboard Wrist Rest", price: 19, tags: ["keyboard", "accessories"] },
];

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Demo Shop</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="preload" href="/static/inter.woff2" as="font" crossorigin>
</head><body>
<img src="/static/logo.png" alt="logo">
<h1>Demo Shop</h1>
<form id="search-form">
  <input id="q" name="q" placeholder="Search products">
  <button id="search-btn" type="submit">Search</button>
</form>
<ul id="results"></ul>
<section id="detail"></section>
<p>Cart items: <span id="cart-count">0</span></p>
<script>
  const TOKEN = ${JSON.stringify(DEMO_TOKEN)};
  const api = (path, init = {}) => fetch(path, {
    ...init,
    headers: { accept: 'application/json', authorization: 'Bearer ' + TOKEN, 'x-requested-with': 'XMLHttpRequest', ...(init.headers || {}) },
  }).then((r) => r.json());

  // analytics noise that must be filtered out
  fetch('/collect?ev=pageview', { method: 'POST', body: 'ev=pageview' });
  navigator.sendBeacon && navigator.sendBeacon('/beacon', 'x');

  document.getElementById('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = document.getElementById('q').value;
    const data = await api('/api/v1/products/search?q=' + encodeURIComponent(q) + '&limit=5');
    const ul = document.getElementById('results');
    ul.innerHTML = '';
    for (const p of data.items) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.className = 'product'; b.dataset.testid = 'product-' + p.id; b.textContent = p.name;
      b.onclick = () => openProduct(p.id);
      li.appendChild(b); ul.appendChild(li);
    }
  });

  async function openProduct(id) {
    const p = await api('/api/v1/products/' + id);
    const d = document.getElementById('detail');
    d.innerHTML = '<h2>' + p.name + '</h2><p>$' + p.price + '</p>';
    const add = document.createElement('button');
    add.id = 'add-to-cart'; add.textContent = 'Add to cart';
    add.onclick = async () => {
      const cart = await api('/api/v1/cart/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ productId: p.id, quantity: 1 }),
      });
      document.getElementById('cart-count').textContent = String(cart.count);
    };
    d.appendChild(add);
  }
</script>
</body></html>`;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function json(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

export interface MockSite {
  url: string;
  server: Server;
  close: () => Promise<void>;
  /** Count of API hits per path (lets tests prove the generated server hit the real backend). */
  hits: Record<string, number>;
}

export async function startMockSite(port = 0): Promise<MockSite> {
  const cart: { productId: number; quantity: number }[] = [];
  const hits: Record<string, number> = {};

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path.startsWith("/api/")) hits[path] = (hits[path] ?? 0) + 1;
    const authed = req.headers.authorization === `Bearer ${DEMO_TOKEN}`;

    if (path === "/") {
      res.setHeader("set-cookie", "sid=demo-session-cookie; Path=/; HttpOnly");
      return send(res, 200, "text/html; charset=utf-8", PAGE);
    }
    if (path === "/static/style.css") return send(res, 200, "text/css", "body{font-family:sans-serif}");
    if (path === "/static/inter.woff2") return send(res, 200, "font/woff2", Buffer.alloc(16));
    if (path === "/static/logo.png") return send(res, 200, "image/png", PNG);
    if (path === "/collect" || path === "/beacon") {
      await readBody(req);
      return send(res, 204, "text/plain", "");
    }
    if (path === "/favicon.ico") return send(res, 404, "text/plain", "");

    if (path === "/api/v1/products/search" && req.method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const items = PRODUCTS.filter((p) => !q || p.name.toLowerCase().includes(q) || p.tags.includes(q)).slice(0, limit);
      return json(res, 200, { query: q, total: items.length, items });
    }
    const m = /^\/api\/v1\/products\/(\d+)$/.exec(path);
    if (m && req.method === "GET") {
      const p = PRODUCTS.find((x) => x.id === Number(m[1]));
      return p ? json(res, 200, { ...p, description: `${p.name} — great value.`, stock: 7 }) : json(res, 404, { error: "not found" });
    }
    if (path === "/api/v1/cart/items" && req.method === "POST") {
      if (!authed) return json(res, 401, { error: "login required" });
      const body = JSON.parse((await readBody(req)) || "{}") as { productId: number; quantity: number };
      cart.push({ productId: Number(body.productId), quantity: Number(body.quantity ?? 1) });
      return json(res, 200, { ok: true, count: cart.reduce((a, c) => a + c.quantity, 0), items: cart });
    }
    return json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}/`,
    server,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

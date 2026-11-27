# web2mcp

**Turn any website without an API into a local MCP server — by using it once.**

> No official API? Record once, get a local MCP server.

`web2mcp` opens a real Chromium window, watches the private XHR/fetch calls the site's own frontend makes while you click around, filters out the noise (images, fonts, CSS, analytics, trackers), and generates a standalone, type-checked **TypeScript MCP server** whose tools replay those calls. Plug it into Claude Desktop, Cursor or Claude Code and let your agent search, read and act on the site.

```
 you use the site        web2mcp captures            you get
┌──────────────┐      ┌────────────────────┐      ┌──────────────────────────┐
│ search "lamp"│ ───▶ │ GET /api/search?q= │ ───▶ │ tool: search_products(q) │
│ open item 42 │      │ GET /api/items/42  │      │ tool: get_item(itemId)   │
│ add to cart  │      │ POST /api/cart     │      │ tool: create_cart(...)   │
└──────────────┘      └────────────────────┘      └──────────────────────────┘
```

## Quick start

**1. Record** — a browser opens. Log in if needed, then do the things you want your agent to do. Close the window when done.

```bash
npx github:cheapbutsimilar/web2mcp record https://example.com
```

**2. Build** the generated server (written to `output/mcp-server/`).

```bash
cd output/mcp-server && npm install && npm run build
```

**3. Connect** — paste the printed snippet into your client:

```jsonc
// Claude Desktop: claude_desktop_config.json · Cursor: .cursor/mcp.json
{ "mcpServers": { "example-com": { "command": "node", "args": ["/abs/path/output/mcp-server/dist/index.js"] } } }
```

```bash
# Claude Code
claude mcp add example-com -- node /abs/path/output/mcp-server/dist/index.js
```

Want to see it work first? `npx github:cheapbutsimilar/web2mcp test` records a bundled mock shop headlessly, generates and compiles a server, then calls its tools over MCP stdio.

## Commands

| Command | What it does |
| --- | --- |
| `web2mcp record <url>` | Record a session to `.web2mcp/session.json`, then generate the server. Flags: `--headless`, `--timeout <s>`, `--save-secrets`, `--no-generate`, `--build`, `-o <dir>`, `-n <name>` |
| `web2mcp generate` | (Re)generate from an existing session. Flags: `-s <session.json>`, `-o <dir>`, `-n <name>`, `--build` |
| `web2mcp test` | End-to-end self-test against a local mock site (`--keep` / `-o <dir>` to inspect output) |

## What gets generated

```
output/mcp-server/
├── src/index.ts         # @modelcontextprotocol/sdk server, one zod-typed tool per endpoint
├── package.json         # sdk + zod, `npm run build` → dist/index.js
├── tsconfig.json
├── .env.example         # cookie / token placeholders + security notes
├── .gitignore           # .env, node_modules, dist
├── mcp-config.json      # mcpServers snippet
├── README.md            # tool table + connect instructions
└── web2mcp.tools.json   # analyzed tool specs (for review / diffing)
```

How captured traffic becomes tools:

- **Grouping** — requests are grouped by method + path template; ids, UUIDs and opaque tokens become path params (`/products/101` → `/products/{productId}`). GraphQL calls are split per `operationName`.
- **Parameters** — query strings, JSON bodies (GraphQL variables) and form fields become zod-typed inputs with types inferred from every sample; captured values become defaults, free-text search params (`q`, `query`, …) are required.
- **Naming & docs** — `search_products`, `get_product`, `list_orders`, `create_cart_items`… Descriptions include the endpoint, the UI action that triggered it (“Recorded after clicking "Add to cart"”) and the response shape.
- **Safety hints** — `GET`/GraphQL queries are `readOnlyHint: true`; everything else is marked as a write so clients ask before calling.

## Security model

- `session.json` **never** contains secret values: `Authorization`, `Cookie`, CSRF/API-key headers and token-like query params are recorded by name only.
- Opt in with `--save-secrets` to have your current cookies/tokens written to `.web2mcp/secrets.env` and the generated `.env` (mode `600`, git-ignored). Otherwise fill `.env` from `.env.example`.
- The generated server runs locally over stdio — no ports opened. It acts **as you**: respect the site's Terms of Service and rate limits.

## Develop

```bash
npm install
npm test        # build + unit tests + full record→generate→tsc→MCP e2e test
```

## Roadmap

- [ ] Auth refresh: re-login flow / cookie refresh from the persisted browser profile
- [ ] DOM-action tools for pages without XHR (replay clicks/forms via Playwright)
- [ ] Multi-step flows: chain dependent requests (e.g. CSRF fetch → submit) into one tool
- [ ] Response trimming / field selection to keep LLM context small
- [ ] LLM-assisted naming & descriptions, pagination detection
- [ ] Python (FastMCP) output target and HTTP (streamable) transport
- [ ] `web2mcp inspect` TUI to pick / rename endpoints before generating
- [ ] Publish to npm for `npx web2mcp`

## License

MIT

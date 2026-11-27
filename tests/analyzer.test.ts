import { describe, expect, it } from "vitest";
import { analyzeSession, isIdSegment, templatePath } from "../src/analyzer.js";
import type { CapturedRequest, Session } from "../src/types.js";

let n = 0;
function req(method: string, url: string, extra: Partial<CapturedRequest> = {}): CapturedRequest {
  const u = new URL(url);
  return {
    id: `r${++n}`,
    timestamp: n,
    pageUrl: u.origin + "/",
    method,
    url: u.origin + u.pathname,
    resourceType: "fetch",
    headers: { accept: "application/json" },
    secretHeaders: [],
    cookieNames: [],
    secretQuery: [],
    query: Object.fromEntries(u.searchParams),
    response: { status: 200, contentType: "application/json", size: 2, json: {} },
    ...extra,
  };
}

function session(requests: CapturedRequest[]): Session {
  return {
    version: 1,
    tool: "web2mcp",
    startUrl: "https://shop.example.com/",
    origin: "https://shop.example.com",
    createdAt: new Date(0).toISOString(),
    requests,
    actions: [],
    stats: { seen: requests.length, kept: requests.length, dropped: {} },
  };
}

describe("templatePath", () => {
  it("replaces ids with named params", () => {
    expect(templatePath("/api/users/42/orders/9f8b2c1e-1d2a-4c3b-9a7e-123456789abc").template).toBe(
      "/api/users/{userId}/orders/{orderId}",
    );
    expect(templatePath("/api/categories/7").template).toBe("/api/categories/{categoryId}");
    expect(templatePath("/api/products/search").template).toBe("/api/products/search");
  });

  it("recognises opaque ids but not plain words", () => {
    expect(isIdSegment("a1b2c3d4e5f6a7b8")).toBe(true);
    expect(isIdSegment("blue-shirt-12345")).toBe(true);
    expect(isIdSegment("v2")).toBe(false);
    expect(isIdSegment("products")).toBe(false);
  });
});

describe("analyzeSession", () => {
  it("groups by template and names tools sensibly", () => {
    const tools = analyzeSession(
      session([
        req("GET", "https://shop.example.com/api/v1/products?q=keyboard&page=1"),
        req("GET", "https://shop.example.com/api/v1/products?q=mouse&page=2"),
        req("GET", "https://shop.example.com/api/v1/products/101"),
        req("GET", "https://shop.example.com/api/v1/products/102"),
        req("GET", "https://shop.example.com/api/v1/orders", {
          response: { status: 200, contentType: "application/json", size: 2, json: [{ id: 1 }] },
        }),
        req("POST", "https://shop.example.com/api/v1/cart/items", { body: { contentType: "application/json", json: { productId: 1, qty: 2 } } }),
        req("DELETE", "https://shop.example.com/api/v1/cart/items/55"),
        req("POST", "https://shop.example.com/api/auth/login", { body: { contentType: "application/x-www-form-urlencoded", form: { user: "a", password: "<redacted>" } } }),
      ]),
    );
    expect(tools.map((t) => t.name)).toEqual([
      "search_products",
      "get_product",
      "list_orders",
      "create_cart_items",
      "delete_cart_item",
      "login_auth",
    ]);

    const search = tools[0]!;
    expect(search.samples).toBe(2);
    const q = search.params.find((p) => p.arg === "q")!;
    expect(q).toMatchObject({ in: "query", required: true, shape: { kind: "string" } });
    const page = search.params.find((p) => p.arg === "page")!;
    expect(page).toMatchObject({ required: false, example: 2, shape: { kind: "integer" } });

    const get = tools[1]!;
    expect(get.pathTemplate).toBe("/api/v1/products/{productId}");
    expect(get.params[0]).toMatchObject({ arg: "productId", in: "path", required: true, shape: { kind: "integer" } });
    expect(get.readOnly).toBe(true);

    const cart = tools[3]!;
    expect(cart.readOnly).toBe(false);
    expect(cart.params.map((p) => [p.arg, p.in, p.example])).toEqual([
      ["productId", "body", 1],
      ["qty", "body", 2],
    ]);

    const login = tools[5]!;
    expect(login.params.find((p) => p.arg === "password")).toMatchObject({ in: "form", required: true, example: undefined });
  });

  it("splits GraphQL operations into separate tools with variables as params", () => {
    const gql = (op: string, query: string, variables: Record<string, unknown>) =>
      req("POST", "https://shop.example.com/graphql", { body: { contentType: "application/json", json: { operationName: op, query, variables } } });
    const tools = analyzeSession(
      session([
        gql("SearchProducts", "query SearchProducts($term: String!) { products(term: $term) { id } }", { term: "a" }),
        gql("AddToCart", "mutation AddToCart($id: ID!) { add(id: $id) { ok } }", { id: "1" }),
      ]),
    );
    expect(tools.map((t) => t.name)).toEqual(["search_products", "add_to_cart"]);
    expect(tools[0]!.graphql?.operationName).toBe("SearchProducts");
    expect(tools[0]!.readOnly).toBe(true);
    expect(tools[1]!.readOnly).toBe(false);
    expect(tools[0]!.params.map((p) => p.arg)).toEqual(["term"]);
  });

  it("avoids arg collisions between query and body", () => {
    const [tool] = analyzeSession(
      session([req("POST", "https://shop.example.com/api/items?id=1", { body: { contentType: "application/json", json: { id: 2, "first-name": "x" } } })]),
    );
    expect(tool!.params.map((p) => p.arg)).toEqual(["id", "body_id", "first_name"]);
  });
});

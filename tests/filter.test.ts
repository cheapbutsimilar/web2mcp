import { describe, expect, it } from "vitest";
import { isSecretHeader, parseCookieNames, shouldCapture, splitHeaders } from "../src/filter.js";

const base = { method: "GET", resourceType: "fetch", status: 200, responseContentType: "application/json" };

describe("shouldCapture", () => {
  it("keeps JSON fetch/xhr API calls", () => {
    expect(shouldCapture({ ...base, url: "https://shop.example.com/api/products?q=x" })).toEqual({ keep: true });
    expect(shouldCapture({ ...base, resourceType: "xhr", url: "https://shop.example.com/graphql" }).keep).toBe(true);
  });

  it.each([
    ["image", "https://shop.example.com/logo.png", "resource:image"],
    ["font", "https://shop.example.com/a.woff2", "resource:font"],
    ["stylesheet", "https://shop.example.com/a.css", "resource:stylesheet"],
    ["document", "https://shop.example.com/", "resource:document"],
  ])("drops non-API resource type %s", (resourceType, url, reason) => {
    expect(shouldCapture({ ...base, resourceType, url })).toEqual({ keep: false, reason });
  });

  it("drops static files fetched via fetch()", () => {
    expect(shouldCapture({ ...base, url: "https://x.com/app.js" })).toMatchObject({ keep: false, reason: "static-asset" });
  });

  it.each([
    "https://www.google-analytics.com/g/collect?v=2",
    "https://region1.analytics.google.com/g/collect",
    "https://o123.ingest.sentry.io/api/1/envelope/",
    "https://api-js.mixpanel.com/track/",
    "https://shop.example.com/collect?ev=pageview",
    "https://shop.example.com/api/telemetry",
    "https://wcs.naver.net/wcslog.js",
  ])("drops tracker %s", (url) => {
    const r = shouldCapture({ ...base, url });
    expect(r.keep).toBe(false);
  });

  it("drops preflights, errors, HTML and dev-server noise", () => {
    expect(shouldCapture({ ...base, method: "OPTIONS", url: "https://x.com/api" }).keep).toBe(false);
    expect(shouldCapture({ ...base, status: 500, url: "https://x.com/api" }).keep).toBe(false);
    expect(shouldCapture({ ...base, responseContentType: "text/html", url: "https://x.com/api" }).keep).toBe(false);
    expect(shouldCapture({ ...base, url: "http://localhost:3000/__webpack_hmr" }).keep).toBe(false);
  });

  it("does not over-match resource names that merely contain tracker words", () => {
    expect(shouldCapture({ ...base, url: "https://music.example.com/api/tracks/42" }).keep).toBe(true);
  });
});

describe("headers", () => {
  it("splits secrets from replayable headers and drops browser-controlled ones", () => {
    const { replay, secret } = splitHeaders({
      Accept: "application/json",
      "User-Agent": "Mozilla",
      Authorization: "Bearer abc",
      Cookie: "sid=1; theme=dark",
      "X-CSRF-Token": "t",
      "X-Requested-With": "XMLHttpRequest",
      "sec-ch-ua": "x",
      referer: "https://x.com",
    });
    expect(replay).toEqual({ accept: "application/json", "x-requested-with": "XMLHttpRequest" });
    expect(Object.keys(secret).sort()).toEqual(["authorization", "cookie", "x-csrf-token"]);
    expect(parseCookieNames(secret.cookie)).toEqual(["sid", "theme"]);
  });

  it("detects secret-looking header names", () => {
    expect(isSecretHeader("x-api-key")).toBe(true);
    expect(isSecretHeader("X-Session-Id")).toBe(true);
    expect(isSecretHeader("accept-language")).toBe(false);
  });
});

/**
 * Decides which network requests are "meaningful API calls" worth turning into MCP tools.
 * Everything else (static assets, fonts, trackers, HMR, preflights, ...) is dropped.
 */

export interface RequestInfo {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  responseContentType: string;
}

export type FilterResult = { keep: true } | { keep: false; reason: string };

const API_RESOURCE_TYPES = new Set(["xhr", "fetch"]);

const STATIC_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|css|js|mjs|map|mp4|webm|mp3|wav|ogg|pdf|zip|wasm)(\?|$)/i;

/** Well-known analytics / ads / monitoring hosts (matched as suffix). */
export const TRACKER_HOSTS = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "googlesyndication.com",
  "googleadservices.com",
  "doubleclick.net",
  "facebook.net",
  "connect.facebook.net",
  "hotjar.com",
  "hotjar.io",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "sentry.io",
  "ingest.sentry.io",
  "clarity.ms",
  "bat.bing.com",
  "newrelic.com",
  "nr-data.net",
  "browser-intake-datadoghq.com",
  "datadoghq.com",
  "fullstory.com",
  "intercom.io",
  "intercomcdn.com",
  "launchdarkly.com",
  "optimizely.com",
  "branch.io",
  "braze.com",
  "heap.io",
  "heapanalytics.com",
  "posthog.com",
  "tiktok.com/i18n/pixel",
  "analytics.tiktok.com",
  "ads-twitter.com",
  "linkedin.com/px",
  "snap.licdn.com",
  "criteo.com",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "adnxs.com",
  "naver.com/wcslog",
  "wcs.naver.net",
  "kakao.com/pixel",
];

/** Path segments that almost always indicate telemetry rather than product APIs. */
const TRACKER_PATH =
  /(^|\/)(collect|beacon|pixel|telemetry|track|tracking|analytics|metrics|rum|log-event|events?-?batch|gtag|gtm\.js|__?vercel_insights|cdn-cgi)(\/|\.|$)/i;

const DEV_NOISE = /(__webpack_hmr|hot-update|\/sockjs-node|\/@vite\/|\/__nextjs|\/_next\/static|\/livereload)/i;

const API_CONTENT_TYPE = /(json|graphql|xml|text\/plain|x-www-form-urlencoded|javascript-api)/i;

export function isTrackerHost(url: URL): boolean {
  const target = (url.hostname + url.pathname).toLowerCase();
  const host = url.hostname.toLowerCase();
  return TRACKER_HOSTS.some((t) =>
    t.includes("/") ? target.includes(t) : host === t || host.endsWith("." + t),
  );
}

export function shouldCapture(info: RequestInfo): FilterResult {
  let url: URL;
  try {
    url = new URL(info.url);
  } catch {
    return { keep: false, reason: "invalid-url" };
  }
  if (!/^https?:$/.test(url.protocol)) return { keep: false, reason: "non-http" };
  if (info.method === "OPTIONS") return { keep: false, reason: "preflight" };
  if (!API_RESOURCE_TYPES.has(info.resourceType)) return { keep: false, reason: `resource:${info.resourceType}` };
  if (STATIC_EXT.test(url.pathname)) return { keep: false, reason: "static-asset" };
  if (DEV_NOISE.test(url.pathname)) return { keep: false, reason: "dev-noise" };
  if (isTrackerHost(url) || TRACKER_PATH.test(url.pathname)) return { keep: false, reason: "tracker" };
  if (info.status < 200 || info.status >= 300) return { keep: false, reason: `status:${info.status}` };
  const ct = info.responseContentType.toLowerCase();
  if (ct && !API_CONTENT_TYPE.test(ct)) return { keep: false, reason: `content-type:${ct.split(";")[0]}` };
  return { keep: true };
}

// ---------------------------------------------------------------------------
// Sensitive data detection
// ---------------------------------------------------------------------------

const SECRET_HEADER_EXACT = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-csrf-token",
  "x-xsrf-token",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
]);

const SECRET_NAME = /(token|auth|secret|session|csrf|xsrf|api[-_]?key|apikey|signature|password|passwd|bearer|jwt)/i;

export function isSecretHeader(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_HEADER_EXACT.has(n) || SECRET_NAME.test(n);
}

export function isSecretParam(name: string): boolean {
  return SECRET_NAME.test(name) || /^(key|sig|access_key)$/i.test(name);
}

/** Headers that carry semantics worth replaying from the generated server. */
const REPLAY_HEADERS = new Set(["accept", "content-type", "x-requested-with", "accept-language"]);

/** Headers that the browser/runtime controls — never replay. */
const DROP_HEADERS = /^(:|host$|connection$|content-length$|origin$|referer$|user-agent$|sec-|accept-encoding$|cache-control$|pragma$|priority$|upgrade-insecure|dnt$|te$|if-none-match$|if-modified-since$)/i;

export interface SplitHeaders {
  replay: Record<string, string>;
  secret: Record<string, string>;
}

/** Split raw request headers into replayable static headers and secrets. */
export function splitHeaders(all: Record<string, string>): SplitHeaders {
  const replay: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(all)) {
    const name = rawName.toLowerCase();
    if (DROP_HEADERS.test(name)) continue;
    if (isSecretHeader(name)) {
      secret[name] = value;
    } else if (REPLAY_HEADERS.has(name) || name.startsWith("x-")) {
      replay[name] = value;
    }
  }
  return { replay, secret };
}

export function parseCookieNames(cookieHeader: string | undefined): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((c) => c.split("=")[0]?.trim())
    .filter((c): c is string => !!c);
}

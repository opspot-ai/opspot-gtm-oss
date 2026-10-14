import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const DEFAULT_SAFE_FETCH_LIMITS = { maxBytes: 1_000_000, timeoutMs: 15_000, maxRedirects: 3 } as const;

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: HeadersInit;
  fetchImpl?: typeof fetch;
  lookupImpl?: typeof lookup;
};

function unsafeIp(address: string): boolean {
  const normalizedAddress = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalizedAddress);
  if (version === 4) {
    const octets = normalizedAddress.split(".").map(Number);
    const a = octets[0]!;
    const b = octets[1]!;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (version === 6) {
    return normalizedAddress === "::" || normalizedAddress === "::1" || normalizedAddress.startsWith("fc") ||
      normalizedAddress.startsWith("fd") || normalizedAddress.startsWith("fe8") || normalizedAddress.startsWith("fe9") ||
      normalizedAddress.startsWith("fea") || normalizedAddress.startsWith("feb") || normalizedAddress.startsWith("ff") ||
      normalizedAddress.startsWith("::ffff:");
  }
  return true;
}

/** Validates the URL and every DNS answer before an outbound request. */
export async function assertSafeUrl(value: string | URL, lookupImpl: typeof lookup = lookup): Promise<URL> {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`unsafe URL scheme: ${url.protocol}`);
  if (url.username || url.password) throw new Error("unsafe URL credentials");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => unsafeIp(address))) throw new Error(`unsafe URL host: ${url.hostname}`);
  return url;
}

async function validatedTarget(value: string | URL, lookupImpl: typeof lookup): Promise<{ url: URL; address: string; family: number }> {
  const url = await assertSafeUrl(value, lookupImpl);
  const addresses = isIP(url.hostname.replace(/^\[|\]$/g, ""))
    ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: isIP(url.hostname.replace(/^\[|\]$/g, "")) }]
    : await lookupImpl(url.hostname, { all: true, verbatim: true });
  const target = addresses[0];
  if (!target || unsafeIp(target.address)) throw new Error(`unsafe URL host: ${url.hostname}`);
  return { url, address: target.address, family: target.family };
}

function pinnedFetch(target: { url: URL; address: string; family: number }, options: Pick<SafeFetchOptions, "headers" | "timeoutMs">): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(target.url, {
      method: "GET",
      ...(options.headers ? { headers: Object.fromEntries(new Headers(options.headers)) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_SAFE_FETCH_LIMITS.timeoutMs),
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      }
    }, (incoming) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      resolve(new Response(incoming as never, { status: incoming.statusCode ?? 500, ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}), headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function limitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** Fetches only public HTTP(S) targets, revalidating each redirect and limiting the streamed body. */
export async function safeFetch(value: string | URL, options: SafeFetchOptions = {}): Promise<{ response: Response; body: Uint8Array; url: URL }> {
  const lookupImpl = options.lookupImpl ?? lookup;
  const maxBytes = options.maxBytes ?? DEFAULT_SAFE_FETCH_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SAFE_FETCH_LIMITS.timeoutMs;
  const maxRedirects = options.maxRedirects ?? DEFAULT_SAFE_FETCH_LIMITS.maxRedirects;
  let target = await validatedTarget(value, lookupImpl);
  for (let redirects = 0; ; redirects += 1) {
    const response = options.fetchImpl
      ? await options.fetchImpl(target.url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), ...(options.headers ? { headers: options.headers } : {}) })
      : await pinnedFetch(target, { timeoutMs, ...(options.headers ? { headers: options.headers } : {}) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, body: await limitedBody(response, maxBytes), url: target.url };
    if (redirects >= maxRedirects) throw new Error(`redirect limit exceeded: ${maxRedirects}`);
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect missing location");
    target = await validatedTarget(new URL(location, target.url), lookupImpl);
  }
}

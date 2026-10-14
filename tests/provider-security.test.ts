import { describe, expect, it } from "vitest";
import { OpenAIResponsesAdapter } from "../packages/adapters/src/openai.js";
import { decryptSecret, encryptSecret, redactSecret } from "../packages/adapters/src/secrets.js";
import { assertSafeUrl, safeFetch } from "../packages/adapters/src/safe-fetch.js";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }] as never;

describe("provider and security primitives", () => {
  it("uses strict Responses JSON output, hosted web search, citations, and usage", async () => {
    let request: Record<string, unknown> | undefined;
    const adapter = new OpenAIResponsesAdapter("test-key", {
      model: "configured-model",
      fetchImpl: async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: "resp_123", model: "configured-model", output_text: '{"decision":"abstain"}',
          usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16, output_tokens_details: { reasoning_tokens: 2 } },
          output: [
            { type: "web_search_call", action: { type: "search", sources: [{ type: "url", url: "https://example.com/search-source" }] } },
            { content: [{ type: "output_text", text: '{"decision":"abstain"}', annotations: [{ type: "url_citation", url: "https://example.com/source", title: "Source", start_index: 0, end_index: 8 }] }] }
          ]
        }), { headers: { "x-request-id": "req_123" } });
      }
    });
    const result = await adapter.generate("research", { name: "decision", schema: { type: "object" }, parse: (value) => {
      if (!value || typeof value !== "object" || (value as { decision?: unknown }).decision !== "abstain") throw new Error("invalid decision");
      return value as { decision: "abstain" };
    } }, { webSearch: true });
    expect(request).toMatchObject({ model: "configured-model", tools: [{ type: "web_search" }], text: { format: { strict: true } } });
    expect(result).toMatchObject({ output: { decision: "abstain" }, citations: [{ url: "https://example.com/source" }, { url: "https://example.com/search-source" }], usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, reasoningTokens: 2 }, requestId: "req_123" });
  });

  it("rejects private targets and rechecks redirects before reading bounded content", async () => {
    await expect(assertSafeUrl("http://127.0.0.1", publicLookup)).rejects.toThrow(/unsafe URL host/);
    await expect(assertSafeUrl("http://[::ffff:7f00:1]", publicLookup)).rejects.toThrow(/unsafe URL host/);
    await expect(assertSafeUrl("file:///tmp/secret", publicLookup)).rejects.toThrow(/unsafe URL scheme/);
    const seen: string[] = [];
    const fetched = await safeFetch("https://example.com/start", {
      lookupImpl: publicLookup,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return seen.length === 1 ? new Response(null, { status: 302, headers: { location: "https://example.com/end" } }) : new Response("ok");
      }
    });
    expect(new TextDecoder().decode(fetched.body)).toBe("ok");
    expect(seen).toEqual(["https://example.com/start", "https://example.com/end"]);
    await expect(safeFetch("https://example.com", { lookupImpl: publicLookup, maxBytes: 2, fetchImpl: async () => new Response("too long") })).rejects.toThrow(/exceeds 2/);
  });

  it("encrypts secrets with AES-256-GCM and only exposes opaque redaction", () => {
    const key = new Uint8Array(32).fill(7);
    const envelope = encryptSecret(key, "key_2026", "unique-secret-canary", "secret_test");
    expect(envelope.ciphertext).not.toContain("unique-secret-canary");
    expect(decryptSecret(key, envelope)).toBe("unique-secret-canary");
    expect(redactSecret(envelope)).toEqual({ reference: "secret_test", keyId: "key_2026", redacted: true });
    expect(() => decryptSecret(new Uint8Array(32).fill(8), envelope)).toThrow("secret decryption failed");
  });
});

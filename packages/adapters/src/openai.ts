export type JsonSchemaOutput<T> = { name: string; schema: Record<string, unknown>; parse(value: unknown): T };
export type WebCitation = { url: string; title?: string; startIndex?: number; endIndex?: number };
export type ModelUsage = { inputTokens: number; outputTokens: number; totalTokens: number; reasoningTokens?: number };
export type ResponsesResult<T> = { output: T; citations: WebCitation[]; usage: ModelUsage; requestId?: string; responseId: string; model: string };

type ResponsesPayload = {
  id?: unknown; model?: unknown; output_text?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown; output_tokens_details?: { reasoning_tokens?: unknown } };
  output?: Array<{
    type?: unknown;
    action?: { type?: unknown; url?: unknown; sources?: Array<{ type?: unknown; url?: unknown }> };
    content?: Array<{ type?: unknown; text?: unknown; annotations?: Array<{ type?: unknown; url?: unknown; title?: unknown; start_index?: unknown; end_index?: unknown }> }>;
  }>;
  error?: { type?: unknown; code?: unknown; param?: unknown };
};

function number(value: unknown): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("OpenAI response has invalid usage"); return value; }

function safeErrorToken(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.[\]-]{1,100}$/.test(value) ? value : undefined;
}

function outputText(response: ResponsesPayload): string {
  if (typeof response.output_text === "string") return response.output_text;
  const text = response.output?.flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text).filter((item): item is string => typeof item === "string").join("");
  if (!text) throw new Error("OpenAI response has no output text");
  return text;
}

function citations(response: ResponsesPayload): WebCitation[] {
  const seen = new Set<string>();
  const found: WebCitation[] = [];
  for (const annotation of (response.output ?? []).flatMap((item) => item.content ?? []).flatMap((item) => item.annotations ?? [])) {
    if (annotation.type !== "url_citation" || typeof annotation.url !== "string" || !/^https?:\/\//.test(annotation.url) || seen.has(annotation.url)) continue;
    seen.add(annotation.url);
    found.push({ url: annotation.url, ...(typeof annotation.title === "string" ? { title: annotation.title } : {}), ...(typeof annotation.start_index === "number" ? { startIndex: annotation.start_index } : {}), ...(typeof annotation.end_index === "number" ? { endIndex: annotation.end_index } : {}) });
  }
  for (const item of response.output ?? []) {
    const urls = [item.action?.url, ...(item.action?.sources ?? []).map((source) => source.url)];
    for (const url of urls) {
      if (typeof url !== "string" || !/^https?:\/\//.test(url) || seen.has(url)) continue;
      seen.add(url);
      found.push({ url });
    }
  }
  return found;
}

export class OpenAIResponsesAdapter {
  constructor(private readonly apiKey: string, private readonly options: { model?: string; timeoutMs?: number; maxOutputTokens?: number; safetyIdentifier?: string; fetchImpl?: typeof fetch } = {}) {}

  async generate<T>(input: string, format: JsonSchemaOutput<T>, options: { instructions?: string; webSearch?: boolean; model?: string } = {}): Promise<ResponsesResult<T>> {
    if (!this.apiKey) throw new Error("OpenAI API key is required");
    const response = await (this.options.fetchImpl ?? fetch)("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      body: JSON.stringify({ model: options.model ?? this.options.model ?? "gpt-5.6-terra", input, ...(options.instructions ? { instructions: options.instructions } : {}), max_output_tokens: this.options.maxOutputTokens ?? 2_000, reasoning: { effort: "low" }, ...(this.options.safetyIdentifier ? { safety_identifier: this.options.safetyIdentifier } : {}), text: { format: { type: "json_schema", name: format.name, strict: true, schema: format.schema } }, ...(options.webSearch ? { tools: [{ type: "web_search" }], include: ["web_search_call.action.sources"] } : {}) })
    });
    const body = await response.json().catch(() => { throw new Error("OpenAI response is not JSON"); }) as ResponsesPayload;
    if (!response.ok) {
      const details = [safeErrorToken(body.error?.type), safeErrorToken(body.error?.code), safeErrorToken(body.error?.param)].filter(Boolean).join("/");
      throw new Error(`OpenAI Responses API error ${response.status}${details ? ` (${details})` : ""}`);
    }
    if (typeof body.id !== "string" || typeof body.model !== "string" || !body.usage) throw new Error("OpenAI response is missing required fields");
    let parsed: unknown;
    try { parsed = JSON.parse(outputText(body)); } catch { throw new Error("OpenAI response is not valid JSON output"); }
    return { output: format.parse(parsed), citations: citations(body), usage: { inputTokens: number(body.usage.input_tokens), outputTokens: number(body.usage.output_tokens), totalTokens: number(body.usage.total_tokens), ...(typeof body.usage.output_tokens_details?.reasoning_tokens === "number" ? { reasoningTokens: body.usage.output_tokens_details.reasoning_tokens } : {}) }, ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}), responseId: body.id, model: body.model };
  }
}

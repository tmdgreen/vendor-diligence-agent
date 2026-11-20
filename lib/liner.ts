// Liner Platform API 연결부. 이 파일이 Liner 를 부르는 유일한 곳이다.
//  - 웹 검색      POST /tools/search/web
//  - 검색 MCP     /mcp 의 search_finance · search_legal (금융·법률 전문 검색)
//  - 모델 Router  POST /chat/completions (검색 결과 분류, 품의서 문안)
//  - Search Agent POST /agents/search (쟁점 한 건을 깊게 확인)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = "https://platform.liner.com/api/v1";
export const MODEL = process.env.LINER_MODEL || "liner-claude-router";

export class LinerError extends Error {}

function key(): string {
  const k = process.env.LINER_API_KEY?.trim();
  if (!k) throw new LinerError("LINER_API_KEY 가 설정되지 않았습니다. .env.local 에 넣어 주세요.");
  return k;
}

export function hasKey() {
  return !!process.env.LINER_API_KEY?.trim();
}

async function post(path: string, body: unknown, timeoutMs: number): Promise<Response> {
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res;
    last = `${res.status} ${(await res.text()).slice(0, 300)}`;
    // 429 와 5xx 만 다시 시도한다. 400·401·402 는 다시 해도 같다.
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 2 * (attempt + 1)) * 1000));
  }
  throw new LinerError(`Liner ${path} 실패: ${last}`);
}

export type Hit = { title: string; url: string; hostname: string; date: string; snippet: string };

function host(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function toHit(r: Record<string, unknown>): Hit | null {
  const url = String(r.url ?? r.link ?? "");
  if (!/^https?:\/\//.test(url)) return null;
  return {
    title: String(r.title ?? "").slice(0, 200),
    url,
    hostname: String(r.hostname ?? r.domain ?? host(url)),
    date: String(r.date ?? r.publishedDate ?? r.published_date ?? ""),
    snippet: String(r.description ?? r.snippet ?? r.content ?? "").slice(0, 600),
  };
}

export async function searchWeb(query: string, max = 8): Promise<Hit[]> {
  const res = await post(
    "/tools/search/web",
    { query, lang: "ko", country_code: "KR", date_range: "past_year", max_results: max, include_knowledge: false },
    30000,
  );
  const json = (await res.json()) as { results?: Record<string, unknown>[] };
  return (json.results ?? []).map(toHit).filter((h): h is Hit => !!h);
}

// --- 검색 MCP -------------------------------------------------------------

let mcp: Promise<Client> | null = null;

function mcpClient(): Promise<Client> {
  if (!mcp) {
    mcp = (async () => {
      const client = new Client({ name: "counterparty-diligence", version: "0.1.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${key()}` } },
        }),
      );
      return client;
    })();
    mcp.catch(() => (mcp = null));
  }
  return mcp;
}

function findResults(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === "object") as Record<string, unknown>[];
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["results", "items", "data"]) if (Array.isArray(o[k])) return findResults(o[k]);
  }
  return [];
}

/** search_finance · search_legal 같은 전문 검색. 결과 형식은 웹 검색과 같다고 문서에 적혀 있다. */
export async function searchMcp(tool: string, query: string): Promise<Hit[]> {
  const client = await mcpClient();
  const out = await client.callTool({ name: tool, arguments: { query, limit: 8 } }, undefined, { timeout: 30000 });
  if (out.isError) throw new LinerError(`MCP ${tool} 오류: ${JSON.stringify(out.content).slice(0, 200)}`);
  let rows = findResults(out.structuredContent);
  if (!rows.length) {
    for (const c of (out.content ?? []) as { type: string; text?: string }[]) {
      if (c.type !== "text" || !c.text) continue;
      try {
        rows = rows.concat(findResults(JSON.parse(c.text)));
      } catch {
        // JSON 이 아닌 글이면 버린다. 출처 주소를 확인할 수 없는 내용은 쓰지 않는다.
      }
    }
  }
  return rows.map(toHit).filter((h): h is Hit => !!h);
}

// --- 모델 Router ----------------------------------------------------------

type Msg = { role: "system" | "user"; content: string };

export async function chatJson<T>(messages: Msg[], name: string, schema: object): Promise<T> {
  const res = await post(
    "/chat/completions",
    {
      model: MODEL,
      messages,
      reasoning_effort: "low",
      max_completion_tokens: 4000,
      response_format: { type: "json_schema", json_schema: { name, schema, strict: true } },
    },
    110000,
  );
  const json = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new LinerError("모델 응답이 비어 있습니다.");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new LinerError(`모델이 JSON 이 아닌 답을 돌려줬습니다(finish_reason=${json.choices?.[0]?.finish_reason}).`);
  }
}

export async function chatText(messages: Msg[]): Promise<string> {
  const res = await post("/chat/completions", { model: MODEL, messages, reasoning_effort: "low", max_completion_tokens: 3000 }, 110000);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content;
  if (!text) throw new LinerError("모델 응답이 비어 있습니다.");
  return text;
}

// --- Search Agent ---------------------------------------------------------

export type AgentEvent = { type: "delta"; text: string } | { type: "references"; refs: Hit[] } | { type: "error"; message: string };

/** 답을 흘려보낸다. 스트림이 열린 뒤의 오류는 HTTP 200 안에 data-error 로 온다.
 *  data-search-references 는 검색 단계마다 여러 번 온다. 본문의 ((n)) 번호는 누적 목록 기준이므로 매번 합친 전체 목록을 보낸다. */
export async function* searchAgent(question: string): AsyncGenerator<AgentEvent> {
  const res = await post("/agents/search", { messages: [{ role: "user", content: question }], lang: "ko", stream: true }, 320000);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finished = false;
  let failed = false;
  const refs: Hit[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        if (!finished && !failed) yield { type: "error", message: "답이 끝나기 전에 연결이 닫혔습니다. 위 내용은 일부입니다." };
        return;
      }
      let ev: { type?: string; delta?: string; data?: { references?: Record<string, unknown>[]; message?: string; code?: string } };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.type === "finish") finished = true;
      else if (ev.type === "text-delta" && ev.delta) yield { type: "delta", text: ev.delta };
      else if (ev.type === "data-search-references")
      {
        for (const r of ev.data?.references ?? []) refs.push(toHit(r) ?? { title: "", url: "", hostname: "", date: "", snippet: "" });
        yield { type: "references", refs: [...refs] };
      }
      else if (ev.type === "data-error") {
        failed = true;
        yield { type: "error", message: `${ev.data?.code ?? ""} ${ev.data?.message ?? ""}`.trim() };
      }
    }
  }
  // [DONE] 없이 끝났다.
  yield { type: "error", message: "답이 끝나기 전에 연결이 닫혔습니다. 위 내용은 일부입니다." };
}

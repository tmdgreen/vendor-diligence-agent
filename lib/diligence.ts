import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import rules from "@/config/rules.json";
import { fetchFinancials, type Financials } from "./dart";
import { chatJson, MODEL, searchMcp, searchWeb, type Hit } from "./liner";
import { buildFlags, buildMetrics, buildTerms } from "./metrics";
import type { LinerCall, Report, Signal, Source, StreamEvent } from "./types";

const DATA = join(process.cwd(), "data");

function norm(s: string) {
  return s.replace(/\s|\(주\)|㈜|주식회사/g, "").toLowerCase();
}

function cached(): Financials[] {
  const dir = join(DATA, "financials");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Financials);
}

export function demoCompanies(): string[] {
  return cached().map((f) => f.corpName);
}

async function loadFinancials(name: string): Promise<{ fin: Financials | null; note: string }> {
  const hit = cached().find((f) => norm(f.corpName) === norm(name));
  if (hit) return { fin: hit, note: `저장된 공시 자료(${hit.fetchedAt} 기준)` };

  const dartKey = process.env.DART_API_KEY?.trim();
  if (!dartKey) return { fin: null, note: "저장된 공시 자료가 없고 DART_API_KEY 도 없어 재무 수치를 확인하지 못함" };

  const codes = JSON.parse(readFileSync(join(DATA, "corp-codes.json"), "utf8")) as Record<string, [string, string]>;
  const entry = Object.entries(codes).find(([n]) => norm(n) === norm(name));
  if (!entry) return { fin: null, note: "상장사 목록에 없는 회사라 공시 재무 수치를 확인하지 못함" };
  try {
    const fin = await fetchFinancials(
      { corpCode: entry[1][0], corpName: entry[0], stockCode: entry[1][1] },
      dartKey,
      new Date().getFullYear() - 1,
    );
    return fin ? { fin, note: "DART 에서 방금 조회" } : { fin: null, note: "최근 2년 안에 낸 사업보고서를 찾지 못함" };
  } catch (e) {
    return { fin: null, note: `DART 조회 실패: ${(e as Error).message}` };
  }
}

const SIGNAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["signals"],
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["topic", "severity", "title", "summary", "date", "sources"],
        properties: {
          topic: { type: "string", enum: rules.searchTopics.map((t) => t.id) },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          title: { type: "string" },
          summary: { type: "string" },
          date: { type: "string" },
          sources: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
};

const SYSTEM = `당신은 거래처 신용을 심사하는 재무 담당자를 돕는다. 검색 결과 목록을 읽고, 대상 회사에 외상을 줘도 되는지 판단하는 데 영향을 주는 위험 신호만 골라낸다.

규칙
- 검색 결과에 적힌 내용만 쓴다. 목록에 없는 사실, 추측, 일반론은 쓰지 않는다.
- 대상 회사에 관한 내용이 아니면 버린다. 이름이 비슷한 다른 회사, 같은 그룹의 다른 계열사, 업계 일반 기사는 대상이 아니다.
- 같은 사건을 다룬 결과는 하나의 신호로 묶고 sources 에 번호를 모두 적는다.
- 호재, 단순 홍보, 실적 발표, 주가 등락은 위험 신호가 아니다.
- sources 에는 근거가 된 검색 결과의 번호만 적는다. 근거 번호가 없는 신호는 만들지 않는다.
- severity: high = 대금을 못 받을 가능성과 바로 이어지는 일(회생·부도·워크아웃, 감사의견 비적정, 대규모 가압류, 대금 미지급 다수). medium = 재무나 평판에 뚜렷한 부담(큰 소송, 과징금, 신용등급 하향, 경영진 형사 사건). low = 지켜볼 일.
- title 은 20자 안팎의 사실 서술, summary 는 무슨 일이 있었고 왜 대금 회수에 영향을 주는지 두 문장 이내. date 는 사건 날짜(YYYY-MM-DD 또는 YYYY-MM), 모르면 빈 문자열.
- 위험 신호가 없으면 signals 를 빈 배열로 둔다. 억지로 채우지 않는다.`;

export async function runDiligence(
  input: { name: string; monthlyAmount: number; paymentDays: number },
  emit: (e: StreamEvent) => void,
): Promise<Report> {
  const calls: LinerCall[] = [];
  const name = input.name.trim();

  // 1) 공시 재무
  emit({ type: "step", id: "fin", label: "공시 재무 수치 불러오기", status: "run" });
  const { fin, note } = await loadFinancials(name);
  const metrics = buildMetrics(fin);
  const flags = buildFlags(fin);
  emit({ type: "step", id: "fin", label: "공시 재무 수치 불러오기", status: fin ? "done" : "fail", detail: note });

  // 2) 주제별 검색 (Liner)
  const sources: Source[] = [];
  const seen = new Set<string>();
  const unchecked: string[] = [];
  const failures: string[] = []; // 실패는 "신호 없음"과 다르다. 등급 산정을 막는다.
  await Promise.all(
    rules.searchTopics.map(async (t) => {
      const query = t.query.replace("{name}", name);
      const id = `search-${t.id}`;
      emit({ type: "step", id, label: `${t.label} 검색`, status: "run", api: t.tool });
      const t0 = Date.now();
      let hits: Hit[] = [];
      let used = t.tool;
      let err = "";
      try {
        hits = t.tool === "search_web" ? await searchWeb(query) : await searchMcp(t.tool, query);
      } catch (e) {
        err = (e as Error).message;
      }
      if (t.tool !== "search_web") {
        calls.push({ step: t.label, api: `MCP ${t.tool}`, detail: err || `${hits.length}건`, ms: Date.now() - t0, ok: !err });
        if (!hits.length) {
          // 전문 검색이 실패했거나 비었으면 일반 웹 검색으로 한 번 더 찾는다.
          const t1 = Date.now();
          used = "search_web";
          try {
            hits = await searchWeb(query);
            err = "";
          } catch (e) {
            err = (e as Error).message;
          }
          calls.push({ step: t.label, api: "웹 검색", detail: err || `${hits.length}건(대체 검색)`, ms: Date.now() - t1, ok: !err });
        }
      } else calls.push({ step: t.label, api: "웹 검색", detail: err || `${hits.length}건`, ms: Date.now() - t0, ok: !err });

      for (const h of hits) {
        if (seen.has(h.url)) continue;
        seen.add(h.url);
        sources.push({ n: 0, ...h, topic: t.id, tool: used });
      }
      if (err) failures.push(`${t.label} 검색`);
      if (err) unchecked.push(`${t.label}: 검색 실패(${err.slice(0, 80)})`);
      else if (!hits.length) unchecked.push(`${t.label}: 검색 결과 없음`);
      emit({ type: "step", id, label: `${t.label} 검색`, status: err ? "fail" : "done", detail: err ? err.slice(0, 120) : `${hits.length}건`, api: used });
    }),
  );
  sources.forEach((s, i) => (s.n = i + 1));

  // 3) 위험 신호 분류 (Liner 모델)
  let signals: Signal[] = [];
  if (sources.length) {
    emit({ type: "step", id: "classify", label: "위험 신호 가려내기", status: "run", api: MODEL });
    const t0 = Date.now();
    try {
      const list = sources
        .map((s) => `[${s.n}] (${rules.searchTopics.find((t) => t.id === s.topic)?.label}) ${s.date || "날짜 없음"} · ${s.hostname}\n제목: ${s.title}\n내용: ${s.snippet}`)
        .join("\n\n");
      const out = await chatJson<{ signals: Signal[] }>(
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: `대상 회사: ${name}\n오늘: ${new Date().toISOString().slice(0, 10)}\n\n검색 결과\n${list}\n\nJSON 으로 답하라.` },
        ],
        "risk_signals",
        SIGNAL_SCHEMA,
      );
      const valid = new Set(sources.map((s) => s.n));
      const order = { high: 0, medium: 1, low: 2 };
      signals = out.signals
        .map((s) => ({
          ...s,
          sources: [...new Set(s.sources)].filter((n) => valid.has(n)),
          topicLabel: rules.searchTopics.find((t) => t.id === s.topic)?.label ?? s.topic,
        }))
        .filter((s) => s.sources.length > 0) // 근거 없는 신호는 버린다
        .sort((a, b) => order[a.severity] - order[b.severity]);
      calls.push({ step: "위험 신호 분류", api: `모델 ${MODEL}`, detail: `검색 결과 ${sources.length}건 → 신호 ${signals.length}건`, ms: Date.now() - t0, ok: true });
      emit({ type: "step", id: "classify", label: "위험 신호 가려내기", status: "done", detail: `${signals.length}건`, api: MODEL });
    } catch (e) {
      const msg = (e as Error).message;
      calls.push({ step: "위험 신호 분류", api: `모델 ${MODEL}`, detail: msg, ms: Date.now() - t0, ok: false });
      failures.push("위험 신호 분류");
      unchecked.push(`위험 신호 분류 실패: 검색 결과 ${sources.length}건을 사람이 직접 읽어야 함`);
      emit({ type: "step", id: "classify", label: "위험 신호 가려내기", status: "fail", detail: msg.slice(0, 120), api: MODEL });
    }
  }

  // 4) 등급과 거래 조건 (규칙)
  const request = { monthlyAmount: input.monthlyAmount, paymentDays: input.paymentDays };
  const terms = buildTerms(fin, metrics, flags, signals, request, failures);
  emit({ type: "step", id: "terms", label: "등급·거래 조건 계산", status: "done", detail: failures.length ? "판정 보류" : `${terms.grade}등급` });

  return {
    company: fin?.corpName ?? name,
    asOf: new Date().toISOString().slice(0, 10),
    request,
    financials: fin,
    financialsNote: note,
    metrics,
    flags,
    signals,
    unchecked,
    sources,
    terms,
    linerCalls: calls,
  };
}

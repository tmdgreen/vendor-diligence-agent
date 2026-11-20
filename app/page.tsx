"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Level, Report, Signal, StreamEvent } from "@/lib/types";

// Search Agent 본문의 인용 표시. 예: "인가했다 ((5))."
const CITE = /\s*\(\((\d+)\)\)/g;
const cited = (text: string) => new Set([...text.matchAll(CITE)].map((m) => Number(m[1])));

function Md({ children }: { children: string }) {
  return (
    <div className="md text-sm leading-relaxed text-slate-800">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: (p) => <a {...p} target="_blank" rel="noreferrer" /> }}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

type Step = Extract<StreamEvent, { type: "step" }>;
type Deep = { text: string; refs: { title: string; url: string; hostname: string }[]; error?: string; running: boolean };

const LEVEL: Record<Level, { text: string; cls: string }> = {
  ok: { text: "양호", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  warn: { text: "주의", cls: "bg-amber-50 text-amber-800 ring-amber-200" },
  danger: { text: "위험", cls: "bg-red-50 text-red-700 ring-red-200" },
  critical: { text: "치명", cls: "bg-red-600 text-white ring-red-600" },
  unknown: { text: "확인 못 함", cls: "bg-slate-100 text-slate-600 ring-slate-200" },
};
const SEV = { high: LEVEL.danger, medium: LEVEL.warn, low: { text: "관찰", cls: "bg-sky-50 text-sky-700 ring-sky-200" } };
const GRADE: Record<string, string> = { A: "bg-emerald-600", B: "bg-sky-600", C: "bg-amber-500", D: "bg-red-600", 보류: "bg-slate-500" };

const won = (n: number) => (Math.abs(n) >= 1e8 ? `${(n / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억원` : `${Math.round(n / 1e4).toLocaleString("ko-KR")}만원`);
const fmt = (v: number | null, unit: string) => (v == null ? "–" : `${v.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}${unit}`);

function Badge({ cls, children }: { cls: string; children: React.ReactNode }) {
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ${cls}`}>{children}</span>;
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-bold text-slate-900">{title}</h2>
        {aside && <div className="text-xs text-slate-500">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

async function readLines<T>(res: Response, on: (e: T) => void) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) on(JSON.parse(line) as T);
    }
  }
}

export default function Page() {
  const [env, setEnv] = useState<{ demo: string[]; linerKey: boolean; dartKey: boolean } | null>(null);
  const [name, setName] = useState("");
  const [monthly, setMonthly] = useState("50"); // 백만원
  const [days, setDays] = useState("60");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);

  const [excluded, setExcluded] = useState<number[]>([]);
  const [deep, setDeep] = useState<Record<number, Deep>>({});
  const [review, setReview] = useState({ decision: "조건부 승인", paymentDays: "", creditLimit: "", collateral: "", comment: "", reviewer: "" });
  const [memo, setMemo] = useState("");
  // 품의서를 만들 때 넣은 신호 번호. 만든 뒤 체크를 바꿔도 품의서 본문과 아래 출처 목록이 어긋나지 않게 고정한다.
  const [memoExcluded, setMemoExcluded] = useState<number[]>([]);
  const [memoBusy, setMemoBusy] = useState(false);
  const [memoError, setMemoError] = useState("");
  const [copied, setCopied] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  // 점검을 새로 시작하면 이전 회사의 품의서·심층 확인 요청을 끊는다. 늦게 온 답이 새 화면에 섞이지 않게 한다.
  const session = useRef<AbortController>(new AbortController());

  useEffect(() => {
    fetch("/api/companies")
      .then((r) => r.json())
      .then(setEnv)
      .catch(() => setEnv({ demo: [], linerKey: false, dartKey: false }));
  }, []);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    if (running) return;
    session.current.abort();
    session.current = new AbortController();
    setRunning(true);
    setMemoBusy(false);
    setSteps([]);
    setError("");
    setReport(null);
    setExcluded([]);
    setDeep({});
    setMemo("");
    setMemoError("");
    try {
      const res = await fetch("/api/diligence", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, monthlyAmount: Number(monthly) * 1e6, paymentDays: Number(days) }),
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `요청 실패(${res.status})`);
      await readLines<StreamEvent>(res, (ev) => {
        if (ev.type === "step") setSteps((s) => [...s.filter((x) => x.id !== ev.id), ev]);
        else if (ev.type === "error") setError(ev.message);
        else {
          setReport(ev.report);
          const t = ev.report.terms;
          setReview((r) => ({
            ...r,
            decision: t.grade === "A" ? "승인" : t.grade === "D" ? "반려" : t.grade === "보류" ? "보류" : "조건부 승인",
            paymentDays: String(t.paymentDays),
            creditLimit: String(t.creditLimit / 1e6),
            collateral: t.collateral,
            comment: "",
          }));
          setTimeout(() => reportRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
        }
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function deepCheck(i: number, s: Signal) {
    if (!report || deep[i]?.running) return;
    const ctl = session.current;
    const set = (f: (d: Deep) => Deep) => !ctl.signal.aborted && setDeep((all) => ({ ...all, [i]: f(all[i] ?? { text: "", refs: [], running: true }) }));
    setDeep((all) => ({ ...all, [i]: { text: "", refs: [], running: true } }));
    try {
      const res = await fetch("/api/deepcheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ company: report.company, title: s.title, summary: s.summary }),
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? `요청 실패(${res.status})`);
      type Ev = { type: "delta"; text: string } | { type: "references"; refs: Deep["refs"] } | { type: "error"; message: string };
      await readLines<Ev>(res, (ev) => {
        if (ev.type === "delta") set((d) => ({ ...d, text: d.text + ev.text }));
        else if (ev.type === "references") set((d) => ({ ...d, refs: ev.refs }));
        else set((d) => ({ ...d, error: ev.message }));
      });
    } catch (err) {
      set((d) => ({ ...d, error: (err as Error).message }));
    } finally {
      set((d) => ({ ...d, running: false, error: d.error ?? (d.text ? undefined : "답을 받지 못했습니다.") }));
    }
  }

  async function makeMemo() {
    if (!report || memoBusy) return;
    const ctl = session.current;
    const pd = Number(review.paymentDays);
    const cl = Number(review.creditLimit);
    if (review.paymentDays === "" || !(pd >= 0 && pd <= 365) || review.creditLimit === "" || !(cl >= 0)) {
      setMemoError("결제 기한은 0~365일, 외상 한도는 0 이상으로 적어 주세요.");
      return;
    }
    const snapshot = [...excluded];
    setMemoBusy(true);
    setMemoError("");
    try {
      const res = await fetch("/api/memo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          report,
          review: { ...review, paymentDays: pd, creditLimit: cl * 1e6, excluded: snapshot },
        }),
        signal: ctl.signal,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `요청 실패(${res.status})`);
      if (!ctl.signal.aborted) {
        setMemo(json.text);
        setMemoExcluded(snapshot);
      }
    } catch (err) {
      if (!ctl.signal.aborted) setMemoError((err as Error).message);
    } finally {
      if (!ctl.signal.aborted) setMemoBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-900";
  const label = "mb-1 block text-xs font-semibold text-slate-600";
  const changed =
    report && (Number(review.paymentDays) !== report.terms.paymentDays || Number(review.creditLimit) * 1e6 !== report.terms.creditLimit);
  const fin = report?.financials;

  return (
    <main className="mx-auto w-full max-w-4xl space-y-5 px-5 py-10">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">거래처 실사 에이전트</h1>
        <p className="mt-1 text-sm text-slate-600">
          외상 거래를 트기 전에 공시 재무 수치와 최근 악재를 모아 등급과 거래 조건 초안을 만듭니다. 결정은 담당자가 합니다.
        </p>
      </header>

      {env && !env.linerKey && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          LINER_API_KEY 가 없습니다. <code>.env.local</code> 에 키를 넣고 서버를 다시 실행해 주세요.
        </p>
      )}

      <Card title="점검할 거래">
        <form onSubmit={run} className="grid gap-3 sm:grid-cols-[1fr_9rem_8rem_auto] sm:items-end">
          <div>
            <label className={label} htmlFor="name">거래처 회사명</label>
            <input id="name" list="demo" required value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 컬리" className={input} />
            <datalist id="demo">{env?.demo.map((d) => <option key={d} value={d} />)}</datalist>
          </div>
          <div>
            <label className={label} htmlFor="monthly">월 거래액(백만원)</label>
            <input id="monthly" type="number" min="1" required value={monthly} onChange={(e) => setMonthly(e.target.value)} className={input} />
          </div>
          <div>
            <label className={label} htmlFor="days">희망 결제 기한(일)</label>
            <input id="days" type="number" min="0" max="365" required value={days} onChange={(e) => setDays(e.target.value)} className={input} />
          </div>
          <button disabled={running} className="rounded-lg bg-slate-900 px-5 py-2 text-sm font-bold text-white disabled:opacity-50">
            {running ? "점검 중…" : "점검 시작"}
          </button>
        </form>
        {env && (
          <p className="mt-3 text-xs text-slate-500">
            공시 자료가 들어 있는 회사: {env.demo.join(", ") || "없음"}.{" "}
            {env.dartKey ? "그 밖의 상장사는 DART 에서 바로 조회합니다." : "그 밖의 회사는 재무 수치 없이 검색 결과만으로 점검합니다."}
          </p>
        )}
      </Card>

      {(steps.length > 0 || error) && (
        <Card title="진행 상황">
          <ul className="space-y-1.5 text-sm">
            {steps.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="w-4 text-center">{s.status === "run" ? "…" : s.status === "done" ? "✓" : "✕"}</span>
                <span className={s.status === "fail" ? "text-red-700" : "text-slate-800"}>{s.label}</span>
                {s.api && <Badge cls="bg-violet-50 text-violet-700 ring-violet-200">Liner {s.api}</Badge>}
                {s.detail && <span className="text-xs text-slate-500">{s.detail}</span>}
              </li>
            ))}
          </ul>
          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
        </Card>
      )}

      {report && (
        <div ref={reportRef} className="space-y-5">
          <Card title={`${report.company} 점검 결과`} aside={`${report.asOf} 기준`}>
            <div className="flex flex-wrap items-center gap-5">
              <div className={`flex h-20 w-20 flex-col items-center justify-center rounded-2xl text-white ${GRADE[report.terms.grade]}`}>
                <span className={`font-black leading-none ${report.terms.grade.length > 1 ? "text-xl" : "text-3xl"}`}>{report.terms.grade}</span>
                <span className="mt-1 text-xs font-semibold">{report.terms.label}</span>
              </div>
              <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <div><dt className="text-xs text-slate-500">위험 점수</dt><dd className="font-bold">{report.terms.grade === "보류" ? "–" : `${report.terms.points}점`}</dd></div>
                <div><dt className="text-xs text-slate-500">제안 결제 기한</dt><dd className="font-bold">{report.terms.paymentDays === 0 ? "선입금" : `${report.terms.paymentDays}일`}</dd></div>
                <div><dt className="text-xs text-slate-500">제안 외상 한도</dt><dd className="font-bold">{report.terms.creditLimit > 0 ? won(report.terms.creditLimit) : "없음"}</dd></div>
                <div><dt className="text-xs text-slate-500">담보</dt><dd className="font-bold">{report.terms.collateral}</dd></div>
              </dl>
            </div>
            <p className="mt-3 text-sm text-slate-700">{report.terms.note}</p>
            <p className="mt-1 text-xs text-slate-500">한도 근거: {report.terms.limitBasis}</p>
          </Card>

          <Card
            title="재무 상태"
            aside={fin ? <a className="underline" href={fin.sourceUrl} target="_blank" rel="noreferrer">DART {fin.reportYear}년 사업보고서({fin.fsDiv === "CFS" ? "연결" : "별도"})</a> : undefined}
          >
            {!fin ? (
              <p className="text-sm text-slate-700"><Badge cls={LEVEL.unknown.cls}>확인 못 함</Badge> {report.financialsNote}</p>
            ) : (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                      <th className="py-1.5 font-semibold">지표</th>
                      <th className="py-1.5 text-right font-semibold">{fin.years[0].year}</th>
                      <th className="py-1.5 text-right font-semibold">{fin.years[1].year}</th>
                      <th className="py-1.5 pl-3 font-semibold">판정</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.metrics.map((m) => (
                      <tr key={m.id} className="border-b border-slate-100" title={m.basis}>
                        <td className="py-1.5">{m.label}<div className="text-xs text-slate-400">{m.basis}</div></td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">{fmt(m.value, m.unit)}</td>
                        <td className="py-1.5 text-right tabular-nums text-slate-500">{fmt(m.prev, m.unit)}</td>
                        <td className="py-1.5 pl-3"><Badge cls={LEVEL[m.level].cls}>{LEVEL[m.level].text}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="mt-3 space-y-1.5 text-sm">
                  {report.flags.map((f) => (
                    <li key={f.id}><Badge cls={LEVEL[f.level].cls}>{LEVEL[f.level].text}</Badge> <b>{f.title}</b> <span className="text-slate-600">{f.detail}</span></li>
                  ))}
                  <li className="text-slate-600">
                    감사의견:{" "}
                    {fin.audit[0] ? `${fin.audit[0].year}년 ${fin.audit[0].opinion} (${fin.audit[0].auditor})` : <Badge cls={LEVEL.unknown.cls}>확인 못 함</Badge>}
                  </li>
                </ul>
              </>
            )}
          </Card>

          <Card title={`위험 신호 ${report.signals.length}건`} aside="무관한 항목은 체크를 풀면 품의서에서 빠집니다">
            {report.signals.length === 0 && report.terms.grade !== "보류" && <p className="text-sm text-slate-600">검색 결과 {report.sources.length}건에서 위험 신호를 찾지 못했습니다.</p>}
            {report.terms.grade === "보류" && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">확인에 실패한 항목이 있습니다. 아래 목록은 전부가 아닐 수 있습니다.</p>}
            <ul className="space-y-4">
              {report.signals.map((s, i) => {
                const d = deep[i];
                const off = excluded.includes(i);
                return (
                  <li key={i} className={`rounded-lg border border-slate-200 p-3 ${off ? "opacity-50" : ""}`}>
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={`${s.title} 품의서에 포함`}
                        checked={!off}
                        onChange={() => setExcluded((x) => (off ? x.filter((n) => n !== i) : [...x, i]))}
                        className="mt-1 h-4 w-4"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge cls={SEV[s.severity].cls}>{SEV[s.severity].text}</Badge>
                          <b className="text-sm">{s.title}</b>
                          <span className="text-xs text-slate-500">{s.topicLabel}{s.date && ` · ${s.date}`}</span>
                        </div>
                        <p className="mt-1 text-sm text-slate-700">{s.summary}</p>
                        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                          {s.sources.map((n) => {
                            const src = report.sources.find((x) => x.n === n)!;
                            return <a key={n} href={src.url} target="_blank" rel="noreferrer" className="text-sky-700 underline">[{n}] {src.hostname}{src.date && ` ${src.date}`}</a>;
                          })}
                        </p>
                        <button type="button" onClick={() => deepCheck(i, s)} disabled={d?.running} className="mt-2 rounded border border-violet-300 px-2 py-1 text-xs font-semibold text-violet-700 disabled:opacity-50">
                          {d?.running ? "Search Agent 가 확인하는 중… (30초~1분)" : d ? "다시 확인" : "Liner Search Agent 로 깊게 확인"}
                        </button>
                        {d && (d.text || d.error) && (
                          <div className="mt-2 rounded-lg bg-violet-50 p-3 text-sm">
                            {d.text && <Md>{d.text.replace(CITE, " [$1]")}</Md>}
                            {d.error && <p className="text-red-700">확인 실패: {d.error}</p>}
                            {d.refs.length > 0 && (
                              <ul className="mt-2 space-y-0.5 text-xs">
                                {d.refs.map((r, k) =>
                                  r.url && cited(d.text).has(k + 1) ? (
                                    <li key={k}>[{k + 1}] <a href={r.url} target="_blank" rel="noreferrer" className="text-sky-700 underline">{r.title || r.hostname}</a> <span className="text-slate-500">{r.hostname}</span></li>
                                  ) : null,
                                )}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {report.unchecked.length > 0 && (
              <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm">
                <b>확인하지 못한 사항</b>
                <ul className="mt-1 list-disc pl-5 text-slate-700">{report.unchecked.map((u) => <li key={u}>{u}</li>)}</ul>
              </div>
            )}
            <details className="mt-4 text-xs text-slate-600">
              <summary className="cursor-pointer font-semibold">Liner API 호출 기록 {report.linerCalls.length}건 · 검색 결과 {report.sources.length}건</summary>
              <ul className="mt-2 space-y-0.5">
                {report.linerCalls.map((c, k) => <li key={k}>{c.ok ? "✓" : "✕"} {c.step} — {c.api} · {c.detail} · {(c.ms / 1000).toFixed(1)}초</li>)}
              </ul>
            </details>
          </Card>

          <Card title="담당자 검토" aside="제안값을 고칠 수 있습니다">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <label className={label} htmlFor="decision">결정</label>
                <select id="decision" value={review.decision} onChange={(e) => setReview({ ...review, decision: e.target.value })} className={input}>
                  <option>승인</option><option>조건부 승인</option><option>반려</option><option>보류</option>
                </select>
              </div>
              <div>
                <label className={label} htmlFor="rdays">결제 기한(일)</label>
                <input id="rdays" type="number" min="0" value={review.paymentDays} onChange={(e) => setReview({ ...review, paymentDays: e.target.value })} className={input} />
              </div>
              <div>
                <label className={label} htmlFor="rlimit">외상 한도(백만원)</label>
                <input id="rlimit" type="number" min="0" value={review.creditLimit} onChange={(e) => setReview({ ...review, creditLimit: e.target.value })} className={input} />
              </div>
              <div>
                <label className={label} htmlFor="reviewer">담당자</label>
                <input id="reviewer" value={review.reviewer} onChange={(e) => setReview({ ...review, reviewer: e.target.value })} className={input} />
              </div>
              <div className="sm:col-span-4">
                <label className={label} htmlFor="collateral">담보·보증 조건</label>
                <input id="collateral" value={review.collateral} onChange={(e) => setReview({ ...review, collateral: e.target.value })} className={input} />
              </div>
              <div className="sm:col-span-4">
                <label className={label} htmlFor="comment">검토 의견{changed && " (제안과 다르게 정한 이유를 적어 주세요)"}</label>
                <textarea id="comment" rows={3} value={review.comment} onChange={(e) => setReview({ ...review, comment: e.target.value })} className={input} />
              </div>
            </div>
            <button type="button" onClick={makeMemo} disabled={memoBusy} className="mt-3 rounded-lg bg-slate-900 px-5 py-2 text-sm font-bold text-white disabled:opacity-50">
              {memoBusy ? "품의서 쓰는 중…" : "이 내용으로 품의서 만들기"}
            </button>
            {memoError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{memoError}</p>}
          </Card>

          {memo && (
            <Card
              title="품의서 초안"
              aside={
                <button type="button" className="underline" onClick={() => navigator.clipboard.writeText(memo).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                  {copied ? "복사했습니다" : "복사"}
                </button>
              }
            >
              <Md>{memo}</Md>
              {[...memoExcluded].sort().join() !== [...excluded].sort().join() && (
                <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">품의서를 만든 뒤 위험 신호 선택을 바꿨습니다. 바뀐 내용을 반영하려면 품의서를 다시 만드세요.</p>
              )}
              <ol className="mt-4 space-y-0.5 border-t border-slate-200 pt-3 text-xs text-slate-600">
                {report.sources.filter((s) => report.signals.some((g, i) => !memoExcluded.includes(i) && g.sources.includes(s.n))).map((s) => (
                  <li key={s.n}>[{s.n}] <a href={s.url} target="_blank" rel="noreferrer" className="text-sky-700 underline">{s.title}</a> · {s.hostname} {s.date}</li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      )}
    </main>
  );
}

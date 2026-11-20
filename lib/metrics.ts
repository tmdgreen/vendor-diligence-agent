import rules from "@/config/rules.json";
import type { Financials, YearFin } from "./dart";
import type { Flag, Level, Metric, Signal, Terms } from "./types";

type Rule = { label: string; unit: string; higherIsWorse: boolean; warn: number; danger: number };

function div(a: number | null, b: number | null): number | null {
  if (a == null || b == null || b === 0) return null;
  return a / b;
}

function compute(y: YearFin | undefined, prev: YearFin | undefined): Record<string, number | null> {
  if (!y) return {};
  const pct = (v: number | null) => (v == null ? null : v * 100);
  return {
    // 자본이 0 이하면 부채비율은 의미가 없다. 자본잠식 경고로 따로 잡는다.
    debtRatio: y.equity != null && y.equity > 0 ? pct(div(y.liabilities, y.equity)) : null,
    currentRatio: pct(div(y.currentAssets, y.currentLiabilities)),
    interestCoverage: div(y.operatingIncome, y.interestExpense),
    receivableDays: (() => {
      const r = div(y.receivables, y.revenue);
      return r == null ? null : r * 365;
    })(),
    revenueGrowth:
      prev?.revenue != null && prev.revenue > 0 && y.revenue != null ? ((y.revenue - prev.revenue) / prev.revenue) * 100 : null,
    operatingMargin: pct(div(y.operatingIncome, y.revenue)),
  };
}

const BASIS: Record<string, string> = {
  debtRatio: "부채총계 ÷ 자본총계",
  currentRatio: "유동자산 ÷ 유동부채",
  interestCoverage: "영업이익 ÷ 이자비용",
  receivableDays: "매출채권 ÷ 매출 × 365",
  revenueGrowth: "전년 대비 매출 증감",
  operatingMargin: "영업이익 ÷ 매출",
};

function levelOf(v: number | null, r: Rule): Level {
  if (v == null) return "unknown";
  if (r.higherIsWorse) return v >= r.danger ? "danger" : v >= r.warn ? "warn" : "ok";
  return v < r.danger ? "danger" : v < r.warn ? "warn" : "ok";
}

export function buildMetrics(fin: Financials | null): Metric[] {
  if (!fin) return [];
  const cur = compute(fin.years[0], fin.years[1]);
  const prev = compute(fin.years[1], fin.years[2]);
  return Object.entries(rules.financial as Record<string, Rule>).map(([id, r]) => {
    const cmp = r.higherIsWorse ? "이상" : "미만";
    let basis = `${BASIS[id]} · 주의 ${r.warn}${r.unit} ${cmp}, 위험 ${r.danger}${r.unit} ${cmp}`;
    if (id === "receivableDays" && fin.receivablesBasis === "매출채권및기타채권")
      basis += " · 매출채권 계정이 따로 없어 '매출채권 및 기타채권' 합계로 계산(실제보다 길게 나올 수 있음)";
    if (id === "interestCoverage" && fin.interestBasis === "이자지급") basis += " · 이자비용 계정이 없어 현금흐름표의 이자 지급액으로 계산";
    if (id === "interestCoverage" && fin.interestBasis === "금융비용")
      basis += " · 이자비용 계정이 없어 금융비용 전체로 계산(실제보다 낮게 나올 수 있음)";
    let level = levelOf(cur[id] ?? null, r);
    // 자본이 0 이하면 부채비율을 계산할 수 없다. "확인 못 함"이 아니라 가장 나쁜 상태다.
    const eq = fin.years[0].equity;
    if (id === "debtRatio" && eq != null && eq <= 0) {
      level = "danger";
      basis += " · 자본총계가 0 이하(자본잠식)라 비율을 계산할 수 없음";
    }
    return { id, label: r.label, unit: r.unit, value: cur[id] ?? null, prev: prev[id] ?? null, level, basis };
  });
}

export function buildFlags(fin: Financials | null): Flag[] {
  if (!fin) return [];
  const [y, p] = fin.years;
  const flags: Flag[] = [];
  const won = (n: number) => `${Math.round(n / 1e8).toLocaleString("ko-KR")}억원`;

  if (y.equity != null && y.equity <= 0)
    flags.push({ id: "capital-full", level: "critical", title: "완전자본잠식", detail: `${y.year}년 말 자본총계 ${won(y.equity)}` });
  else if (y.equity != null && y.capitalStock != null && y.equity < y.capitalStock)
    flags.push({
      id: "capital-partial",
      level: "danger",
      title: "부분자본잠식",
      detail: `자본총계 ${won(y.equity)}가 자본금 ${won(y.capitalStock)}보다 적음`,
    });

  const loss = (v: number | null | undefined) => v != null && v < 0;
  if (loss(y.operatingIncome))
    flags.push(
      loss(p?.operatingIncome)
        ? { id: "op-loss", level: "danger", title: "2년 연속 영업손실", detail: `${p!.year}년 ${won(p!.operatingIncome!)}, ${y.year}년 ${won(y.operatingIncome!)}` }
        : { id: "op-loss", level: "warn", title: "영업손실", detail: `${y.year}년 ${won(y.operatingIncome!)}` },
    );
  if (loss(y.operatingCashFlow))
    flags.push(
      loss(p?.operatingCashFlow)
        ? { id: "ocf", level: "danger", title: "2년 연속 영업현금흐름 적자", detail: `${p!.year}년 ${won(p!.operatingCashFlow!)}, ${y.year}년 ${won(y.operatingCashFlow!)}` }
        : { id: "ocf", level: "warn", title: "영업현금흐름 적자", detail: `${y.year}년 ${won(y.operatingCashFlow!)}` },
    );
  if (loss(y.netIncome) && !loss(y.operatingIncome))
    flags.push({ id: "net-loss", level: "warn", title: "당기순손실", detail: `${y.year}년 ${won(y.netIncome!)}` });

  const a = fin.audit[0];
  if (a) {
    if (!/적정/.test(a.opinion) || /부적정|한정|거절/.test(a.opinion))
      flags.push({ id: "audit-opinion", level: "critical", title: `감사의견 ${a.opinion}`, detail: `${a.year}년 · ${a.auditor}` });
    if (/계속기업/.test(a.emphasis))
      flags.push({ id: "going-concern", level: "critical", title: "계속기업 불확실성 기재", detail: a.emphasis.slice(0, 200) });
  }
  return flags;
}

export function buildTerms(
  fin: Financials | null,
  metrics: Metric[],
  flags: Flag[],
  signals: Signal[],
  request: { monthlyAmount: number; paymentDays: number },
  /** 검색이나 분류가 실패해 확인하지 못한 항목. 하나라도 있으면 등급을 매기지 않는다. */
  failures: string[] = [],
): Terms {
  if (failures.length)
    return {
      grade: "보류",
      label: "판정 보류",
      points: 0,
      paymentDays: 0,
      creditLimit: 0,
      collateral: "판정 전까지 선입금",
      note: `확인에 실패한 항목이 있어 등급을 매기지 않았습니다(${failures.join(", ")}). 다시 점검하거나 해당 항목을 직접 확인한 뒤 결정하세요.`,
      limitBasis: "판정 보류 중에는 외상 한도를 제안하지 않음",
      reviewMonths: 0,
    };
  const P = rules.points;
  let points = 0;
  for (const m of metrics) if (m.level === "warn") points += P.warn;
    else if (m.level === "danger") points += P.danger;
  for (const f of flags) if (f.level === "warn") points += P.warn;
    else if (f.level === "danger") points += P.danger;
  for (const s of signals) points += P.signal[s.severity];
  if (!fin) points += P.noFinancials;

  const critical = flags.some((f) => f.level === "critical");
  const G = rules.grades;
  const g = critical ? G[G.length - 1] : (G.find((x) => points <= x.maxPoints) ?? G[G.length - 1]);

  const byMonths = request.monthlyAmount * g.limitMonths;
  const equity = fin?.years[0].equity ?? null;
  const byEquity = equity != null && equity > 0 ? (equity * g.limitEquityPct) / 100 : null;
  const creditLimit = Math.max(0, Math.floor(Math.min(byMonths, byEquity ?? byMonths) / 1e6) * 1e6);
  const limitBasis =
    g.limitMonths === 0
      ? "외상 한도 없음"
      : `월 거래액의 ${g.limitMonths}개월분` +
        (byEquity != null ? `과 상대 회사 자기자본의 ${g.limitEquityPct}% 중 작은 금액` : " (자기자본을 확인하지 못해 거래액 기준만 적용)");

  return {
    grade: g.grade,
    label: g.label,
    points,
    paymentDays: Math.min(g.paymentDays, request.paymentDays),
    creditLimit,
    collateral: g.collateral,
    note: critical ? `치명 항목이 있어 점수와 관계없이 최하 등급. ${g.note}` : g.note,
    limitBasis,
    reviewMonths: g.reviewMonths,
  };
}

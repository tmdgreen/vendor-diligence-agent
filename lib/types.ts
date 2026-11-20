import type { Financials } from "./dart";

export type Level = "ok" | "warn" | "danger" | "critical" | "unknown";

export type Metric = {
  id: string;
  label: string;
  unit: string;
  value: number | null;
  prev: number | null;
  level: Level;
  basis: string; // 계산식과 기준값
};

export type Flag = { id: string; level: Exclude<Level, "ok" | "unknown">; title: string; detail: string };

export type Source = { n: number; title: string; url: string; hostname: string; date: string; snippet: string; topic: string; tool: string };

export type Signal = {
  topic: string;
  topicLabel: string;
  severity: "low" | "medium" | "high";
  title: string;
  summary: string;
  date: string;
  sources: number[]; // Source.n
};

export type Terms = {
  grade: string;
  label: string;
  points: number;
  paymentDays: number;
  creditLimit: number; // 원
  collateral: string;
  note: string;
  limitBasis: string;
  reviewMonths: number; // 0 이면 거래마다 확인
};

export type LinerCall = { step: string; api: string; detail: string; ms: number; ok: boolean };

export type Report = {
  company: string;
  asOf: string;
  request: { monthlyAmount: number; paymentDays: number };
  financials: Financials | null;
  financialsNote: string;
  metrics: Metric[];
  flags: Flag[];
  signals: Signal[];
  unchecked: string[]; // 검색 결과가 없어 확인하지 못한 주제
  sources: Source[];
  terms: Terms;
  linerCalls: LinerCall[];
};

export type StreamEvent =
  | { type: "step"; id: string; label: string; status: "run" | "done" | "fail"; detail?: string; api?: string }
  | { type: "report"; report: Report }
  | { type: "error"; message: string };

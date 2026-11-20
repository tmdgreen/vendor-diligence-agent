import { chatText, hasKey } from "@/lib/liner";
import type { Report } from "@/lib/types";

export const maxDuration = 120;

type Review = { decision: string; paymentDays: number; creditLimit: number; collateral: string; comment: string; excluded: number[]; reviewer: string };

const LEVEL_KO: Record<string, string> = { ok: "양호", warn: "주의", danger: "위험", critical: "치명", unknown: "확인 못 함" };
const SEV_KO: Record<string, string> = { high: "높음", medium: "중간", low: "관찰" };

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

const SYSTEM = `당신은 재무팀의 거래처 여신 품의서 초안을 쓴다.
- 아래 "자료"에 있는 사실과 숫자만 쓴다. 자료에 없는 내용은 덧붙이지 않는다.
- 위험 신호를 적을 때는 자료에 붙은 출처 번호를 [3] 형식으로 그대로 단다.
- 담당자가 정한 조건이 시스템 제안과 다르면 그 차이와 담당자 의견을 그대로 적는다.
- 구성: 1. 품의 요지(두세 문장) 2. 거래 조건 3. 재무 상태 4. 확인된 위험 신호 5. 확인하지 못한 사항 6. 사후 관리(재점검 시기와 볼 지표).
- 마크다운 제목(##)과 글머리표를 쓴다. 꾸밈말 없이 사실만 짧게 쓴다.`;

export async function POST(req: Request) {
  const { report, review } = (await req.json().catch(() => ({}))) as { report?: Report; review?: Review };
  if (!report?.company || !review) return Response.json({ error: "보고서와 검토 내용이 필요합니다." }, { status: 400 });
  if (!hasKey()) return Response.json({ error: "LINER_API_KEY 가 없습니다." }, { status: 500 });
  const pd = Number(review.paymentDays);
  const cl = Number(review.creditLimit);
  if (!Number.isFinite(pd) || pd < 0 || pd > 365) return Response.json({ error: "결제 기한은 0~365일로 적어 주세요." }, { status: 400 });
  if (!Number.isFinite(cl) || cl < 0) return Response.json({ error: "외상 한도는 0 이상으로 적어 주세요." }, { status: 400 });
  if (!["승인", "조건부 승인", "반려", "보류"].includes(review.decision)) return Response.json({ error: "결정을 선택해 주세요." }, { status: 400 });

  const kept = report.signals.filter((_, i) => !review.excluded?.includes(i));
  const fin = report.financials;
  const facts = [
    `거래처: ${report.company} · 점검일 ${report.asOf}`,
    `신청 조건: 월 거래액 ${won(report.request.monthlyAmount)}, 결제 기한 ${report.request.paymentDays}일`,
    `시스템 제안: ${report.terms.grade === "보류" ? "판정 보류" : report.terms.grade + "등급"}(${report.terms.label}, ${report.terms.points}점), 결제 기한 ${report.terms.paymentDays}일, 한도 ${won(report.terms.creditLimit)}, 담보 ${report.terms.collateral}. 한도 근거: ${report.terms.limitBasis}. ${report.terms.note}`,
    `담당자 결정: ${String(review.decision).slice(0, 20)} · 결제 기한 ${Number(review.paymentDays)}일 · 한도 ${won(Number(review.creditLimit))} · 담보 ${String(review.collateral).slice(0, 100)}`,
    `담당자 의견: ${String(review.comment || "없음").slice(0, 1000)}`,
    `담당자: ${String(review.reviewer || "미기재").slice(0, 30)}`,
    fin
      ? `재무(${fin.reportYear}년 ${fin.fsDiv === "CFS" ? "연결" : "별도"}, 출처 DART 사업보고서 ${fin.sourceUrl}):\n` +
        report.metrics.map((m) => `- ${m.label}: ${m.value == null ? "계산 불가" : m.value.toFixed(1) + m.unit} (전년 ${m.prev == null ? "-" : m.prev.toFixed(1) + m.unit}, 판정 ${LEVEL_KO[m.level] ?? m.level})${m.value == null && m.level === "danger" ? " · 자본잠식으로 계산 불가" : ""}`).join("\n") +
        (report.flags.length ? "\n" + report.flags.map((f) => `- 경고(${LEVEL_KO[f.level] ?? f.level}): ${f.title} · ${f.detail}`).join("\n") : "") +
        (fin.audit[0] ? `\n- 감사의견: ${fin.audit[0].year}년 ${fin.audit[0].opinion}(${fin.audit[0].auditor})` : "\n- 감사의견: 확인 못 함")
      : `재무: ${report.financialsNote}`,
    kept.length
      ? "위험 신호:\n" + kept.map((s) => `- [${SEV_KO[s.severity] ?? s.severity}] ${s.title} (${s.date || "날짜 미상"}) ${s.summary} 출처 ${s.sources.map((n) => `[${n}]`).join("")}`).join("\n")
      : "위험 신호: 담당자 검토 후 남은 항목 없음",
    review.excluded?.length
      ? "담당자가 이 회사와 무관하거나 판단에 필요 없다고 보고 뺀 신호:\n" +
        report.signals.filter((_, i) => review.excluded.includes(i)).map((s) => `- ${s.title}`).join("\n")
      : "",
    report.terms.grade === "보류"
      ? "재점검: 판정 보류 상태. 실패한 확인을 마친 뒤 다시 점검"
      : report.terms.reviewMonths > 0
        ? `재점검 주기(등급 기준): ${report.terms.reviewMonths}개월마다`
        : "재점검 주기(등급 기준): 거래할 때마다 선입금 확인",
    report.unchecked.length ? "확인하지 못한 사항:\n" + report.unchecked.map((u) => `- ${u}`).join("\n") : "확인하지 못한 사항: 없음",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const text = await chatText([
      { role: "system", content: SYSTEM },
      { role: "user", content: `자료\n${facts}\n\n위 자료로 품의서 초안을 써라.` },
    ]);
    return Response.json({ text });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

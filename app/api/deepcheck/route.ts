import { hasKey, searchAgent, type AgentEvent } from "@/lib/liner";
import { ndjson } from "@/lib/ndjson";

export const maxDuration = 320;

// 위험 신호 한 건을 Liner Search Agent 로 다시 확인한다.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { company?: unknown; title?: unknown; summary?: unknown };
  const s = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const company = s(body.company, 60);
  const title = s(body.title, 100);
  if (!company || !title) return Response.json({ error: "확인할 항목이 없습니다." }, { status: 400 });
  if (!hasKey()) return Response.json({ error: "LINER_API_KEY 가 없습니다." }, { status: 500 });

  const question = `${company}의 "${title}" 건을 확인하려 한다. ${s(body.summary, 400)}
이 회사에 외상으로 물건을 팔아도 되는지 판단하려는 재무 담당자에게 필요한 것만 답하라.
1) 사실관계: 언제 무슨 일이 있었고 지금 어떤 상태인가(진행 중, 종결, 확정 여부)
2) 금액 규모와 회사 재무에 주는 영향
3) 아직 확인되지 않았거나 보도마다 다른 부분
확인된 사실과 추정을 구분하고, 근거가 없으면 없다고 적어라.`;

  return ndjson<AgentEvent>(async (emit) => {
    for await (const ev of searchAgent(question)) emit(ev);
  });
}

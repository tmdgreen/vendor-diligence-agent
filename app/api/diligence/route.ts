import { runDiligence } from "@/lib/diligence";
import { hasKey } from "@/lib/liner";
import { ndjson } from "@/lib/ndjson";
import type { StreamEvent } from "@/lib/types";

export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: unknown; monthlyAmount?: unknown; paymentDays?: unknown };
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const monthlyAmount = Number(body.monthlyAmount);
  const paymentDays = Number(body.paymentDays);
  if (!name) return Response.json({ error: "회사명을 입력해 주세요." }, { status: 400 });
  if (!(monthlyAmount > 0) || !(paymentDays >= 0 && paymentDays <= 365))
    return Response.json({ error: "월 거래액과 결제 기한을 확인해 주세요." }, { status: 400 });
  if (!hasKey()) return Response.json({ error: "LINER_API_KEY 가 없습니다. .env.local 에 넣고 다시 실행해 주세요." }, { status: 500 });

  return ndjson<StreamEvent>(async (emit) => {
    const report = await runDiligence({ name, monthlyAmount, paymentDays }, emit);
    emit({ type: "report", report });
  });
}

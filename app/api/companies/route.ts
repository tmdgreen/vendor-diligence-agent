import { connection } from "next/server";
import { demoCompanies } from "@/lib/diligence";
import { hasKey } from "@/lib/liner";

export async function GET() {
  await connection(); // 키 유무는 실행할 때마다 확인한다
  return Response.json({ demo: demoCompanies(), linerKey: hasKey(), dartKey: !!process.env.DART_API_KEY?.trim() });
}

// 시연용 공시 데이터를 data/ 에 저장한다. 심사 환경에는 DART 키가 없으므로 결과물을 저장소에 넣어 둔다.
//
// 1) DART 에서 직접 받기:  DART_API_KEY=... node scripts/seed.ts <corpcode.json> 삼성전자 이마트 ...
// 2) 받아 둔 원본에서 만들기: node scripts/seed.ts <corpcode.json> --raw <폴더>
//    <폴더>/<회사명>/fs_<연도>_11011_<CFS|OFS>.json (fnlttSinglAcntAll 응답 그대로)
//
// corpcode.json 은 DART "고유번호" 파일(corpCode.xml)을 { list: [{corp_code, corp_name, stock_code}] } 로 바꾼 것.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractFinancials, fetchFinancials, type Financials, type Row } from "../lib/dart.ts";

const [src, ...rest] = process.argv.slice(2);
if (!src) {
  console.error("corpcode.json 경로가 필요합니다.");
  process.exit(1);
}

type Corp = { corp_code: string; corp_name: string; stock_code: string };
const all = (JSON.parse(readFileSync(src, "utf8")) as { list: Corp[] }).list;
const byName = new Map(all.map((c) => [c.corp_name.trim(), c]));

mkdirSync("data/financials", { recursive: true });
const listed: Record<string, [string, string]> = {};
for (const c of all) if (c.stock_code.trim()) listed[c.corp_name.trim()] = [c.corp_code, c.stock_code.trim()];
writeFileSync("data/corp-codes.json", JSON.stringify(listed));
console.log(`상장사 ${Object.keys(listed).length}곳의 고유번호 저장`);

function save(fin: Financials) {
  writeFileSync(`data/financials/${fin.corpCode}.json`, JSON.stringify(fin, null, 1));
  const y = fin.years[0];
  console.log(
    `${fin.corpName} ${fin.reportYear} ${fin.fsDiv} 매출 ${y.revenue} 영업이익 ${y.operatingIncome} 부채 ${y.liabilities} 자본 ${y.equity} 채권 ${y.receivables} 영업현금 ${y.operatingCashFlow} 이자(${fin.interestBasis}) ${y.interestExpense} 감사 ${fin.audit[0]?.opinion ?? "없음"}`,
  );
}

const latest = new Date().getFullYear() - 1;

if (rest[0] === "--raw") {
  const dir = rest[1];
  for (const name of readdirSync(dir)) {
    const c = byName.get(name);
    if (!c) {
      console.log(`건너뜀(고유번호 없음): ${name}`);
      continue;
    }
    let done = false;
    for (const year of [latest, latest - 1]) {
      for (const fsDiv of ["CFS", "OFS"] as const) {
        const f = join(dir, name, `fs_${year}_11011_${fsDiv}.json`);
        if (done || !existsSync(f)) continue;
        const body = JSON.parse(readFileSync(f, "utf8")) as { status: string; list?: Row[] };
        if (body.status !== "000" || !body.list?.length) continue;
        save(extractFinancials(body.list, { corpCode: c.corp_code, corpName: name, stockCode: c.stock_code.trim() }, year, fsDiv));
        done = true;
      }
    }
    if (!done) console.log(`건너뜀(사업보고서 없음): ${name}`);
  }
} else {
  const key = process.env.DART_API_KEY?.trim();
  if (!key) {
    console.error("DART_API_KEY 환경 변수가 필요합니다.");
    process.exit(1);
  }
  for (const name of rest) {
    const c = byName.get(name);
    if (!c) {
      console.log(`건너뜀(고유번호 없음): ${name}`);
      continue;
    }
    const fin = await fetchFinancials({ corpCode: c.corp_code, corpName: name, stockCode: c.stock_code.trim() }, key, latest);
    if (fin) save(fin);
    else console.log(`건너뜀(사업보고서 없음): ${name}`);
  }
}

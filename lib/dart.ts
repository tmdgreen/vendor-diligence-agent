// OpenDART(금융감독원 전자공시) 사업보고서에서 실사에 필요한 수치만 뽑는다.
// 외부 모듈에 기대지 않는다: scripts/seed.ts 가 node 로 직접 불러 쓴다.

export type YearFin = {
  year: number;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  assets: number | null;
  liabilities: number | null;
  equity: number | null;
  currentAssets: number | null;
  currentLiabilities: number | null;
  cash: number | null;
  receivables: number | null;
  capitalStock: number | null;
  operatingCashFlow: number | null;
  interestExpense: number | null;
};

export type AuditInfo = {
  year: number;
  auditor: string;
  opinion: string;
  emphasis: string;
};

export type Financials = {
  corpCode: string;
  corpName: string;
  stockCode: string;
  fsDiv: "CFS" | "OFS";
  reportYear: number;
  /** 순수 매출채권 계정이 없어 "매출채권 및 기타채권" 합계로 대신했는지 */
  receivablesBasis: "매출채권" | "매출채권및기타채권" | "없음";
  /** 이자보상배율 분모로 무엇을 썼는지 */
  interestBasis: "이자비용" | "이자지급" | "금융비용" | "없음";
  years: YearFin[]; // 최신 연도가 앞
  audit: AuditInfo[];
  sourceUrl: string;
  fetchedAt: string;
};

export type Row = {
  rcept_no?: string;
  sj_div: string;
  account_id: string;
  account_nm: string;
  thstrm_amount?: string;
  frmtrm_amount?: string;
  bfefrmtrm_amount?: string;
};

const BASE = "https://opendart.fss.or.kr/api";

function num(s: string | undefined): number | null {
  if (s == null) return null;
  const t = s.replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

type Pick = { sj: string[]; ids: string[]; names: RegExp[] };

const PICKS: Record<Exclude<keyof YearFin, "year" | "interestExpense">, Pick> = {
  revenue: { sj: ["IS", "CIS"], ids: ["ifrs-full_Revenue"], names: [/^(매출액|영업수익|수익\(매출액\)|매출)$/] },
  operatingIncome: { sj: ["IS", "CIS"], ids: ["dart_OperatingIncomeLoss"], names: [/^영업(이익|손실|손익)/] },
  netIncome: { sj: ["IS", "CIS"], ids: ["ifrs-full_ProfitLoss"], names: [/^(당기순이익|당기순손익|당기순손실)/] },
  assets: { sj: ["BS"], ids: ["ifrs-full_Assets"], names: [/^자산총계$/] },
  liabilities: { sj: ["BS"], ids: ["ifrs-full_Liabilities"], names: [/^부채총계$/] },
  equity: { sj: ["BS"], ids: ["ifrs-full_Equity"], names: [/^자본총계$/] },
  currentAssets: { sj: ["BS"], ids: ["ifrs-full_CurrentAssets"], names: [/^유동자산$/] },
  currentLiabilities: { sj: ["BS"], ids: ["ifrs-full_CurrentLiabilities"], names: [/^유동부채$/] },
  cash: { sj: ["BS"], ids: ["ifrs-full_CashAndCashEquivalents"], names: [/^현금및현금성자산$/] },
  // 순수 매출채권만. "매출채권 및 기타채권" 합계는 아래에서 대체값으로만 쓴다.
  receivables: {
    sj: ["BS"],
    ids: ["dart_ShortTermTradeReceivable", "ifrs-full_CurrentTradeReceivables"],
    names: [/^(유동)?매출채권$/],
  },
  capitalStock: { sj: ["BS"], ids: ["ifrs-full_IssuedCapital"], names: [/^자본금$/] },
  operatingCashFlow: {
    sj: ["CF"],
    ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"],
    names: [/^영업활동.*현금흐름$/],
  },
};

function find(rows: Row[], p: Pick): Row | undefined {
  const scoped = rows.filter((r) => p.sj.includes(r.sj_div));
  for (const id of p.ids) {
    const hit = scoped.find((r) => r.account_id === id);
    if (hit) return hit;
  }
  for (const re of p.names) {
    const hit = scoped.find((r) => re.test(r.account_nm.replace(/\s/g, "")));
    if (hit) return hit;
  }
  return undefined;
}

function three(r: Row | undefined): (number | null)[] {
  return [num(r?.thstrm_amount), num(r?.frmtrm_amount), num(r?.bfefrmtrm_amount)];
}

async function dart(path: string, params: Record<string, string>, key: string) {
  const q = new URLSearchParams({ crtfc_key: key, ...params });
  const res = await fetch(`${BASE}/${path}?${q}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`DART ${path} HTTP ${res.status}`);
  return (await res.json()) as { status: string; message: string; list?: unknown[] };
}

export function extractFinancials(
  rows: Row[],
  corp: { corpCode: string; corpName: string; stockCode: string },
  year: number,
  fsDiv: "CFS" | "OFS",
  audit: AuditInfo[] = [],
): Financials {
  const cols = {} as Record<keyof typeof PICKS, (number | null)[]>;
  for (const k of Object.keys(PICKS) as (keyof typeof PICKS)[]) cols[k] = three(find(rows, PICKS[k]));

  const pureReceivable = find(rows, PICKS.receivables);
  const combinedReceivable = find(rows, {
    sj: ["BS"],
    ids: ["ifrs-full_TradeAndOtherCurrentReceivables"],
    names: [/^매출채권및기타(유동)?채권$/],
  });
  const receivables = three(pureReceivable ?? combinedReceivable);

  const pl = rows.filter((r) => r.sj_div === "IS" || r.sj_div === "CIS");
  const nm = (r: Row) => r.account_nm.replace(/\s/g, "");
  // 이자보상배율의 분모. 손익계산서의 이자비용 → 현금흐름표의 이자비용(조정) → 이자의 지급 → 금융비용 순으로 찾는다.
  // 금융비용에는 외환손실·파생상품손실이 섞여 있어 마지막 대체값으로만 쓴다.
  const cf = rows.filter((r) => r.sj_div === "CF");
  const abs3 = (r: Row | undefined) => three(r).map((v) => (v == null ? null : Math.abs(v)));
  const sum3 = (rs: Row[]) =>
    [0, 1, 2].map((i) => {
      const vs = rs.map((r) => abs3(r)[i]).filter((v): v is number => v != null);
      return vs.length ? vs.reduce((a, b) => a + b, 0) : null;
    });
  // 이자 지급액은 영업·재무활동으로 나뉘어 나올 수 있어 합친다. 같은 계정이 두 번 잡히지 않게 account_id 로 거른다.
  const paidRows = cf.filter(
    (r, k, all) =>
      (/^ifrs-full_InterestPaid/.test(r.account_id) || /^이자(의)?지급(액)?$/.test(nm(r))) &&
      all.findIndex((x) => x.account_id === r.account_id && x.account_nm === r.account_nm) === k,
  );
  const candidates: { basis: Financials["interestBasis"]; values: (number | null)[] }[] = [
    { basis: "이자비용", values: abs3(pl.find((r) => /^이자비용$/.test(nm(r)))) },
    {
      basis: "이자비용",
      values: abs3(cf.find((r) => r.account_id === "dart_AdjustmentsForInterestExpenses") ?? cf.find((r) => /^이자비용$/.test(nm(r)))),
    },
    // 총계(ifrs-full_InterestPaid, 이름 '이자의 지급' 등)가 있으면 총계, 없으면 활동별(…ClassifiedAs…) 금액의 합. 둘을 더하지 않는다.
    {
      basis: "이자지급",
      values: [0, 1, 2].map((i) => {
        const total = sum3(paidRows.filter((r) => !/ClassifiedAs/.test(r.account_id)))[i];
        return total ?? sum3(paidRows.filter((r) => /ClassifiedAs/.test(r.account_id)))[i];
      }),
    },
    {
      basis: "금융비용",
      values: abs3(pl.find((r) => r.account_id === "ifrs-full_FinanceCosts") ?? pl.find((r) => /^금융(비용|원가)$/.test(nm(r)))),
    },
  ];
  // 연도마다 값이 있는 첫 후보를 쓴다. 0 은 "이자 없음"이라는 값이므로 그대로 쓴다.
  const interestPick = [0, 1, 2].map((i) => candidates.find((c) => c.values[i] != null));
  const interest = interestPick.map((c, i) => (c ? c.values[i] : null));

  const years: YearFin[] = [0, 1, 2].map((i) => ({
    year: year - i,
    revenue: cols.revenue[i],
    operatingIncome: cols.operatingIncome[i],
    netIncome: cols.netIncome[i],
    assets: cols.assets[i],
    liabilities: cols.liabilities[i],
    equity: cols.equity[i],
    currentAssets: cols.currentAssets[i],
    currentLiabilities: cols.currentLiabilities[i],
    cash: cols.cash[i],
    receivables: receivables[i],
    capitalStock: cols.capitalStock[i],
    operatingCashFlow: cols.operatingCashFlow[i],
    interestExpense: interest[i] ?? null,
  }));

  const rcept = rows[0]?.rcept_no;
  return {
    ...corp,
    fsDiv,
    reportYear: year,
    receivablesBasis: pureReceivable ? "매출채권" : combinedReceivable ? "매출채권및기타채권" : "없음",
    interestBasis: interestPick[0]?.basis ?? "없음", // 최근 연도 기준
    years,
    audit,
    sourceUrl: rcept ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept}` : "https://dart.fss.or.kr",
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
}

export async function fetchFinancials(
  corp: { corpCode: string; corpName: string; stockCode: string },
  key: string,
  latestYear: number,
): Promise<Financials | null> {
  // 사업보고서(11011)가 나온 가장 최근 연도를 찾는다. 연결이 없으면 별도.
  for (const year of [latestYear, latestYear - 1]) {
    for (const fsDiv of ["CFS", "OFS"] as const) {
      const body = await dart(
        "fnlttSinglAcntAll.json",
        { corp_code: corp.corpCode, bsns_year: String(year), reprt_code: "11011", fs_div: fsDiv },
        key,
      );
      if (body.status === "012" || body.status === "010" || body.status === "011" || body.status === "020")
        throw new Error(`DART ${body.status}: ${body.message}`);
      if (body.status !== "000" || !body.list?.length) continue;
      let audit: AuditInfo[] = [];
      try {
        const a = await dart(
          "accnutAdtorNmNdAdtOpinion.json",
          { corp_code: corp.corpCode, bsns_year: String(year), reprt_code: "11011" },
          key,
        );
        const seen = new Set<string>();
        for (const r of (a.list ?? []) as Record<string, string>[]) {
          const label = r.bsns_year ?? "";
          // bsns_year 는 "2025" 로도, "제12기(당기)" 로도 온다.
          const four = Number((label.match(/(?:19|20)\d{2}/) ?? [])[0]);
          const y = /전전기/.test(label) ? year - 2 : /전기/.test(label) ? year - 1 : /당기/.test(label) ? year : four;
          const opinion = (r.adt_opinion ?? "").trim();
          if (!y || !opinion || opinion === "-" || seen.has(String(y))) continue;
          seen.add(String(y));
          audit.push({
            year: y,
            auditor: (r.adtor ?? "").trim(),
            opinion,
            emphasis: [r.emphs_matter, r.adt_reprt_spcmnt_matter]
              .map((s) => (s ?? "").trim())
              .filter((s) => s && s !== "-" && !/^해당\s*사항\s*없음/.test(s))
              .join(" / "),
          });
        }
        audit = audit.sort((x, y2) => y2.year - x.year).slice(0, 3);
      } catch {
        // 감사의견은 없어도 진행한다. 화면에 "확인 못 함"으로 나온다.
      }

      return extractFinancials(body.list as Row[], corp, year, fsDiv, audit);
    }
  }
  return null;
}

// 수급 레이더 순수 로직 — scripts/fetch-supply-demand.mjs 에서 이식 (검증 완료 코드, 재발명 아님)
// 근거: convex-migration-plan.md §2-A "파서·정규화는 순수함수로 convex/lib/에 이식"
//       dart-api-fieldnotes.md (2026-07-23 실호출 검증 구조)
//
// SECURITY: DART 키는 Convex 환경변수(DART_API_KEY)로만 주입되며, 이 모듈은 키를 로그에
// 남기지 않는다(URL 로깅은 키 마스킹). 키를 반환값·에러 메시지에 포함하지 않는다.

export const CORP_CODE = '00164779' // SK하이닉스(000660) — corpCode.xml로 확정 (fieldnotes)
const DART = 'https://opendart.fss.or.kr/api'

// ---- time helpers (KST) -----------------------------------------------------
const KST_MS = 9 * 3600 * 1000
export function kstNow(): Date {
  return new Date(Date.now() + KST_MS)
}
export function ymd(d: Date, sep = ''): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return [y, m, dd].join(sep)
}
export function kstISO(): string {
  return kstNow().toISOString().replace('Z', '+09:00').replace(/\.\d{3}/, '')
}

// ---- parsing helpers --------------------------------------------------------
// DART numbers arrive as comma strings ("53,933,998"); "-" means none.
export function num(v: unknown): number | null {
  if (v == null || v === '' || v === '-') return null
  const n = parseFloat(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}
export function normDate(v: unknown): string {
  // "YYYY-MM-DD" or "YYYYMMDD" → "YYYY-MM-DD"
  if (!v) return ''
  const s = String(v).replace(/-/g, '')
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}
export function round2(n: number | null): number | null {
  return n == null ? null : Math.round(n * 100) / 100
}

// ---- DART client ------------------------------------------------------------
type DartRow = Record<string, string>
type DartResponse = {
  status: string
  message?: string
  list?: DartRow[]
  total_page?: string | number
}
export type DartClient = (path: string, params?: Record<string, string>) => Promise<DartResponse>

export function makeDartClient(key: string): DartClient {
  return async (path, params = {}) => {
    const qs = new URLSearchParams({ crtfc_key: key, corp_code: CORP_CODE, ...params })
    const safeQs = new URLSearchParams({ crtfc_key: '****', corp_code: CORP_CODE, ...params })
    const res = await fetch(`${DART}/${path}?${qs}`)
    if (!res.ok) throw new Error(`${path} HTTP ${res.status} (${safeQs})`)
    const json = (await res.json()) as DartResponse
    // status: 000 정상 / 013 데이터없음 / 010·011 키오류 / 020 한도초과
    if (json.status === '013') return { ...json, list: [] }
    if (json.status !== '000') throw new Error(`${path} status=${json.status} ${json.message} (${safeQs})`)
    return json
  }
}

// ---- collectors -------------------------------------------------------------
export type MajorEvent = {
  type: 'major-stock'
  rceptNo: string
  rceptDt: string
  reporter: string
  shares: number | null
  changeShares: number | null
  ratioBefore: number | null
  ratioAfter: number | null
  ratioChange: number | null
  reason: string
}

// 5%룰 대량보유 (페이징 없음, 최근 10건 고정)
export async function fetchMajorStock(dart: DartClient): Promise<MajorEvent[]> {
  const { list = [] } = await dart('majorstock.json')
  return list.map((r) => {
    const after = num(r.stkrt)
    const delta = num(r.stkrt_irds)
    return {
      type: 'major-stock' as const,
      rceptNo: r.rcept_no,
      rceptDt: normDate(r.rcept_dt),
      reporter: r.repror || '',
      shares: num(r.stkqy),
      changeShares: num(r.stkqy_irds),
      ratioBefore: after != null && delta != null ? round2(after - delta) : null, // "비율 전" = stkrt - stkrt_irds
      ratioAfter: after,
      ratioChange: delta,
      reason: r.report_resn || '',
    }
  })
}

export type InsiderEvent = {
  type: 'insider'
  rceptNo: string
  rceptDt: string
  reporter: string
  position: string
  shares: number | null
  changeShares: number | null
  ratioAfter: number | null
  ratioChange: number | null
  reason: string
}

// 임원·주요주주 내부자 (페이징 없음, 전체 이력·정렬 비보장 → 재정렬)
export async function fetchInsiders(
  dart: DartClient,
  { months = 12, cap = 20 }: { months?: number; cap?: number } = {},
): Promise<InsiderEvent[]> {
  const { list = [] } = await dart('elestock.json')
  const cutoff = new Date(kstNow().getTime())
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months)
  const cutoffStr = ymd(cutoff, '-')
  return list
    .map((r) => ({
      type: 'insider' as const,
      rceptNo: r.rcept_no,
      rceptDt: normDate(r.rcept_dt),
      reporter: r.repror || '',
      position:
        [r.isu_exctv_ofcps, r.isu_exctv_rgist_at].filter((x) => x && x !== '-').join(' · ') ||
        (r.isu_main_shrholdr && r.isu_main_shrholdr !== '-' ? r.isu_main_shrholdr : ''),
      shares: num(r.sp_stock_lmp_cnt),
      changeShares: num(r.sp_stock_lmp_irds_cnt),
      ratioAfter: num(r.sp_stock_lmp_rate),
      ratioChange: num(r.sp_stock_lmp_irds_rate),
      reason: '',
    }))
    .filter((e) => e.rceptDt >= cutoffStr)
    .sort((a, b) => (a.rceptDt < b.rceptDt ? 1 : -1))
    .slice(0, cap)
}

// 오버행 후보: 최근 3개월 주요사항보고(B)·발행공시/증권신고(C) 목록에서 물량성 키워드 필터
const OVERHANG_RULES: Array<[RegExp, string]> = [
  [/유상증자/, '유상증자'],
  [/무상증자/, '무상증자'],
  [/전환사채|CB/, 'CB'],
  [/신주인수권/, 'BW'],
  [/교환사채/, 'EB'],
  [/예탁증권|예탁증서|해외증권/, 'DR·해외상장'],
  [/증권신고서|일괄신고/, '증권신고서'],
]

export type OverhangItem = {
  rceptNo: string
  rceptDt: string
  title: string
  filer: string
  kind: string
}

export async function fetchOverhang(
  dart: DartClient,
  { months = 3 }: { months?: number } = {},
): Promise<OverhangItem[]> {
  const end = kstNow()
  const begin = new Date(end.getTime())
  begin.setUTCMonth(begin.getUTCMonth() - months)
  const seen = new Set<string>()
  const out: OverhangItem[] = []
  for (const ty of ['B', 'C']) {
    let page = 1
    let totalPage = 1
    while (page <= totalPage && page <= 5) {
      const json = await dart('list.json', {
        bgn_de: ymd(begin),
        end_de: ymd(end),
        pblntf_ty: ty,
        page_no: String(page),
        page_count: '100',
      })
      totalPage = Number(json.total_page || 1)
      for (const r of json.list || []) {
        if (seen.has(r.rcept_no)) continue
        const name = r.report_nm || ''
        const rule = OVERHANG_RULES.find(([re]) => re.test(name))
        if (!rule) continue
        seen.add(r.rcept_no)
        out.push({
          rceptNo: r.rcept_no,
          rceptDt: normDate(r.rcept_dt),
          title: name,
          filer: r.flr_nm || '',
          kind: rule[1],
        })
      }
      page++
    }
  }
  return out.sort((a, b) => (a.rceptDt < b.rceptDt ? 1 : -1))
}

// 오버행 kind → dartFilings.type 매핑 (기획서 §1-A enum)
export function overhangKindToType(kind: string): string {
  if (kind === '유상증자' || kind === '무상증자') return 'capital-increase'
  if (kind === 'CB' || kind === 'BW' || kind === 'EB') return 'cb'
  return 'other' // DR·해외상장, 증권신고서 등
}

export type Concentration = {
  majorHolders: Array<{ name: string; ratio: number; asOf: string; note: string }>
  exitedNotes: string[]
  totalShares: number | null
  treasuryShares: number | null
  freeFloatRatioPct: number | null
  fivePctSum: number | null
  dsLabel: string | null
}

// 집중도: DS002(주식총수·최대주주) 시도 + 5%룰 누적. 실패 시 추정 폴백(정직 표기).
export async function fetchConcentration(dart: DartClient, majorEvents: MajorEvent[]): Promise<Concentration> {
  let totalShares: number | null = null
  let treasuryShares: number | null = null
  let topHolderRatio: number | null = null
  let dsLabel: string | null = null
  const tries: Array<[string, string, string]> = [
    ['2026', '11013', '2026 1분기보고서'],
    ['2025', '11011', '2025 사업보고서'],
  ]
  for (const [year, code, label] of tries) {
    try {
      const tot = await dart('stockTotqySttus.json', { bsns_year: year, reprt_code: code })
      const row =
        (tot.list || []).find((r) => /보통주/.test(r.se || '')) ||
        (tot.list || []).find((r) => /합계/.test(r.se || ''))
      if (row) {
        totalShares = num(row.istc_totqy) ?? num(row.isu_stock_totqy) ?? null
        treasuryShares = num(row.tesstk_co)
      }
      const hy = await dart('hyslrSttus.json', { bsns_year: year, reprt_code: code })
      const sum = (hy.list || []).find((r) => /^계$|합계/.test((r.nm || '').trim()))
      if (sum) topHolderRatio = num(sum.trmend_posesn_stock_qota_rt)
      if (totalShares != null || topHolderRatio != null) {
        dsLabel = label
        break
      }
    } catch (e) {
      console.warn(`[concentration] DS002 ${year}/${code} skip: ${e instanceof Error ? e.message : e}`)
    }
  }

  // 5%룰 누적 — 보고자별 최신 상태에서 5% 이상만
  const latestByReporter = new Map<string, MajorEvent>()
  for (const ev of [...majorEvents].sort((a, b) => (a.rceptDt < b.rceptDt ? -1 : 1))) {
    if (ev.reporter) latestByReporter.set(ev.reporter, ev)
  }
  const fromMajor = [...latestByReporter.values()]
    .filter((ev) => ev.ratioAfter != null && ev.ratioAfter >= 5)
    .map((ev) => ({
      name: ev.reporter,
      ratio: ev.ratioAfter as number,
      asOf: ev.rceptDt,
      note: '5%룰 최신 보고 기준',
    }))
  const exited = [...latestByReporter.values()].filter((ev) => ev.ratioAfter != null && ev.ratioAfter < 5)

  const majorHolders = [
    {
      name: '최대주주(SK스퀘어 외 특수관계인)',
      ratio: topHolderRatio ?? 20.1,
      asOf: dsLabel ?? '추정',
      note: topHolderRatio != null ? `${dsLabel} 기준` : '대략값(정기보고서 미조회) — 추정',
    },
    {
      name: '국민연금공단',
      ratio: 7.35,
      asOf: '추정',
      note: '추정 — 2024-09 이후 5%룰 보고 없음(보고의무 기준 미변동 가능)',
    },
    ...fromMajor.filter((h) => !/국민연금/.test(h.name)),
  ]

  const lockedRatio =
    majorHolders[0].ratio + (treasuryShares && totalShares ? (treasuryShares / totalShares) * 100 : 0)
  const freeFloatRatioPct = round2(100 - lockedRatio)
  const fivePctSum = round2(majorHolders.reduce((s, h) => s + (h.ratio || 0), 0))
  return {
    majorHolders,
    exitedNotes: exited.map(
      (ev) => `${ev.reporter}: ${ev.ratioAfter}%로 5% 미만 이탈(${ev.rceptDt} 보고, 이후 보고의무 소멸)`,
    ),
    totalShares,
    treasuryShares,
    freeFloatRatioPct,
    fivePctSum,
    dsLabel,
  }
}

// ---- SEED flow (쌍끌이 샘플 — KIS 키 확보 시 LIVE 전환) ----------------------
// 주의: SEED는 Convex 시계열 테이블에 넣지 않는다(기획서 §1-B). 이 블록은 서빙 계약
// (기존 supply-demand.json 스키마)의 flow 파트를 채우기 위해서만 조립 JSON에 포함되며
// sources.flow="seed"로 정직 표기된다.
// Deterministic PRNG so re-runs only shift dates, not shapes.
function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function businessDaysBack(end: Date, n: number): string[] {
  const days: string[] = []
  const d = new Date(end.getTime())
  while (days.length < n) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) days.unshift(ymd(d, '-'))
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return days
}
export function seedFlow(asOfDate: Date) {
  const N = 90
  const dates = businessDaysBack(asOfDate, N)
  const rnd = mulberry32(20260723)
  // Close path: drift ~2.15M→~2.3M, then a recent 5-day sharp drawdown to ~1.76M
  // (기술적 전망 보드의 현황 서술과 정합적인 "그럴듯한 표본" — 실측 아님).
  const rets: number[] = []
  for (let i = 0; i < N; i++) rets.push((rnd() - 0.48) * 0.024)
  const crash = [-0.052, -0.055, -0.048, -0.035, -0.021]
  for (let i = 0; i < crash.length; i++) rets[N - crash.length + i] = crash[i]
  let close = 1825000
  const daily = []
  let holdRatio = 53.6
  for (let i = 0; i < N; i++) {
    close = Math.round((close * (1 + rets[i])) / 500) * 500
    const valueEok = Math.round(16000 + rnd() * 9000 + (Math.abs(rets[i]) > 0.03 ? 18000 : 0))
    // foreign flow loosely follows returns; institutions partially fade it
    const foreignNetEok = Math.round(rets[i] * 52000 + (rnd() - 0.5) * 1400)
    const instNetEok = Math.round(-0.35 * foreignNetEok + (rnd() - 0.5) * 900)
    // ~1.3조원 순매수 ≈ 시총 대비 약 1%p (표본 스케일) → 보유율이 플로우를 따라 움직인다
    holdRatio = Math.max(50, Math.min(56, holdRatio + foreignNetEok / 13000 + (rnd() - 0.5) * 0.02))
    daily.push({
      date: dates[i],
      foreignNetEok,
      instNetEok,
      close,
      valueEok,
      foreignHoldRatio: round2(holdRatio),
    })
  }
  return { daily }
}

// ---- 서빙 JSON 조립 (public/data/supply-demand.json과 스키마 단위 동일 — §3-A 계약) ----
export function assembleSupplyDemand(input: {
  major: MajorEvent[]
  insiders: InsiderEvent[]
  overhang: OverhangItem[]
  conc: Concentration
}) {
  const { major, insiders, overhang, conc } = input
  const asOfDate = kstNow()
  const asOf = ymd(asOfDate, '-')

  const events = [
    ...major,
    ...insiders,
    ...overhang.map((o) => ({
      type: 'overhang',
      rceptNo: o.rceptNo,
      rceptDt: o.rceptDt,
      reporter: o.filer,
      reason: o.title,
      subtype: o.kind,
    })),
  ]
    .sort((a, b) => (a.rceptDt < b.rceptDt ? 1 : -1))
    .slice(0, 40)

  const flow = seedFlow(asOfDate)

  // 산식(툴팁 공개용): 1점 시작 + [5%이상 보유자 합산 ≥30% +1] + [유통비율<70% +1]
  // + [유통비율<50% +1] + [잠재 물량 공시(3개월) 존재 +1] → 1~2 낮음 / 3 보통 / 4~5 높음
  let score = 1
  if ((conc.fivePctSum ?? 0) >= 30) score++
  if (conc.freeFloatRatioPct != null && conc.freeFloatRatioPct < 70) score++
  if (conc.freeFloatRatioPct != null && conc.freeFloatRatioPct < 50) score++
  if (overhang.length > 0) score++
  const sensitivityLabel = score <= 2 ? '낮음' : score === 3 ? '보통' : '높음'

  return {
    meta: {
      source: 'LIVE',
      sourceLabel: '공시 LIVE (DART 전자공시 OpenAPI) · 쌍끌이 플로우는 샘플(KIS 키 대기)',
      asOf,
      fetchedAt: kstISO(),
      notes:
        '5%룰·내부자 공시는 사유 발생 후 최대 5영업일(경우에 따라 그 이상) 지연 보고되는 사후 확인 정보. 쌍끌이 플로우 블록은 KIS 키 확보 전까지 샘플.',
    },
    sources: {
      flow: 'seed',
      events: 'dart',
      overhang: 'dart',
      concentration: conc.dsLabel ? 'dart' : 'dart+static',
    },
    config: { twinStreakThreshold: 3, zscoreWindow: 60 },
    flow,
    events,
    overhang,
    concentration: {
      asOfLabel: conc.dsLabel ?? '5%룰 최신 보고 + 대략값',
      totalShares: conc.totalShares,
      treasuryShares: conc.treasuryShares,
      majorHolders: conc.majorHolders,
      exitedNotes: conc.exitedNotes,
      freeFloatRatioPct: conc.freeFloatRatioPct,
      fivePctSum: conc.fivePctSum,
      sensitivityScore: score,
      sensitivityLabel,
      note: '유통비율 = 100% − (최대주주 합산 + 자사주). 5% 이상 기관·연기금 보유분은 유통물량이되 동시 처분 시 급락 민감 요인 — 분기·공시 기준으로 시차 있음.',
    },
    disclaimer:
      '본 화면은 공시·집계 데이터 기반 참고 정보이며 투자자문·매매권유가 아닙니다. 5%룰·내부자 공시는 사유 발생 후 최대 5영업일(경우에 따라 그 이상) 지연 보고되는 사후 확인 정보입니다.',
  }
}

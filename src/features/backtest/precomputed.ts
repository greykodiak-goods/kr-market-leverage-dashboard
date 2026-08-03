// 프리셋 사전계산 산출물(public/data/presets-precomputed.json) 읽기 — 화면 전용 어댑터.
//
// 대표 지시(2026-08-02): "프리셋 이름들에 MDD랑 최근 10년 평균 수익률 추가",
//                        "프리셋들 결과는 미리 돌려서 저장해놓으면 시간 단축 할 수 있게".
//
// 굽는 쪽은 scripts/preset-precompute.entry.ts(= 화면과 같은 엔진). 여기서는 **읽기만** 한다.
//
// ── 우아한 강등 ─────────────────────────────────────────────────────────────
//   파일이 아직 없거나(첫 배포·GHA 미실행) 스키마가 모르는 버전이면 **없는 셈 치고**
//   예전 화면 그대로 동작한다. 라벨도 원래 라벨로 돌아간다 — 사전계산은 부가 기능이지
//   전제 조건이 아니다.
//
// ── 정직성(규칙 3) ──────────────────────────────────────────────────────────
//   라벨에 붙는 수치는 **하드코딩이 아니라 이 파일에서 온다** — 사전계산이 갱신되면
//   라벨도 따라온다. 곡선은 주 1점 다운샘플이고 기준일(asOf)이 과거일 수 있으므로,
//   화면은 그 사실을 배지로 드러내고 "직접 다시 돌리기" 경로를 항상 함께 둔다.

import { useEffect, useState } from 'react'
import type { CostSettings } from './conditionScreen'
import type { StrategyKind } from './presets'
import type { EquityRow } from './EquityChart'
import { normalizePriceSource, type PriceSource } from './priceSource'

/** 굽는 쪽이 지금 쓰는 산출물 스키마 버전(4 = 시세 소스 표기 추가 · 야후 배제 2단계). */
export const PRECOMPUTE_SCHEMA = 4

/**
 * 화면이 **읽을 수 있는** 스키마 버전들. 모르는 버전이면 없는 셈 친다(우아한 강등).
 *
 * 1 → 2 → 3 → 4는 전부 **필드 추가만** 했으므로 옛 산출물도 그대로 읽는다. 다만 schema 1 파일에는
 * 신규 지표(변동성·샤프·소르티노·최장 낙폭 기간·손익비·PF)가, schema 1·2 파일에는 참고 벽(walls)이,
 * schema 1~3 파일에는 시세 소스 표기가 없으므로 그 자리는 `undefined`로 남아 화면에서 '—'이거나
 * 상수로 강등된다 — 없는 값을 0으로 채우지 않는다(규칙 3).
 * (시세 소스가 없는 옛 산출물은 **야후로 구운 것**이다 — 그때는 야후밖에 없었다.)
 */
export const SUPPORTED_PRECOMPUTE_SCHEMAS: readonly number[] = [1, 2, 3, 4]

/**
 * 참고 벽 — 같은 구간 단순보유를 **다시 재서** 나란히 놓는 값(34차 규약).
 * 옮겨 적은 수치가 아니라 산출물이 그 실행에서 계산한 것이다.
 * ⚠️ 참고이지 알파 판정 벤치가 아니다(판정 벤치는 규칙 5대로 KODEX 200).
 */
export interface PrecomputedWall {
  /** 벽 종류 — 화면이 찾아 쓰는 키 */
  kind: 'qqqKrw' | 'benchKr'
  label: string
  /** CAGR ÷ |MDD| */
  calmar: number
  cagrPct: number
  mddPct: number
  startDate: string
  endDate: string
}

/** [날짜, 자산(원), 벤치마크(원)] */
export type CurveTuple = [string, number, number]

export interface PrecomputedPreset {
  id: string
  label: string
  kind: StrategyKind
  /** 최대 낙폭(%) — 0 이하. 다운샘플 **전** 원곡선 기준 */
  mddPct: number
  cagrPct: number
  /** 최근 10년 연환산 수익률(%) — 곡선이 10년에 못 미치면 null */
  cagr10yPct: number | null
  totalPct: number
  alphaCagrPct: number | null
  benchCagrPct: number | null
  /** 결합은 곡선 합성이라 매매 원장이 **귀속 불가**(null) — 0건이라는 뜻이 아니다 */
  tradeCount: number | null
  startDate: string
  endDate: string
  initialCapital: number
  curve: CurveTuple[]

  // ---- schema 2에서 추가된 표준 성과 지표 (schema 1 산출물에는 없다 → undefined) ----
  // 전부 **다운샘플 전 원곡선·원장**에서 잰 값이다. 아래 저장된 주 1점 곡선에서 다시 재면
  // 변동성이 낮아지고 낙폭 기간이 짧아 보인다 — 그래서 화면은 이 스칼라를 쓴다.
  /** 연환산 변동성(%) */
  volAnnPct?: number | null
  /** 샤프 비율 — 무위험수익률 0% 가정 */
  sharpe?: number | null
  /** 소르티노 비율 — 무위험수익률 0% 가정 */
  sortino?: number | null
  /** 최장 낙폭 기간(달력 일수) */
  maxDdDays?: number | null
  /** 그 구간을 곡선 마지막 날까지 회복했는지 */
  maxDdRecovered?: boolean | null
  maxDdStart?: string | null
  maxDdEnd?: string | null
  /** 손익비(평균이익% ÷ |평균손실%|) — 결합은 원장 귀속 불가라 null */
  payoffRatio?: number | null
  /** Profit Factor(이익합 ÷ |손실합|) — 결합은 원장 귀속 불가라 null */
  profitFactor?: number | null
}

export interface PrecomputedFile {
  schema: number
  asOf: string
  computedAt: string
  curveInterval: 'weekly'
  cost: CostSettings
  note: string
  presets: PrecomputedPreset[]
  /** 참고 벽(schema 3~). 옛 산출물에는 없다 → undefined */
  walls?: PrecomputedWall[]
  /** 국내 유니버스 시세 소스(schema 4~). 없으면 야후로 구운 옛 산출물이다. */
  priceSource?: PriceSource
  priceSourceNote?: string
  priceSourceLimits?: string[]
}

export interface PrecomputedIndex {
  asOf: string
  computedAt: string
  curveInterval: 'weekly'
  cost: CostSettings
  note: string
  /** 이 산출물의 스키마 버전 — 화면이 "옛 산출물이라 신규 지표가 없다"를 말할 때 쓴다 */
  schema: number
  byId: Record<string, PrecomputedPreset>
  /** 참고 벽(schema 3~) — 없으면 undefined이고 화면은 34차 상수로 강등한다 */
  walls?: PrecomputedWall[]
  /**
   * 이 산출물을 구울 때 쓴 국내 시세 소스. **옛 산출물(schema 1~3)에는 없으므로 'yahoo'로 읽는다** —
   * 그때는 야후밖에 없었기 때문이며, 추측이 아니라 사실이다.
   * 화면은 지금 고른 소스와 이 값이 다르면 "다른 소스로 구운 수치"라고 알린다(규칙 3).
   */
  priceSource: PriceSource
  priceSourceNote: string
  priceSourceLimits: string[]
}

/**
 * 응답이 우리가 아는 모양인지 최소한만 확인한다(모르는 모양이면 없는 셈 친다).
 * 알려진 스키마 버전이면 **필드가 빠져 있어도** 받아들인다 — 빠진 신규 지표는 화면에서 '—'다.
 */
export function toPrecomputedIndex(raw: unknown): PrecomputedIndex | null {
  const f = raw as PrecomputedFile | null
  if (!f || typeof f !== 'object') return null
  if (!SUPPORTED_PRECOMPUTE_SCHEMAS.includes(f.schema)) return null
  if (!Array.isArray(f.presets)) return null
  const byId: Record<string, PrecomputedPreset> = {}
  for (const p of f.presets) {
    if (!p || typeof p.id !== 'string' || !Array.isArray(p.curve)) continue
    byId[p.id] = p
  }
  if (Object.keys(byId).length === 0) return null
  return {
    asOf: typeof f.asOf === 'string' ? f.asOf : '',
    computedAt: typeof f.computedAt === 'string' ? f.computedAt : '',
    curveInterval: 'weekly',
    cost: f.cost,
    note: typeof f.note === 'string' ? f.note : '',
    schema: f.schema,
    byId,
    // 없으면 'yahoo' — 시세 소스 표기가 없던 시절(schema 1~3)의 산출물은 전부 야후로 구웠다.
    priceSource: normalizePriceSource(f.priceSource),
    priceSourceNote: typeof f.priceSourceNote === 'string' ? f.priceSourceNote : '',
    priceSourceLimits: Array.isArray(f.priceSourceLimits)
      ? f.priceSourceLimits.filter((l): l is string => typeof l === 'string')
      : [],
    // 모르는 모양의 벽은 통째로 버린다 — 반쪽짜리 수치를 화면에 올리느니 상수로 강등하는 편이 낫다.
    walls: Array.isArray(f.walls)
      ? f.walls.filter(
          (w): w is PrecomputedWall =>
            w != null &&
            typeof w === 'object' &&
            (w.kind === 'qqqKrw' || w.kind === 'benchKr') &&
            Number.isFinite(w.calmar) &&
            Number.isFinite(w.cagrPct) &&
            Number.isFinite(w.mddPct),
        )
      : undefined,
  }
}

/**
 * 산출물을 한 번 읽어 둔다. 없으면 null — 호출부는 **없을 때를 기본 동작으로** 짜야 한다.
 * (404·JSON 오류·스키마 불일치는 전부 조용히 null. 부가 기능이 화면을 막지 않는다.)
 */
export function usePrecomputedPresets(): PrecomputedIndex | null {
  const [idx, setIdx] = useState<PrecomputedIndex | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`${import.meta.env.BASE_URL}data/presets-precomputed.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive) setIdx(toPrecomputedIndex(j))
      })
      .catch(() => {
        /* 없으면 없는 대로 — 예전 화면 그대로 동작한다 */
      })
    return () => {
      alive = false
    }
  }, [])
  return idx
}

// ---- 라벨 병기 --------------------------------------------------------------

/** `MDD −61%` — 낙폭은 정수 %로 붙인다(라벨이 길어지면 셀렉트에서 잘린다) */
export function mddChip(mddPct: number): string {
  return `MDD ${mddPct <= 0 ? '−' : '+'}${Math.abs(mddPct).toFixed(0)}%`
}

/** `10y 연평균 +12.3%` — 최근 10년 연환산. 곡선이 10년을 못 채우면 붙이지 않는다. */
export function tenYearChip(cagr10yPct: number | null): string | null {
  if (cagr10yPct == null || !Number.isFinite(cagr10yPct)) return null
  return `10y 연평균 ${cagr10yPct >= 0 ? '+' : '−'}${Math.abs(cagr10yPct).toFixed(1)}%`
}

/**
 * 라벨에 손으로 박아 둔 `(MDD −61%)` 조각. 사전계산 값이 있으면 **그 값이 이 자리를 대신**하므로
 * 떼어낸다(같은 지표가 두 번 붙어 서로 다른 숫자를 말하는 것을 막는다).
 * 사전계산이 없을 때는 그대로 둔다 — 그때는 이 하드코딩이 유일한 낙폭 경고다(규칙 4).
 */
const HARDCODED_MDD = /\s*\(MDD\s*[^)]*\)/

/**
 * 프리셋 라벨에 사전계산 수치를 병기한다 — `기존라벨 · MDD −61% · 10y 연평균 +12.3%`.
 * 사전계산이 없으면 **원래 라벨 그대로** 돌려준다(우아한 강등).
 * 붙는 숫자는 전부 산출물에서 온다 — 갱신되면 라벨도 따라 바뀐다(하드코딩 금지).
 */
export function augmentPresetLabel(label: string, pc: PrecomputedPreset | undefined | null): string {
  if (!pc) return label
  const base = label.replace(HARDCODED_MDD, '')
  const chips = [mddChip(pc.mddPct), tenYearChip(pc.cagr10yPct)].filter((s): s is string => s != null)
  return chips.length ? `${base} · ${chips.join(' · ')}` : base
}

// ---- 곡선 어댑터 ------------------------------------------------------------

/**
 * 저장된 튜플 곡선을 차트가 읽는 행으로 바꾼다.
 * `drawdownPct`는 **저장된 주 단위 곡선에서 다시 잰 값**이라 원곡선보다 얕을 수 있다 —
 * 화면의 MDD 카드는 이 값이 아니라 산출물의 `mddPct`(원곡선 기준)를 쓴다.
 */
export function precomputedToEquityRows(pc: PrecomputedPreset): EquityRow[] {
  const rows: EquityRow[] = []
  let peak = 0
  for (const [date, equity, benchmark] of pc.curve) {
    peak = Math.max(peak, equity)
    rows.push({
      date,
      equity,
      benchmark,
      drawdownPct: peak > 0 ? (equity / peak - 1) * 100 : 0,
    })
  }
  return rows
}

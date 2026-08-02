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

/** 화면이 읽을 수 있는 산출물 스키마 버전. 다르면 무시한다. */
export const PRECOMPUTE_SCHEMA = 1

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
}

export interface PrecomputedFile {
  schema: number
  asOf: string
  computedAt: string
  curveInterval: 'weekly'
  cost: CostSettings
  note: string
  presets: PrecomputedPreset[]
}

export interface PrecomputedIndex {
  asOf: string
  computedAt: string
  curveInterval: 'weekly'
  cost: CostSettings
  note: string
  byId: Record<string, PrecomputedPreset>
}

/** 응답이 우리가 아는 모양인지 최소한만 확인한다(모르는 모양이면 없는 셈 친다). */
function toIndex(raw: unknown): PrecomputedIndex | null {
  const f = raw as PrecomputedFile | null
  if (!f || typeof f !== 'object') return null
  if (f.schema !== PRECOMPUTE_SCHEMA) return null
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
    byId,
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
        if (alive) setIdx(toIndex(j))
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

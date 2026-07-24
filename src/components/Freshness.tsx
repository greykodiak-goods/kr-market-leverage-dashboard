import { useEffect, useState } from 'react'
import { differenceInBusinessDays, format, isValid, parseISO } from 'date-fns'

// 전 화면 공통 최신성 표기 (통일 규칙):
//   일별 데이터  → "기준일 YYYY-MM-DD"   (기대 주기 2영업일 초과 시 ⚠️ 지연)
//   실시간 데이터 → "최종 갱신 HH:mm:ss" (기대 주기 1분, 3배 초과 시 ⚠️ 지연)
// 모든 데이터 카드는 이 컴포넌트로 최신성을 표기한다 — 개별 포맷 금지.

export const DAILY_EXPECT_BDAYS = 2 // 일별 통계 기대 주기(영업일)
export const REALTIME_EXPECT_MS = 60_000 // 실시간 기대 주기(1분)
const REALTIME_STALE_FACTOR = 3 // 1분 주기 × 3 = 3분 초과 시 경고

// 일별 기준일이 기대 주기(영업일)를 초과했는지. (주말·판단불가 날짜는 false)
export function isDailyStale(asOf: string | null | undefined, expectBDays = DAILY_EXPECT_BDAYS): boolean {
  if (!asOf) return false
  const d = parseISO(asOf)
  if (!isValid(d)) return false
  return differenceInBusinessDays(new Date(), d) > expectBDays
}

interface DailyProps {
  kind: 'daily'
  asOf: string | null | undefined // 'YYYY-MM-DD'
  expectBDays?: number
  prefix?: string // 기본 '기준일'
}

interface RealtimeProps {
  kind: 'realtime'
  at: number | null | undefined // epoch ms (예: quote.fetchedAt)
  expectMs?: number
}

type Props = (DailyProps | RealtimeProps) & { className?: string }

function StaleBadge({ title }: { title: string }) {
  return (
    <span className="freshness-stale" role="alert" title={title}>
      ⚠️ 지연
    </span>
  )
}

export function Freshness(props: Props) {
  // 실시간 표기는 30초마다 재평가해 경고가 스스로 켜지고 꺼지게 한다.
  const [, tick] = useState(0)
  const realtime = props.kind === 'realtime'
  useEffect(() => {
    if (!realtime) return
    const id = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [realtime])

  if (props.kind === 'daily') {
    if (!props.asOf) return null
    const stale = isDailyStale(props.asOf, props.expectBDays)
    return (
      <span className={`freshness${props.className ? ` ${props.className}` : ''}`}>
        {props.prefix ?? '기준일'} {props.asOf}
        {stale && <StaleBadge title={`기대 갱신 주기(${props.expectBDays ?? DAILY_EXPECT_BDAYS}영업일)를 초과했습니다`} />}
      </span>
    )
  }

  if (props.at == null) return null
  const expect = props.expectMs ?? REALTIME_EXPECT_MS
  const stale = Date.now() - props.at > expect * REALTIME_STALE_FACTOR
  return (
    <span className={`freshness${props.className ? ` ${props.className}` : ''}`}>
      최종 갱신 {format(new Date(props.at), 'HH:mm:ss')}
      {stale && <StaleBadge title={`기대 갱신 주기(${Math.round(expect / 1000)}초)의 3배를 초과했습니다`} />}
    </span>
  )
}

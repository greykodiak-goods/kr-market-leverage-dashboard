// 상주 데몬 스케줄 — **순수 로직만**. 네트워크·파일·주문 없음.
//
// 왜 분리했나: 데몬 본체(investing-daemon.entry.ts)는 최상위에서 실행되므로 테스트가
// import 할 수 없다. "언제 무엇을 도는가"라는 판정은 사고가 가장 잘 나는 자리이므로
// 여기에 순수 함수로 떼어 두고 tests/investing-daemon.test.ts 가 직접 검증한다.
//
// 시각은 전부 **KST 기준**이다. Date 를 쓰지만 판정은 인자로 받은 시각만 보므로
// (실행 시각을 내부에서 읽지 않는다) 테스트가 임의 시각을 주입할 수 있다.

/** 하루를 쪼개는 단계 */
export type PhaseName = 'preload' | 'sells' | 'confirm' | 'buys' | 'close'

export interface SlotDef {
  name: PhaseName
  label: string
  /** 실행 시각 (KST, HH:MM:SS) */
  at: string
  /**
   * 만회 실행 마감 (KST). 데몬이 죽어 있다 늦게 떴을 때 **이 시각까지만** 만회한다.
   * 장 끝난 뒤에 매수를 내는 사고를 막는 안전선이라 넉넉히 잡지 않는다.
   */
  until: string
}

/**
 * 하루 스케줄 (2026-08-01 대표 확정).
 *
 * 매도를 **개장 동시호가(08:30~09:00)의 끝자락에 시장가로 접수**하는 것이 이 데몬의 핵심이다.
 * 백테스트 가정이 "매도 = 익일 시가"인데 크론은 15:20에 팔아 하루치 종가 변동을 통째로
 * 더 먹거나 잃었다. 08:59:30에 시장가로 넣으면 09:00 개장가로 체결되므로 가정과 일치한다.
 * 시장가라 미체결이 날 일은 드물지만, 그래도 09:01에 체결을 확인하고 미체결이면 1회 재주문한다.
 */
export const SLOTS: readonly SlotDef[] = Object.freeze([
  // 장 시작 전: 시세 재로딩 + **전일 종가 기준** 청산 대상 확정 + 토큰 워밍업
  { name: 'preload', label: '프리로드', at: '08:30:00', until: '15:19:00' },
  // 개장 동시호가 마감 직전 시장가 접수 → 09:00 개장가 체결(= 백테스트의 '익일 시가 매도')
  { name: 'sells', label: '매도접수', at: '08:59:30', until: '15:00:00' },
  // 체결 확인 — 미체결이면 1회 재주문, 그리고 체결가로 장부 반영
  { name: 'confirm', label: '체결확인', at: '09:01:00', until: '15:00:00' },
  // 종가 근사 매수 (승자 전략의 체결 타이밍이 sameClose)
  { name: 'buys', label: '매수', at: '15:20:00', until: '15:29:00' },
  // 마감: 평가·요약·저널 + 데이터 커밋
  { name: 'close', label: '마감', at: '16:10:00', until: '23:50:00' },
] as const)

/** 당일 시가를 기다려 주는 한계 시각(KST). 이때까지도 당일 봉이 없으면 휴장·데이터 장애로 본다. */
export const OPEN_WAIT_UNTIL = '09:40:00'

/** 실패한 단계를 다시 시도하기까지의 최소 간격(초). 보조 tick 주기(30초)와 다르다. */
export const DEFAULT_RETRY_GAP_SEC = 300

/** 정밀 알람이 한 번에 잡을 수 있는 최대 대기(ms) — 시계 변경·절전 복귀에서 회복하기 위한 상한. */
export const MAX_SLEEP_MS = 6 * 3600e3

const KST_OFFSET_MS = 9 * 3600e3

/** 'HH:MM:SS' → 자정으로부터의 초 */
export function hmsToSec(hms: string): number {
  const [h = '0', m = '0', s = '0'] = hms.split(':')
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}

export interface KstParts {
  /** KST 날짜 YYYY-MM-DD */
  date: string
  /** KST 자정으로부터의 초 */
  sec: number
  /** KST 요일 (0=일 … 6=토) */
  weekday: number
}

/** UTC 기준 Date 를 KST 날짜·초·요일로 쪼갠다. */
export function kstParts(now: Date): KstParts {
  const shifted = new Date(now.getTime() + KST_OFFSET_MS)
  return {
    date: shifted.toISOString().slice(0, 10),
    sec: shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  }
}

/** KST 주말인가 (토·일). **공휴일은 여기서 모른다** — 봉이 없다는 사실로 각 단계가 판정한다. */
export function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6
}

export interface DayState {
  /** 이 상태가 속한 KST 날짜 */
  date: string
  /** 오늘 이미 끝낸 단계 */
  done: PhaseName[]
  /** 단계별 마지막 시도 시각 (ISO) — 실패 재시도 간격 계산용 */
  lastAttemptAt?: Partial<Record<PhaseName, string>>
}

/**
 * 지금 실행해야 할 단계들을 **순서대로** 돌려준다. 정밀 알람과 보조 tick 이 함께 부른다.
 *
 * 규칙
 *   - KST 주말이면 아무것도 하지 않는다(빈 배열).
 *   - 상태의 날짜가 오늘과 다르면 새 날로 보고 done/시도기록을 무시한다(날짜 넘어가면 초기화).
 *   - 슬롯 시각이 지났고 아직 안 끝냈으면 due — **놓친 슬롯도 당일 `until` 까지는 만회**한다
 *     (데몬이 09:30에 재시작해도 프리로드·매도·체결확인을 그날 안에 한 번은 돈다.
 *      단, 그때의 시장가 매도는 동시호가가 아니라 장중 체결이라 시가 가정과 어긋난다 —
 *      그 사실은 저널에 남긴다).
 *   - `until` 이 지난 슬롯은 영구히 건너뛴다. 장 끝난 뒤 주문이 나가는 것이 더 나쁘다.
 *   - 직전 시도가 `retryGapSec` 안이면 미룬다(실패 단계가 30초마다 재시도하며 API를 때리지 않게).
 */
export function dueSlots(
  now: Date,
  state: DayState,
  opts: { retryGapSec?: number; slots?: readonly SlotDef[] } = {},
): PhaseName[] {
  const { retryGapSec = DEFAULT_RETRY_GAP_SEC, slots = SLOTS } = opts
  const { date, sec, weekday } = kstParts(now)
  if (isWeekend(weekday)) return []
  const sameDay = state.date === date
  const done = new Set(sameDay ? state.done : [])
  const attempts = sameDay ? state.lastAttemptAt ?? {} : {}
  const out: PhaseName[] = []
  for (const slot of slots) {
    if (done.has(slot.name)) continue
    if (sec < hmsToSec(slot.at)) continue
    if (sec > hmsToSec(slot.until)) continue
    const last = attempts[slot.name]
    if (last) {
      const elapsed = (now.getTime() - Date.parse(last)) / 1000
      if (Number.isFinite(elapsed) && elapsed < retryGapSec) continue
    }
    out.push(slot.name)
  }
  return out
}

/** 다음에 열릴 슬롯(로그·알람용). 오늘 남은 게 없으면 null. */
export function nextSlot(now: Date, state: DayState): SlotDef | null {
  const { date, sec, weekday } = kstParts(now)
  if (isWeekend(weekday)) return null
  const done = new Set(state.date === date ? state.done : [])
  return SLOTS.find((s) => !done.has(s.name) && sec < hmsToSec(s.at)) ?? null
}

/**
 * **정밀 알람용** — 다음 슬롯까지 남은 ms. 초 단위 폴링 대신 이만큼 자고 깨어난다.
 * 오늘 남은 슬롯이 없으면 다음 날 첫 슬롯까지. 상한 `MAX_SLEEP_MS`(시계 변경·절전 복귀 대비),
 * 하한 1초(0ms 타이머로 CPU 를 태우지 않게).
 */
export function msUntilNextSlot(now: Date, state: DayState, opts: { maxMs?: number } = {}): number {
  const { maxMs = MAX_SLEEP_MS } = opts
  const { date, sec, weekday } = kstParts(now)
  const done = new Set(state.date === date ? state.done : [])
  const upcoming = isWeekend(weekday)
    ? null
    : SLOTS.filter((s) => !done.has(s.name)).find((s) => hmsToSec(s.at) > sec)
  // 200ms 여유 — 슬롯 시각 '직후'에 깨어야 dueSlots(sec >= at)가 잡는다.
  const raw = upcoming
    ? (hmsToSec(upcoming.at) - sec) * 1000 + 200
    : (86400 - sec + hmsToSec(SLOTS[0].at)) * 1000 + 200
  return Math.min(maxMs, Math.max(1000, raw))
}

// 시세 캐시 — 컬럼형 압축 + 용량 초과 시 자동 정리 검증.
// 회귀 방지 대상: 모델·종목이 늘자 localStorage 5MB 한도를 넘겨
// QuotaExceededError가 나고 캐시가 통째로 깨지던 실제 버그.

// history.ts는 모듈 로드 시점에 localStorage를 건드리지 않으므로,
// import 후 함수 호출 전에 스텁을 심어두면 된다.
class FakeStorage {
  private map = new Map<string, string>()
  constructor(private limitBytes: number) {}
  get length() {
    return this.map.size
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  setItem(k: string, v: string) {
    let used = 0
    for (const [kk, vv] of this.map) if (kk !== k) used += kk.length + vv.length
    if (used + k.length + v.length > this.limitBytes) {
      const e = new Error('QuotaExceededError')
      e.name = 'QuotaExceededError'
      throw e
    }
    this.map.set(k, v)
  }
  bytes(): number {
    let n = 0
    for (const [k, v] of this.map) n += k.length + v.length
    return n
  }
}

function useStorage(limit: number): FakeStorage {
  const s = new FakeStorage(limit)
  ;(globalThis as unknown as { localStorage: FakeStorage }).localStorage = s
  return s
}
useStorage(50_000_000)

import { check, finish, section } from './harness'
import {
  parseYahooDaily,
  packHistory,
  unpackHistory,
  readHistoryCache,
  writeHistoryCache,
  CACHE_PREFIX,
} from '../src/lib/history'

function fixture(n: number, base: number) {
  const timestamp: number[] = []
  const open: number[] = []
  const high: number[] = []
  const low: number[] = []
  const close: number[] = []
  const volume: number[] = []
  const adjclose: number[] = []
  let p = base
  for (let i = 0; i < n; i++) {
    timestamp.push(1500000000 + i * 86400)
    open.push(p)
    high.push(p * 1.01)
    low.push(p * 0.99)
    close.push(p * 1.005)
    volume.push(1_000_000 + i)
    adjclose.push(p * 1.005 * 0.98)
    p *= 1.0004
  }
  return {
    chart: {
      result: [
        {
          meta: { currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS', instrumentType: 'ETF', gmtoffset: 0 },
          timestamp,
          indicators: { quote: [{ open, high, low, close, volume }], adjclose: [{ adjclose }] },
        },
      ],
    },
  }
}

section('1) 압축 — 컬럼형이 객체 배열보다 확실히 작다')
{
  const hist = parseYahooDaily('TEST', fixture(2500, 100), 'unit')
  const objSize = JSON.stringify(hist).length
  const colSize = JSON.stringify(packHistory(hist)).length
  check(`컬럼형이 40% 이상 작음 (객체 ${objSize} → 컬럼 ${colSize})`, colSize < objSize * 0.6, `비율 ${(colSize / objSize).toFixed(2)}`)
}

section('2) 왕복 정합성 — 저장했다 읽어도 값이 같다')
{
  useStorage(50_000_000)
  const hist = parseYahooDaily('RT', fixture(400, 12345.6789), 'unit')
  const key = `${CACHE_PREFIX}v3:RT:10y`
  writeHistoryCache(key, hist)
  const back = readHistoryCache(key)
  check('복원 성공', back != null)
  if (back) {
    check('봉 개수 동일', back.bars.length === hist.bars.length)
    check('날짜 동일', back.bars.every((b, i) => b.date === hist.bars[i].date))
    check('가격 오차 0.0001 이내', back.bars.every((b, i) =>
      Math.abs(b.o - hist.bars[i].o) <= 0.0001 &&
      Math.abs(b.h - hist.bars[i].h) <= 0.0001 &&
      Math.abs(b.l - hist.bars[i].l) <= 0.0001 &&
      Math.abs(b.c - hist.bars[i].c) <= 0.0001))
    check('거래량 동일', back.bars.every((b, i) => b.v === hist.bars[i].v))
    check('메타 보존(통화·보정·출처)', back.currency === hist.currency && back.adjustment === hist.adjustment && back.proxyUsed === hist.proxyUsed)
    check('OHLC 대소관계 유지', back.bars.every((b) => b.l <= b.o && b.l <= b.c && b.h >= b.o && b.h >= b.c))
    check('t(epoch) 재생성됨', back.bars.every((b) => Number.isFinite(b.t) && b.t > 0))
  }
  const roundTrip = unpackHistory(packHistory(hist))
  check('pack→unpack 직접 왕복도 동일', roundTrip.bars.length === hist.bars.length)
}

section('3) 용량 초과 — 예외로 죽지 않고 오래된 것부터 정리한다')
{
  const store = useStorage(400_000) // 2500봉 3~4개 정도만 들어가는 한도
  const symbols = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  let threw = false
  try {
    symbols.forEach((sym, i) => {
      const h = parseYahooDaily(sym, fixture(2500, 100 + i), 'unit')
      h.fetchedAt = 1_700_000_000_000 + i * 1000 // 오래된 것부터 순서 부여
      writeHistoryCache(`${CACHE_PREFIX}v3:${sym}:10y`, h)
    })
  } catch {
    threw = true
  }
  check('용량 초과에도 예외 전파 없음', !threw)
  check('한도를 넘지 않음', store.bytes() <= 400_000, `${store.bytes()}`)
  check('가장 최신 항목은 살아있음', readHistoryCache(`${CACHE_PREFIX}v3:H:10y`) != null)
  check('가장 오래된 항목은 정리됨', readHistoryCache(`${CACHE_PREFIX}v3:A:10y`) == null)
  check('일부는 캐시에 남음', store.length >= 1, `${store.length}개`)
}

section('4) 앱 설정은 정리 대상에서 제외된다')
{
  const store = useStorage(400_000)
  store.setItem('bt-model-configs-v2', JSON.stringify({ keep: 'me' }))
  store.setItem('bt-enrollments-v1', JSON.stringify({ keep: 'me' }))
  for (let i = 0; i < 8; i++) {
    const h = parseYahooDaily(`S${i}`, fixture(2500, 100 + i), 'unit')
    h.fetchedAt = 1_700_000_000_000 + i * 1000
    writeHistoryCache(`${CACHE_PREFIX}v3:S${i}:10y`, h)
  }
  check('모델 설정 보존', store.getItem('bt-model-configs-v2') != null)
  check('모의운용 등록 보존', store.getItem('bt-enrollments-v1') != null)
}

section('5) 저장 실패해도 조회는 안전하게 null')
{
  useStorage(10) // 아무것도 못 넣는 한도
  const h = parseYahooDaily('TINY', fixture(200, 100), 'unit')
  let threw = false
  try {
    writeHistoryCache(`${CACHE_PREFIX}v3:TINY:10y`, h)
  } catch {
    threw = true
  }
  check('저장 불가 상황에서도 예외 없음', !threw)
  check('조회는 null 반환', readHistoryCache(`${CACHE_PREFIX}v3:TINY:10y`) == null)
}

finish()

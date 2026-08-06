// QQQ 배수 전략 프리셋 — **정직성 불변식** 테스트.
//
// 이 프리셋들은 관문을 통과해서 올라온 것이 아니라 대표 지시로 등재된 것이다(2026-08-06).
// 그래서 "탈락 사실이 라벨·note 맨 앞에 있는가"가 코드 규약이며, 이 파일이 그것을 강제한다.
// 다음 세션이 경고를 지우거나 라벨을 예쁘게 바꾸면 여기서 실패한다.

import { check, eq, section, finish } from './harness'
import {
  US_LEVERAGE_PRESETS,
  US_LEV_BANNER,
  US_LEV_FAILED_PREFIX,
  US_LEV_LIMITS,
  US_LEV_READ_HINT,
  US_LEV_SCHEMA,
  US_LEV_SUPPORTED_SCHEMAS,
} from '../src/features/backtest/usLeveragePresets'
import { downsample, DOWNSAMPLE } from '../scripts/us-leverage-precompute.entry'

// ============================================================================
section('1. 라벨·note가 탈락 사실을 먼저 말하는가')
// ============================================================================

check('프리셋이 비어있지 않다', US_LEVERAGE_PRESETS.length > 0, `${US_LEVERAGE_PRESETS.length}종`)

for (const p of US_LEVERAGE_PRESETS) {
  check(`[${p.id}] 라벨에 '[탈락]'이 있다`, p.label.includes('[탈락]'), p.label)
  check(`[${p.id}] 라벨이 ❌로 시작한다`, p.label.trimStart().startsWith('❌'), p.label)
  check(`[${p.id}] note가 탈락 문구로 시작한다`, p.note.startsWith(US_LEV_FAILED_PREFIX))
  check(`[${p.id}] note에 공통 한계가 붙어 있다`, p.note.includes(US_LEV_LIMITS))
  check(`[${p.id}] 규칙 설명이 있다`, p.rule.length > 20)
  check(`[${p.id}] note에 MDD가 적혀 있다`, /MDD −\d/.test(p.note) || /MDD -\d/.test(p.note))
  check(`[${p.id}] note에 '매매를 붙이지 마라'가 있다`, p.note.includes('매매를 붙이지 마라'))
}

check('배너가 탈락을 먼저 말한다', US_LEV_BANNER.includes('탈락') && US_LEV_BANNER.includes('⛔'))
check('배너가 QLD 단순보유 우위를 명시한다', US_LEV_BANNER.includes('QLD'))
check('읽는 법 안내가 칼마를 가리킨다', US_LEV_READ_HINT.includes('칼마'))
check('공통 한계가 닷컴 낙폭을 명시한다', US_LEV_LIMITS.includes('97.8'))
check('공통 한계가 환율·세금 미반영을 명시한다', US_LEV_LIMITS.includes('환율') && US_LEV_LIMITS.includes('세금'))
check('공통 한계가 레버리지 ETF 위험을 명시한다', US_LEV_LIMITS.includes('변동성 잠식'))

// ============================================================================
section('2. 파라미터 무결성')
// ============================================================================

const ids = new Set<string>()
for (const p of US_LEVERAGE_PRESETS) {
  check(`[${p.id}] id 중복 없음`, !ids.has(p.id))
  ids.add(p.id)
  check(`[${p.id}] 2단 밴드가 1단보다 깊다`, p.params.band2Pct > p.params.band1Pct)
  check(`[${p.id}] 익절 방아쇠 > 0`, p.params.tpStepPct > 0)
  check(`[${p.id}] 익절 규모가 0~100 사이`, p.params.tpFracPct > 0 && p.params.tpFracPct <= 100)
  check(`[${p.id}] 1단 교체 비율이 0~100 사이`, p.params.stage1SwapPct > 0 && p.params.stage1SwapPct <= 100)
}

eq('현재 스키마가 지원 목록에 있다', US_LEV_SUPPORTED_SCHEMAS.includes(US_LEV_SCHEMA), true)

// ============================================================================
section('3. 다운샘플 — 마지막 점을 잃지 않는가')
// ============================================================================

{
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ date: `2010-01-${String((i % 28) + 1).padStart(2, '0')}`, equity: 100 + i }))
  for (const n of [1, 2, DOWNSAMPLE, DOWNSAMPLE + 1, 97, 1000]) {
    const s = mk(n)
    const b = mk(n)
    const out = downsample(s, b)
    check(`${n}봉 — 마지막 점이 남는다`, out[out.length - 1][0] === s[n - 1].date, `${out[out.length - 1][0]}`)
    check(`${n}봉 — 첫 점이 남는다`, out[0][0] === s[0].date)
    check(`${n}봉 — 원본보다 길지 않다`, out.length <= n)
  }
  // 마지막 값이 잘리면 라벨이 거짓이 된다 — 값 자체도 확인
  const s = mk(97)
  const out = downsample(s, s)
  eq('마지막 점의 값이 원곡선 마지막 값과 같다', out[out.length - 1][1], Math.round(s[96].equity))
}

finish()

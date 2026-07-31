// 키움 REST 파서 검증 — 부호·시간·정렬·불량 행 처리.
// 응답 구조는 2026-07-30 모의서버 실측(probe) 기준. 값 표본이 바뀌면 여기도 갱신한다.

import { numAbs, parseCntrTm, parseMinuteChart } from '../scripts/lib/kiwoom.mjs'
import { check, eq, finish, section } from './harness'

section('1) numAbs — 대비부호 정규화')
{
  eq('부호 없음', numAbs('70200'), 70200)
  eq('+ 부호', numAbs('+70200'), 70200)
  eq('- 부호(대비표시)', numAbs('-70200'), 70200)
  eq('null', numAbs(null), null)
  eq('빈 문자열', numAbs(''), null)
  eq('숫자 아님', numAbs('abc'), null)
}

section('2) parseCntrTm — KST 체결시간 → epoch 초')
{
  const t = parseCntrTm('20260730133000')
  check('파싱 성공', t != null)
  // KST 13:30 = UTC 04:30
  eq('UTC 환산', new Date((t as number) * 1000).toISOString(), '2026-07-30T04:30:00.000Z')
  eq('형식 불량', parseCntrTm('1330'), null)
  eq('null', parseCntrTm(null), null)
}

section('3) parseMinuteChart — 정규화·정렬·탈락')
{
  const json = {
    stk_cd: '005930',
    stk_min_pole_chart_qry: [
      // 내림차순으로 온다고 가정(실측: 최신이 먼저 [미검증]) — 파서는 순서 무관하게 오름차순 정렬
      { cur_prc: '-70300', open_pric: '+70100', high_pric: '70400', low_pric: '70000', trde_qty: '1200', cntr_tm: '20260730133500' },
      { cur_prc: '70100', open_pric: '70000', high_pric: '+70200', low_pric: '-69900', trde_qty: '800', cntr_tm: '20260730133000' },
      { cur_prc: 'bad', open_pric: '1', high_pric: '1', low_pric: '1', trde_qty: '1', cntr_tm: '20260730134000' }, // 불량 행
    ],
    return_code: 0,
    return_msg: '정상',
  }
  const r = parseMinuteChart(json)
  eq('심볼', r.symbol, '005930')
  eq('봉 수', r.bars.length, 2)
  eq('불량 행 탈락', r.dropped, 1)
  check('오름차순 정렬', r.bars[0].t < r.bars[1].t)
  eq('부호 제거된 종가', r.bars[1].c, 70300)
  eq('거래량', r.bars[0].v, 800)
}

section('4) 빈/이상 응답')
{
  eq('빈 객체', parseMinuteChart({}).bars.length, 0)
  eq('null', parseMinuteChart(null as never).bars.length, 0)
}

finish()

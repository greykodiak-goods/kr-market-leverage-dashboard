// 큰손 자금 레이더 — 여러 종목의 매집/분산 흔적을 한 화면에서 비교한다.
//
// 이 섹션이 답하려는 질문: "지금 큰돈이 어디로 들어가고 어디서 빠지는가."
// 실제 보유지분이 아니라 가격·거래량에서 읽은 **정황 증거(프록시)**임을 화면에서 명시한다.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { InfoTip } from '../../components/InfoTip'
import { getDailyHistory, type HistoryResult } from '../../lib/history'
import { smartMoneySnapshot, type ScorePart, type SmartMoneySnapshot } from './smartMoney'

interface Watch {
  symbol: string
  label: string
  group: '한국' | 'AI·반도체' | '지수·방어'
  bench: string
}

const KR_BENCH = '069500.KS' // KODEX 200
const US_BENCH = 'SPY'

// 후보는 "하이닉스에 영향을 주는 자금 경로"를 따라 골랐다.
// 국내 수급 → 한국 / HBM 수요 축 → AI·반도체 / 위험선호 판단 → 지수·방어.
export const WATCHLIST: Watch[] = [
  { symbol: '000660.KS', label: 'SK하이닉스', group: '한국', bench: KR_BENCH },
  { symbol: '005930.KS', label: '삼성전자', group: '한국', bench: KR_BENCH },
  { symbol: '069500.KS', label: 'KODEX 200', group: '한국', bench: KR_BENCH },
  { symbol: 'NVDA', label: '엔비디아', group: 'AI·반도체', bench: US_BENCH },
  { symbol: 'AVGO', label: '브로드컴', group: 'AI·반도체', bench: US_BENCH },
  { symbol: 'MU', label: '마이크론', group: 'AI·반도체', bench: US_BENCH },
  { symbol: 'TSM', label: 'TSMC', group: 'AI·반도체', bench: US_BENCH },
  { symbol: 'SMH', label: '미 반도체 ETF', group: 'AI·반도체', bench: US_BENCH },
  { symbol: 'QQQ', label: '나스닥100', group: '지수·방어', bench: US_BENCH },
  { symbol: 'SPY', label: 'S&P500', group: '지수·방어', bench: US_BENCH },
  { symbol: 'TLT', label: '미 장기국채', group: '지수·방어', bench: US_BENCH },
  { symbol: 'GLD', label: '금', group: '지수·방어', bench: US_BENCH },
]

const GROUPS: Watch['group'][] = ['한국', 'AI·반도체', '지수·방어']

// 스냅샷의 label은 "판정"(강한 매집 등), 감시목록의 label은 "종목명"이라
// 이름이 겹친다. 표시용 이름은 name으로 분리해 섞이지 않게 한다.
export interface RadarRow extends SmartMoneySnapshot {
  name: string
  group: Watch['group']
  error?: string
}

// 필요한 심볼(감시목록 + 벤치마크)을 한 번씩만 받아온다.
async function loadRadar(): Promise<RadarRow[]> {
  const needed = Array.from(new Set([...WATCHLIST.map((w) => w.symbol), KR_BENCH, US_BENCH]))
  const hist: Record<string, HistoryResult | null> = {}
  await Promise.all(
    needed.map(async (s) => {
      try {
        hist[s] = await getDailyHistory(s, '5y')
      } catch {
        hist[s] = null
      }
    }),
  )
  return WATCHLIST.map((w) => {
    const h = hist[w.symbol]
    const b = hist[w.bench]
    if (!h || !h.bars.length) {
      return {
        symbol: w.symbol,
        name: w.label,
        group: w.group,
        asOf: '—',
        score: null,
        label: '판단 불가',
        parts: [],
        bars: 0,
        error: '데이터 없음',
      }
    }
    // 자기 자신이 벤치마크면 상대강도는 의미가 없으므로 제외한다.
    const bench = w.symbol === w.bench ? null : (b?.bars ?? null)
    const snap = smartMoneySnapshot(w.symbol, h.bars, bench)
    return { ...snap, name: w.label, group: w.group }
  })
}

function scoreClass(score: number | null): string {
  if (score == null) return 'sm-na'
  if (score >= 45) return 'sm-strong-up'
  if (score >= 15) return 'sm-up'
  if (score <= -45) return 'sm-strong-down'
  if (score <= -15) return 'sm-down'
  return 'sm-flat'
}

function Bar({ part }: { part: ScorePart }) {
  const n = part.norm
  if (n == null) return <span className="sm-cell-na">—</span>
  const pct = Math.abs(n) * 50 // 중앙 기준 좌우 최대 50%
  return (
    <span className="sm-minibar" title={`${part.label}: ${part.display}`}>
      <span className="sm-minibar-track">
        <span
          className={`sm-minibar-fill ${n >= 0 ? 'pos' : 'neg'}`}
          style={n >= 0 ? { left: '50%', width: `${pct}%` } : { right: '50%', width: `${pct}%` }}
        />
      </span>
      <span className="sm-minibar-val">{part.display}</span>
    </span>
  )
}

export function SmartMoneyRadar() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['smart-money-radar'],
    queryFn: loadRadar,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const [open, setOpen] = useState<string | null>(null)

  const rows = data ?? []
  const ranked = useMemo(() => [...rows].sort((a, b) => (b.score ?? -999) - (a.score ?? -999)), [rows])
  const usable = ranked.filter((r) => r.score != null)
  const asOf = useMemo(() => {
    const dates = rows.map((r) => r.asOf).filter((d) => d && d !== '—')
    return dates.length ? dates.sort()[dates.length - 1] : null
  }, [rows])

  const partKeys = rows.find((r) => r.parts.length)?.parts ?? []

  return (
    <section className="panel sm-panel">
      <div className="panel-head" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2>
            큰손 자금 레이더{' '}
            <InfoTip
              label="계산 방식 설명"
              text="실제 기관 보유지분이 아니라 가격·거래량에서 읽은 정황 증거입니다. 큰 자금은 한 번에 못 사고 며칠에 걸쳐 나눠 담기 때문에, 거래량이 실린 날의 종가 위치와 누적 거래량 방향에 흔적이 남습니다. 네 개 지표를 가중 합성해 −100(분산) ~ +100(매집)으로 환산합니다."
            />
          </h2>
          <div className="panel-sub">
            가격·거래량 기반 매집/분산 추정 · 12종목 · 기준 {asOf ?? '—'}
          </div>
        </div>
        <button className="period-btn" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? '계산 중…' : '↻ 다시 계산'}
        </button>
      </div>

      <div className="sm-proxy-warn">
        <strong>⚠️ 프록시 지표입니다</strong> — 실제 보유지분(13F·5%룰 공시)이 아니라 가격·거래량에서
        추정한 <strong>정황 증거</strong>입니다. 기관이 아닌 대형 개인·알고리즘 매매도 같은 흔적을 남기므로
        단독 근거로 쓰지 마십시오. 실제 지분 데이터는 SEC EDGAR 13F·DART 대량보유공시가 원본이며 현재
        연동되어 있지 않습니다(하단 설명 참조).
      </div>

      {isLoading && <div className="panel-sub">시세 불러오는 중…</div>}
      {isError && <div className="panel-sub">데이터를 불러오지 못했습니다. 다시 계산을 눌러 주세요.</div>}

      {!isLoading && usable.length > 0 && (
        <div className="sm-tops">
          <div className="sm-top sm-top-in">
            <span className="sm-top-lbl">자금 유입 상위</span>
            {usable.slice(0, 3).map((r) => (
              <span key={r.symbol} className="sm-top-item">
                {r.name} <strong>{r.score!.toFixed(0)}</strong>
              </span>
            ))}
          </div>
          <div className="sm-top sm-top-out">
            <span className="sm-top-lbl">자금 유출 상위</span>
            {usable
              .slice(-3)
              .reverse()
              .map((r) => (
                <span key={r.symbol} className="sm-top-item">
                  {r.name} <strong>{r.score!.toFixed(0)}</strong>
                </span>
              ))}
          </div>
        </div>
      )}

      {GROUPS.map((g) => {
        const gr = ranked.filter((r) => r.group === g)
        if (!gr.length) return null
        return (
          <div key={g} className="sm-group">
            <h3 className="sm-group-title">{g}</h3>
            <div className="sm-table-wrap">
              <table className="sm-table">
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>큰손 판정</th>
                    <th className="sm-score-th">점수</th>
                    {partKeys
                      .filter((p) => p.key !== 'turnZ')
                      .map((p) => (
                        <th key={p.key}>{p.label}</th>
                      ))}
                    <th>거래대금 z</th>
                  </tr>
                </thead>
                <tbody>
                  {gr.map((r) => {
                    const tz = r.parts.find((p) => p.key === 'turnZ')
                    return (
                      <tr
                        key={r.symbol}
                        className={`sm-row ${open === r.symbol ? 'open' : ''}`}
                        onClick={() => setOpen(open === r.symbol ? null : r.symbol)}
                      >
                        <td>
                          <div className="sm-name">
                            <strong>{r.name}</strong>
                            <code>{r.symbol}</code>
                          </div>
                        </td>
                        <td>
                          <span className={`sm-badge ${scoreClass(r.score)}`}>{r.label}</span>
                        </td>
                        <td className={`sm-score ${scoreClass(r.score)}`}>
                          {r.score == null ? '—' : r.score.toFixed(0)}
                        </td>
                        {r.parts
                          .filter((p) => p.key !== 'turnZ')
                          .map((p) => (
                            <td key={p.key}>
                              <Bar part={p} />
                            </td>
                          ))}
                        <td className="sm-tz">{tz?.display ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <details className="sm-doc">
        <summary>📖 이 점수는 어떻게 나왔나 · 무엇을 믿고 무엇을 믿으면 안 되나</summary>
        <div className="sm-doc-body">
          <h4>왜 가격·거래량으로 큰손을 추정할 수 있나</h4>
          <p>
            큰 자금은 한 번에 살 수 없습니다. 하루 거래량의 몇 배를 담아야 하니 며칠~몇 주에 걸쳐 나눠
            사고, 그 과정에서 <strong>거래량이 실린 날의 종가가 고가 쪽에 붙는</strong> 패턴이 남습니다.
            반대로 큰 물량을 정리할 때는 저가 쪽에 붙습니다. 와이코프의 <em>effort vs result</em>,
            그랜빌의 OBV, 채이킨의 자금흐름이 공통으로 보는 지점입니다.
          </p>

          <h4>네 개 지표</h4>
          <ul>
            <li>
              <strong>자금흐름 CMF(20일)</strong> — 각 봉의 종가가 고저 레인지의 어디에 붙었는지를
              거래량으로 가중해 합산. +1이면 20일 내내 고가 마감, −1이면 저가 마감.
            </li>
            <li>
              <strong>OBV 추세(60일)</strong> — 상승일 거래량은 더하고 하락일은 빼는 누적선의 기울기를
              평균 거래량으로 나눠 종목 규모와 무관하게 비교. 가격은 횡보인데 이게 오르면 조용한 매집 신호.
            </li>
            <li>
              <strong>대량거래일 마감위치</strong> — 최근 60일 중 <strong>거래대금 상위 20% 날만</strong>{' '}
              골라 종가 위치 평균. 평범한 날은 노이즈라 버립니다. 큰돈이 급했던 방향을 봅니다.
            </li>
            <li>
              <strong>상대강도(60일 초과수익)</strong> — 벤치마크(국내 KODEX 200 / 미국 SPY) 대비 초과
              수익. 기관 자금은 이기는 쪽으로 흐른다는 관찰(오닐 RS).
            </li>
          </ul>
          <p>
            <strong>거래대금 z</strong>는 방향이 아니라 <em>세기</em>라서 점수 방향에 넣지 않습니다. 대신
            신뢰도를 0.8~1.2배로 조정합니다 — 돈이 몰린 상태의 매집 신호가, 거래 없는 매집 신호보다
            무겁기 때문입니다.
          </p>

          <h4>미래참조 금지</h4>
          <p>
            모든 지표는 해당 시점까지의 봉만 사용하며, 정규화 기준은 <strong>고정 상수</strong>입니다.
            전체 기간의 평균·표준편차로 정규화하면 그 자체가 미래 정보가 되기 때문입니다(프로젝트 규칙
            1-5). <code>tests/smartmoney.test.ts</code>의 절단 불변성 테스트가 이를 강제합니다 — 뒷부분을
            잘라내고 다시 계산해도 잘린 시점 이전 값이 완전히 같아야 통과합니다.
          </p>

          <h4>믿으면 안 되는 것</h4>
          <ul>
            <li>
              <strong>기관이라는 보장이 없습니다.</strong> 같은 흔적을 대형 개인·알고리즘·마켓메이커도
              남깁니다. "큰 자금"까지가 최대치이고 "기관"은 추정입니다.
            </li>
            <li>
              <strong>사후 확인이 아닙니다.</strong> 매집처럼 보였다가 그대로 하락하는 경우가 흔합니다.
              방향 예측이 아니라 현재 상태 기술로 읽으십시오.
            </li>
            <li>
              <strong>지수 리밸런싱·배당락·옵션만기</strong> 같은 기계적 이벤트가 거래량을 왜곡합니다.
            </li>
            <li>
              점수는 <strong>절대 기준이 아니라 상대 비교용</strong>입니다. +30이 "사도 된다"는 뜻이
              아니라 "같은 화면의 −20보다 자금이 우호적"이라는 뜻입니다.
            </li>
          </ul>

          <h4>실제 지분 데이터는 왜 없나</h4>
          <p>
            진짜 큰손 데이터의 원본은 <strong>SEC EDGAR 13F</strong>(미국 1억 달러 이상 기관의 분기
            보유내역)와 <strong>DART 대량보유상황보고서</strong>(5%룰)입니다. 둘 다 무료·공식이지만 현재
            이 대시보드의 CORS 프록시 허용 호스트(Yahoo·Google News·GDELT·Stooq) 밖이라 붙어 있지
            않습니다. DART 공시는 이미 수집 중이며 <strong>하이닉스 탭 → 수급 레이더</strong>에서 실제
            공시 타임라인으로 확인할 수 있습니다(단, 하이닉스 단일 종목).
          </p>
        </div>
      </details>

      <div className="news-foot">
        본 화면은 참고용 계산 결과이며 투자자문·매매권유가 아닙니다. 점수가 높다고 상승을 보장하지 않으며,
        매집 구간으로 보이던 종목이 그대로 하락하는 경우가 흔합니다. 손실 가능성을 같은 무게로 고려하십시오.
        출처: Yahoo Finance 일봉(비공식 엔드포인트·정확성 미보증) · 분할+배당 보정 · 환율 미반영.
      </div>
    </section>
  )
}

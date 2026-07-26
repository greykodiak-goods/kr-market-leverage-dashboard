// 자금 로테이션 — 돈이 위험자산으로 오나, 방어자산으로 가나.
//
// 큰손 개별 종목보다 먼저 봐야 할 것은 "판이 위험을 사는 국면인가"다.
// 위험자산 바스켓과 방어자산 바스켓의 같은 기간 수익률 차이로 단순하게 읽는다.
// 실제 자금유입액(AUM flow)이 아니라 가격 반응으로 본 프록시다.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { InfoTip } from '../../components/InfoTip'
import { getDailyHistory } from '../../lib/history'
import { periodReturn, rotationGauge, type RotationLeg } from './smartMoney'

const RISK_ON: { symbol: string; label: string }[] = [
  { symbol: 'SMH', label: '미 반도체' },
  { symbol: 'QQQ', label: '나스닥100' },
  { symbol: 'XLK', label: '미 기술' },
  { symbol: '069500.KS', label: 'KODEX 200' },
]

const RISK_OFF: { symbol: string; label: string }[] = [
  { symbol: 'TLT', label: '미 장기국채' },
  { symbol: 'GLD', label: '금' },
  { symbol: 'XLV', label: '미 헬스케어' },
  { symbol: 'XLP', label: '미 필수소비' },
]

const PERIODS = [
  { days: 20, label: '1개월' },
  { days: 60, label: '3개월' },
  { days: 120, label: '6개월' },
] as const

type Loaded = Record<string, { ret: Record<number, number | null>; asOf: string } | null>

async function loadRotation(): Promise<Loaded> {
  const syms = [...RISK_ON, ...RISK_OFF].map((x) => x.symbol)
  const out: Loaded = {}
  await Promise.all(
    syms.map(async (s) => {
      try {
        const h = await getDailyHistory(s, '5y')
        const ret: Record<number, number | null> = {}
        for (const p of PERIODS) ret[p.days] = periodReturn(h.bars, p.days)
        out[s] = { ret, asOf: h.bars.length ? h.bars[h.bars.length - 1].date : '—' }
      } catch {
        out[s] = null
      }
    }),
  )
  return out
}

function legs(defs: { symbol: string; label: string }[], loaded: Loaded, days: number): RotationLeg[] {
  return defs.map((d) => ({ symbol: d.symbol, label: d.label, ret: loaded[d.symbol]?.ret[days] ?? null }))
}

function retClass(v: number | null): string {
  if (v == null) return 'sm-na'
  if (v >= 5) return 'sm-strong-up'
  if (v > 0) return 'sm-up'
  if (v <= -5) return 'sm-strong-down'
  if (v < 0) return 'sm-down'
  return 'sm-flat'
}

export function FlowRotation() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['flow-rotation'],
    queryFn: loadRotation,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  })
  const [days, setDays] = useState<number>(60)
  const loaded = data ?? {}

  const gauge = useMemo(
    () => rotationGauge(legs(RISK_ON, loaded, days), legs(RISK_OFF, loaded, days), days),
    [loaded, days],
  )

  const asOf = useMemo(() => {
    const ds = Object.values(loaded)
      .map((v) => v?.asOf)
      .filter((d): d is string => !!d && d !== '—')
    return ds.length ? ds.sort()[ds.length - 1] : null
  }, [loaded])

  // 게이지 바늘 위치: 스프레드 ±20%p를 0~100%로 사상
  const needle = gauge.spreadPct == null ? 50 : Math.max(0, Math.min(100, 50 + (gauge.spreadPct / 20) * 50))

  return (
    <section className="panel sm-panel">
      <div className="panel-head" style={{ alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2>
            자금 로테이션 · 위험선호 게이지{' '}
            <InfoTip
              label="게이지 설명"
              text="위험자산 바스켓(반도체·나스닥·기술·코스피)과 방어자산 바스켓(장기국채·금·헬스케어·필수소비)의 같은 기간 수익률 차이입니다. 실제 자금유입액이 아니라 가격 반응으로 읽은 프록시이며, 차이가 ±3%p 안이면 중립으로 봅니다."
            />
          </h2>
          <div className="panel-sub">위험자산 vs 방어자산 상대 수익률 · 기준 {asOf ?? '—'}</div>
        </div>
        <div className="period-selector">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              className={`period-btn${days === p.days ? ' active' : ''}`}
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <div className="panel-sub">시세 불러오는 중…</div>}
      {isError && <div className="panel-sub">데이터를 불러오지 못했습니다.</div>}

      <div className="sm-gauge">
        <div className="sm-gauge-scale">
          <span>위험회피</span>
          <span>중립</span>
          <span>위험선호</span>
        </div>
        <div className="sm-gauge-track">
          <span className="sm-gauge-mid" />
          <span className="sm-gauge-needle" style={{ left: `${needle}%` }} />
        </div>
        <div className="sm-gauge-read">
          <strong
            className={
              gauge.stance === '위험선호' ? 'sm-strong-up' : gauge.stance === '위험회피' ? 'sm-strong-down' : 'sm-flat'
            }
          >
            {gauge.stance}
          </strong>
          {gauge.spreadPct != null && (
            <span className="panel-sub">
              {' '}
              — 위험자산이 방어자산 대비 {gauge.spreadPct >= 0 ? '+' : ''}
              {gauge.spreadPct.toFixed(1)}%p ({PERIODS.find((p) => p.days === days)?.label} 기준)
            </span>
          )}
        </div>
      </div>

      <div className="sm-rot-cols">
        <div className="sm-rot-col">
          <h3 className="sm-group-title">위험자산</h3>
          <table className="sm-table">
            <tbody>
              {legs(RISK_ON, loaded, days).map((l) => (
                <tr key={l.symbol}>
                  <td>
                    <div className="sm-name">
                      <strong>{l.label}</strong>
                      <code>{l.symbol}</code>
                    </div>
                  </td>
                  <td className={`sm-score ${retClass(l.ret)}`}>
                    {l.ret == null ? '—' : `${l.ret >= 0 ? '+' : ''}${l.ret.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="sm-rot-col">
          <h3 className="sm-group-title">방어자산</h3>
          <table className="sm-table">
            <tbody>
              {legs(RISK_OFF, loaded, days).map((l) => (
                <tr key={l.symbol}>
                  <td>
                    <div className="sm-name">
                      <strong>{l.label}</strong>
                      <code>{l.symbol}</code>
                    </div>
                  </td>
                  <td className={`sm-score ${retClass(l.ret)}`}>
                    {l.ret == null ? '—' : `${l.ret >= 0 ? '+' : ''}${l.ret.toFixed(1)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <details className="sm-doc">
        <summary>📖 이 게이지를 어떻게 읽나 · 한계</summary>
        <div className="sm-doc-body">
          <h4>무엇을 보는가</h4>
          <p>
            개별 종목의 매집 흔적보다 먼저 확인할 것은 <strong>판 전체가 위험을 사는 국면인가</strong>입니다.
            같은 매집 신호라도 위험선호 국면에서 나온 것과 위험회피 국면에서 나온 것은 무게가 다릅니다.
            위험회피 구간에서는 개별 종목이 아무리 좋아 보여도 시장 전체와 같이 밀리는 일이 흔합니다.
          </p>
          <h4>계산</h4>
          <p>
            위험자산 4종의 기간 수익률 평균에서 방어자산 4종 평균을 뺍니다. 차이가 <strong>+3%p 이상이면
            위험선호</strong>, <strong>−3%p 이하면 위험회피</strong>, 사이는 중립입니다. 바늘은 ±20%p를
            양 끝으로 사상합니다.
          </p>
          <h4>한계</h4>
          <ul>
            <li>
              <strong>실제 자금유입액이 아닙니다.</strong> ETF의 순설정·환매 데이터가 원본이며, 여기서는
              가격 반응으로 대신 읽습니다. 가격이 올랐다고 반드시 돈이 들어온 것은 아닙니다.
            </li>
            <li>
              <strong>후행합니다.</strong> 국면 전환은 게이지가 움직인 뒤에 확인되므로, 전환 초입에서는
              방향을 반대로 가리킵니다.
            </li>
            <li>
              <strong>금리 국면에 좌우됩니다.</strong> 금리 급등기에는 장기국채(TLT)가 방어 역할을 못 해
              두 바스켓이 동시에 빠지고, 게이지가 중립으로 읽히지만 실제로는 전면 위험회피입니다.
            </li>
            <li>
              <strong>환율 미반영.</strong> 국내·해외 자산을 원화 환산 없이 각자 통화 기준으로 비교합니다.
            </li>
          </ul>
        </div>
      </details>

      <div className="news-foot">
        참고용 계산 결과이며 투자자문·매매권유가 아닙니다. 위험선호 판정이 상승을 보장하지 않으며,
        국면은 예고 없이 뒤집힙니다. 출처: Yahoo Finance 일봉(비공식·정확성 미보증) · 분할+배당 보정.
      </div>
    </section>
  )
}

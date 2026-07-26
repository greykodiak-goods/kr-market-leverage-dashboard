// 퀀트 모델 상태 패널 — 레짐·리스크·팩터 기여도를 숫자로 드러낸다.
// "왜 이 종목을 이 비중으로 담았나"가 한 화면에서 읽혀야 한다.

import { FACTOR_LABELS } from './factors'
import type { PortfolioResult } from './portfolio'
import type { ModelConfig } from './models'
import { symbolLabel } from './UniverseEditor'

interface Props {
  cfg: ModelConfig
  result: PortfolioResult
}

export function QuantPanel({ cfg, result }: Props) {
  const snap = result.quantSnapshot
  if (!snap) return null
  const factors = cfg.quant?.factor.factors ?? []

  return (
    <div className="bt-live bt-quant">
      <div className="bt-live-head">
        <strong>🧬 퀀트 상태 — 레짐 · 리스크 · 팩터 기여도</strong>
        <span className="bt-chart-caption">최신 리밸런싱 시점 {snap.date} 기준</span>
      </div>

      <div className="bt-quant-status">
        <div className={`bt-quant-chip ${snap.regimeOk ? 'ok' : 'off'}`}>
          <span className="lbl">3층 · 레짐</span>
          <strong>{snap.regimeOk ? '정상 (투자)' : '위험 (축소)'}</strong>
          <span className="det">{snap.regimeDetail}</span>
        </div>
        <div className="bt-quant-chip">
          <span className="lbl">4층 · 총 노출</span>
          <strong>{snap.exposurePct.toFixed(0)}%</strong>
          <span className="det">나머지 {(100 - snap.exposurePct).toFixed(0)}%는 현금</span>
        </div>
        <div className="bt-quant-chip">
          <span className="lbl">예상 변동성</span>
          <strong>{snap.portfolioVolPct != null ? `${snap.portfolioVolPct.toFixed(1)}%` : '—'}</strong>
          <span className="det">연환산 · 상관 0 가정 근사</span>
        </div>
      </div>
      <div className="bt-chart-caption" style={{ marginBottom: 10 }}>
        <strong>배분 방식</strong> — {snap.riskNote}
      </div>

      <div className="bt-table-wrap">
        <table>
          <thead>
            <tr>
              <th>종목</th>
              <th>합성점수</th>
              <th>순위</th>
              {factors.map((f) => (
                <th key={f.kind}>
                  {FACTOR_LABELS[f.kind].name}
                  <span className="bt-fw">×{f.weight}</span>
                </th>
              ))}
              <th>판정</th>
            </tr>
          </thead>
          <tbody>
            {snap.rows.map((r) => (
              <tr key={r.symbol} className={r.passed && r.rank != null && r.rank <= (cfg.quant?.factor.topN ?? 4) ? 'bt-base-row' : undefined}>
                <td>{symbolLabel(r.symbol)}</td>
                <td className={(r.score ?? 0) >= 0 ? 'bt-pos' : 'bt-neg'}>
                  <strong>{r.score != null ? r.score.toFixed(2) : '—'}</strong>
                </td>
                <td>{r.rank ?? '—'}</td>
                {r.breakdown.map((b) => (
                  <td key={b.kind} className={(b.weighted ?? 0) >= 0 ? 'bt-pos' : 'bt-neg'}>
                    {b.weighted != null ? b.weighted.toFixed(2) : '—'}
                    <span className="bt-fw">{b.z != null ? ` (z${b.z.toFixed(1)})` : ''}</span>
                  </td>
                ))}
                <td style={{ textAlign: 'left' }}>
                  {r.passed
                    ? r.rank != null && r.rank <= (cfg.quant?.factor.topN ?? 4)
                      ? snap.exposurePct <= 0
                        ? '선정(레짐 위험 → 실제 미보유)'
                        : snap.exposurePct < 100
                          ? `선정(노출 ${snap.exposurePct.toFixed(0)}%로 축소 반영)`
                          : '편입'
                      : '대기'
                    : r.reasons.join(' / ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bt-chart-caption">
        <strong>합성점수</strong> = 팩터별 z-score × 가중치의 합. <strong>z-score</strong>는 "그 시점 후보군 안에서 몇
        표준편차만큼 우수한가"이며, 단위가 다른 팩터(수익률 %, 변동성 %, 거래량 배수)를 같은 척도로 맞추기 위한
        변환입니다. 평균·표준편차는 <strong>그 시점 후보군 안에서만</strong> 계산합니다 — 전체 기간 통계를 쓰면 그
        자체가 미래 정보이기 때문입니다. 이상치가 결과를 지배하지 않도록 z는 ±3으로 자릅니다.
      </div>
    </div>
  )
}

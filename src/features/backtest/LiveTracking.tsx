// 모의운용(페이퍼) 추적 패널 — 등록 → 스펙 동결 → 사후검증 성적 누적.
// 실주문·실계좌와 연결되지 않는다.

import { buildOosReport } from './oos'
import { buildSpec, fingerprint, todayISO, type Enrollment } from './spec'
import { computeSignals } from './signals'
import type { ModelConfig } from './models'
import type { PortfolioResult } from './portfolio'
import type { HistoryResult } from '../../lib/history'
import { symbolLabel } from './UniverseEditor'

function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
}

interface Props {
  modelId: string
  cfg: ModelConfig
  result: PortfolioResult | null
  histories: Record<string, HistoryResult>
  enrollment: Enrollment | null
  onEnroll: (e: Enrollment) => void
  onUnenroll: () => void
}

export function LiveTracking({ modelId, cfg, result, histories, enrollment, onEnroll, onUnenroll }: Props) {
  const spec = buildSpec(modelId, cfg)
  const fp = fingerprint(spec)
  const drifted = enrollment != null && enrollment.fingerprint !== fp
  const report = enrollment && result ? buildOosReport(result.equity, enrollment.enrolledAt) : null
  const signals = result ? computeSignals(modelId, cfg, result, histories) : []

  function enroll() {
    onEnroll({
      modelId,
      fingerprint: fp,
      spec,
      enrolledAt: todayISO(),
      note: '',
    })
  }

  function exportSpec() {
    const blob = new Blob([JSON.stringify({ ...spec, fingerprint: fp }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `model-spec-${modelId}-${fp}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="bt-live">
      <div className="bt-live-head">
        <strong>🧪 모의운용 추적 (페이퍼 · 실주문 없음)</strong>
        <span className="bt-fp" title="모델 스펙 지문 — 설정이 하나라도 바뀌면 값이 달라집니다">
          지문 <code>{fp}</code>
        </span>
        <button type="button" className="bt-btn-mini" onClick={exportSpec}>
          ⬇ 스펙 JSON 내보내기
        </button>
        {enrollment == null ? (
          <button type="button" className="bt-btn-mini primary" onClick={enroll}>
            ▶ 이 스펙으로 모의운용 등록
          </button>
        ) : (
          <button type="button" className="bt-btn-mini danger" onClick={onUnenroll}>
            등록 해제
          </button>
        )}
      </div>

      {enrollment == null ? (
        <div className="bt-live-empty">
          등록하면 <strong>지금 이 설정이 그대로 동결</strong>되고, 등록일 이후 구간이 사후검증(out-of-sample)
          성적으로 따로 집계됩니다. 등록 전 성적은 "모델을 보고 맞춘" 구간이라 좋게 나오는 게 당연하고, 등록 후
          성적이 실제 기대치에 가깝습니다. 등록 후 설정을 바꾸면 지문이 달라져 성적을 이어붙일 수 없습니다(사후
          조정으로 성적을 예쁘게 만드는 것을 막기 위함).
        </div>
      ) : (
        <>
          <div className="bt-live-meta">
            등록일 <strong>{enrollment.enrolledAt}</strong> · 등록 시 지문 <code>{enrollment.fingerprint}</code>
            {drifted && (
              <span className="bt-warn"> ⚠️ 현재 설정이 등록 시점과 다릅니다 — 아래 성적은 <u>지금 설정</u> 기준
                재계산이며 등록 모델의 실적이 아닙니다. 원 설정으로 되돌리거나 새로 등록하세요.</span>
            )}
          </div>

          {report && (
            <>
              <div className={`bt-verdict ${report.verdictLevel}`}>
                <strong>
                  {report.verdictLevel === 'good'
                    ? '✅ 유지'
                    : report.verdictLevel === 'bad'
                      ? '⛔ 과최적화 의심'
                      : report.verdictLevel === 'watch'
                        ? '⚠️ 관찰'
                        : '⏳ 판단 유보'}
                </strong>{' '}
                {report.verdict}
              </div>
              <div className="bt-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>구간</th>
                      <th>기간</th>
                      <th>거래일</th>
                      <th>수익률</th>
                      <th>벤치마크</th>
                      <th>초과</th>
                      <th>CAGR</th>
                      <th>알파(연)</th>
                      <th>MDD</th>
                      <th>샤프</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.inSample && (
                      <tr>
                        <td>등록 전 (백테스트)</td>
                        <td>
                          {report.inSample.from} ~ {report.inSample.to}
                        </td>
                        <td>{report.inSample.days.toLocaleString()}</td>
                        <td className={report.inSample.totalReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                          {fmtPct(report.inSample.totalReturnPct)}
                        </td>
                        <td>{fmtPct(report.inSample.benchmarkReturnPct)}</td>
                        <td className={report.inSample.excessPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                          {fmtPct(report.inSample.excessPct)}
                        </td>
                        <td>{fmtPct(report.inSample.cagrPct)}</td>
                        <td className={report.inSample.alphaPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                          {fmtPct(report.inSample.alphaPct)}
                        </td>
                        <td>{fmtPct(report.inSample.mddPct)}</td>
                        <td>{report.inSample.sharpe.toFixed(2)}</td>
                      </tr>
                    )}
                    {report.outSample ? (
                      <tr className="bt-oos-row">
                        <td>
                          <strong>등록 후 (사후검증)</strong>
                        </td>
                        <td>
                          {report.outSample.from} ~ {report.outSample.to}
                        </td>
                        <td>{report.outSample.days.toLocaleString()}</td>
                        <td className={report.outSample.totalReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                          {fmtPct(report.outSample.totalReturnPct)}
                        </td>
                        <td>{fmtPct(report.outSample.benchmarkReturnPct)}</td>
                        <td className={report.outSample.excessPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                          {fmtPct(report.outSample.excessPct)}
                        </td>
                        <td>{fmtPct(report.outSample.cagrPct)}</td>
                        <td className={report.outSample.alphaPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                          <strong>{fmtPct(report.outSample.alphaPct)}</strong>
                        </td>
                        <td>{fmtPct(report.outSample.mddPct)}</td>
                        <td>{report.outSample.sharpe.toFixed(2)}</td>
                      </tr>
                    ) : (
                      <tr>
                        <td colSpan={10}>등록 후 데이터가 아직 없습니다 (다음 거래일부터 집계).</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="bt-chart-caption">
                <strong>알파(연)</strong> = 연환산 수익률 − 벤치마크 연환산 수익률. 장세가 좋아서 번 것인지 규칙이
                실제로 우위가 있는지를 가르는 값이며, 이 플랫폼의 과최적화 판정 기준입니다.{' '}
                등록 후 성적은 저장된 기록이 아니라 <strong>등록일과 동결된 규칙으로 매번 재계산</strong>한 값입니다 —
                같은 스펙·같은 등록일이면 언제 열어도 같은 숫자가 나옵니다(조작·유실 불가). 실계좌 성과가 아니라 모의
                계산이며, 실제 체결 슬리피지·유동성·세금은 다를 수 있습니다.
              </div>
            </>
          )}
        </>
      )}

      {/* 오늘의 판정 */}
      {signals.length > 0 && (
        <div className="bt-signals">
          <div className="bt-live-head">
            <strong>📍 최신 봉 기준 판정과 근거</strong>
            <span className="bt-chart-caption">
              백테스트와 동일한 규칙·함수로 계산 — 화면의 판정이 곧 시뮬레이션의 판정입니다.
            </span>
          </div>
          {signals.map((s) => (
            <div key={s.symbol} className="bt-signal">
              <div className="bt-signal-head">
                <strong>
                  {symbolLabel(s.symbol)} <code>{s.symbol}</code>
                </strong>
                <span className={`bt-signal-badge ${s.decision.includes('매수') ? 'buy' : s.decision.includes('매도') ? 'sell' : 'hold'}`}>
                  {s.decision}
                </span>
                <span className="bt-chart-caption">
                  기준일 {s.asOf} · {s.position}
                </span>
              </div>
              <ul className="bt-signal-reasons">
                {s.reasons.map((r, i) => (
                  <li key={i} className={r.met ? 'met' : ''}>
                    <span className="mark">{r.met ? '✓' : '·'}</span> <strong>{r.text}</strong> — {r.detail}
                  </li>
                ))}
              </ul>
              <div className="bt-signal-summary">{s.summary}</div>
            </div>
          ))}
          <div className="bt-chart-caption">
            ⚠️ 이 판정은 모의 시뮬레이션 결과이며 매수·매도 권유가 아닙니다. 실제 주문은 대표 본인이 독립적으로
            판단·집행해야 합니다. 데이터는 15~20분 지연될 수 있고, 장중에는 종가가 확정되지 않아 판정이 바뀔 수
            있습니다.
          </div>
        </div>
      )}

      {/* 스펙 전문 */}
      <details className="bt-doc">
        <summary>🧾 모델 스펙 전문 (복제·검증용) — 지문 {fp}</summary>
        <div className="bt-doc-body">
          <div className="bt-doc-sec">
            <h4>실행 규칙</h4>
            <ul>
              <li>신호 판정: {spec.execution.signal}</li>
              <li>체결: {spec.execution.fill}</li>
              <li>미래정보: {spec.execution.lookahead}</li>
            </ul>
          </div>
          {spec.rules.buy && (
            <div className="bt-doc-sec">
              <h4>매수 조건 (모두 충족 · AND)</h4>
              <ul>{spec.rules.buy.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
          {spec.rules.sell && (
            <div className="bt-doc-sec">
              <h4>매도 조건 (하나라도 충족 · OR)</h4>
              <ul>{spec.rules.sell.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
          {spec.rules.params && (
            <div className="bt-doc-sec">
              <h4>알고리즘 파라미터</h4>
              <ul>
                {Object.entries(spec.rules.params).map(([k, v]) => (
                  <li key={k}>
                    {k}: {v == null ? '없음' : v}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="bt-doc-sec">
            <h4>유니버스 · 자금 · 비용</h4>
            <ul>
              <li>유니버스: {spec.universe.join(', ')} (자본 균등분할)</li>
              <li>초기자본 {spec.costs.initialCapital.toLocaleString()} · 진입비중 {spec.costs.positionPct}%</li>
              <li>
                수수료 {spec.costs.commissionPct}% · 거래세 {spec.costs.sellTaxPct}% · 슬리피지{' '}
                {spec.costs.slippagePct}%
              </li>
              <li>
                손절 {spec.costs.stopLossPct ?? '없음'} · 익절 {spec.costs.takeProfitPct ?? '없음'}
              </li>
              <li>데이터 범위 {spec.dataRange} · 시뮬 시작 {spec.simStartDate}</li>
            </ul>
          </div>
        </div>
      </details>
    </div>
  )
}

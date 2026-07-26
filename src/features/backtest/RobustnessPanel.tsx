// 강건성 검사 패널 — 파라미터·비용·시작시점을 흔들어 "고원인가 첨탑인가"를 본다.

import { useState } from 'react'
import type { HistoryResult } from '../../lib/history'
import type { ModelConfig } from './models'
import type { PortfolioResult } from './portfolio'
import { buildStartVariants, buildVariants, runRobustness, type RobustnessReport } from './robustness'

function fmt(v: number, d = 1): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
}

interface Props {
  modelId: string
  cfg: ModelConfig
  result: PortfolioResult | null
  histories: Record<string, HistoryResult>
}

export function RobustnessPanel({ modelId, cfg, result, histories }: Props) {
  const [report, setReport] = useState<RobustnessReport | null>(null)
  const [busy, setBusy] = useState(false)

  function run() {
    setBusy(true)
    // 동기 계산이 길어 UI가 멈추므로 한 프레임 뒤로 미룬다.
    setTimeout(() => {
      try {
        const variants = [
          ...buildVariants(modelId, cfg),
          ...buildStartVariants(cfg, (result?.equity ?? []).map((e) => e.date)),
        ]
        setReport(runRobustness(modelId, variants, histories))
      } finally {
        setBusy(false)
      }
    }, 20)
  }

  const label =
    report?.verdictLevel === 'good'
      ? '✅ 고원(plateau) — 강건함'
      : report?.verdictLevel === 'bad'
        ? '⛔ 첨탑(peak) — 과최적화 의심'
        : report?.verdictLevel === 'watch'
          ? '⚠️ 편차 큼'
          : '⏳ 판단 유보'

  return (
    <div className="bt-live bt-robust">
      <div className="bt-live-head">
        <strong>🧪 강건성 검사 (파라미터·비용·시작시점 흔들기)</strong>
        <button type="button" className="bt-btn-mini primary" onClick={run} disabled={busy || !result}>
          {busy ? '⏳ 변형 실행 중…' : '▶ 강건성 검사 실행'}
        </button>
      </div>

      {!report && (
        <div className="bt-live-empty">
          같은 규칙을 <strong>파라미터를 조금씩 바꿔가며</strong> 여러 번 돌립니다. 진짜 우위가 있는 규칙은 숫자를
          바꿔도 성과가 완만하게 변하고(고원), 데이터에 우연히 맞춘 규칙은 특정 숫자에서만 좋고 옆으로 한 칸만
          옮기면 무너집니다(첨탑). <strong>거래비용을 2~3배</strong>로 올려도 우위가 남는지, <strong>시작 시점</strong>을
          옮겨도 유지되는지도 함께 봅니다. 이 검사는 "결과론적으로 좋았던 것"을 걸러내는 용도입니다.
        </div>
      )}

      {report && (
        <>
          <div className={`bt-verdict ${report.verdictLevel}`}>
            <strong>{label}</strong> {report.verdict}
          </div>
          <div className="bt-robust-summary">
            기준 알파 <strong>{report.baseAlphaPct != null ? fmt(report.baseAlphaPct) : '—'}</strong> · 변형 중앙값{' '}
            <strong className={report.medianAlphaPct >= 0 ? 'bt-pos' : 'bt-neg'}>{fmt(report.medianAlphaPct)}</strong> ·
            최악 <strong className="bt-neg">{fmt(report.worstAlphaPct)}</strong> · 양의 알파 비율{' '}
            <strong>{Math.round(report.positiveRatio * 100)}%</strong> · 비용 2~3배에도 우위{' '}
            <strong className={report.costSurvives ? 'bt-pos' : 'bt-neg'}>{report.costSurvives ? '유지' : '소멸'}</strong>
          </div>
          <div className="bt-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>변형</th>
                  <th>축</th>
                  <th>수익률</th>
                  <th>벤치마크</th>
                  <th>알파(연)</th>
                  <th>MDD</th>
                  <th>샤프</th>
                  <th>매매</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r, i) => (
                  <tr key={i} className={r.axis === '기준' ? 'bt-base-row' : undefined}>
                    <td>{r.axis === '기준' ? <strong>{r.label}</strong> : r.label}</td>
                    <td>{r.axis}</td>
                    {r.error ? (
                      <td colSpan={6} className="bt-neg">
                        실행 실패: {r.error}
                      </td>
                    ) : (
                      <>
                        <td className={r.totalReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>{fmt(r.totalReturnPct)}</td>
                        <td>{fmt(r.benchReturnPct)}</td>
                        <td className={r.alphaPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                          <strong>{fmt(r.alphaPct)}</strong>
                        </td>
                        <td>{fmt(r.mddPct)}</td>
                        <td>{r.sharpe.toFixed(2)}</td>
                        <td>{r.trades}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bt-chart-caption">
            판정은 <strong>알파(연환산 초과수익)</strong> 기준입니다. 파라미터를 한 번에 하나씩만 바꿉니다(OAT) — 여러
            개를 동시에 격자 탐색하면 그 자체가 과최적화 유혹이 되기 때문입니다. 이 검사를 통과해도{' '}
            <strong>같은 데이터 위의 검사</strong>라는 한계는 남습니다. 최종 관문은 규칙을 동결한 뒤의 사후검증(모의운용)입니다.
          </div>
        </>
      )}
    </div>
  )
}

// 전략 보드 — 카드 1장 = 전략 1개. 클릭하면 그 전략 전용 화면으로 들어간다.
//
// 2026-08-06 통합(대표 지시): 모델이 아닌 입력(조건식 직접 작성·사전계산 프리셋)도
// `leadingCards`로 **같은 그리드 안에** 놓는다. 그리드를 쪼개면 "왜 나눠져 있냐"가
// 그대로 남으므로 슬롯 하나로 앞에 끼워 넣는다.

import type { ReactNode } from 'react'
import { MODEL_META, type BoardSummary, type ModelConfig } from './models'
import { symbolLabel } from './UniverseEditor'
import type { Enrollment } from './spec'

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

interface Props {
  configs: Record<string, ModelConfig>
  board: Record<string, BoardSummary>
  enrollments: Record<string, Enrollment>
  busy: boolean
  progress: string | null
  onOpen: (id: string) => void
  onRunAll: () => void
  /** 모델 카드 앞에 같은 그리드로 끼워 넣을 카드들(조건식·사전계산 등). */
  leadingCards?: ReactNode
}

export function ModelBoard({ configs, board, enrollments, busy, progress, onOpen, onRunAll, leadingCards }: Props) {
  return (
    <div>
      <div className="bt-actions" style={{ marginTop: 0 }}>
        <button type="button" className="bt-btn-run" onClick={onRunAll} disabled={busy}>
          {busy ? `⏳ ${progress ?? '실행 중…'}` : '▶ 전체 모델 일괄 평가 (각자 유니버스·세팅)'}
        </button>
        <span className="bt-chart-caption">
          카드 1장 = 전략 1개(모델 = 가상 투자자 1명). 누르면 해당 전략 전용 화면이 열립니다. 위 버튼은 모델
          카드만 다시 평가합니다.
        </span>
      </div>

      <div className="bt-board">
        {leadingCards}
        {MODEL_META.map((meta) => {
          const s = board[meta.id]
          const cfg = configs[meta.id]
          const enr = enrollments[meta.id]
          const beat = s != null && s.totalReturnPct > s.benchmarkReturnPct
          return (
            <button key={meta.id} type="button" className="bt-card" onClick={() => onOpen(meta.id)}>
              <div className="bt-card-head">
                <span className={`bt-card-type ${meta.type}`}>
                  {meta.type === 'rule'
                    ? '규칙형'
                    : meta.type === 'algo'
                      ? '자금관리'
                      : meta.type === 'quant'
                        ? '퀀트'
                        : '종목선정'}
                </span>
                <strong>{meta.short}</strong>
                <span className="bt-card-stage">
                  {enr ? `🧪 모의운용 ${enr.enrolledAt}~` : '백테스트 단계'}
                  {/* 승격 관문을 통과한 적 없는 모델은 목록에서부터 구분한다 —
                      "검증 통과 프리셋"으로 오인되지 않게(규칙 3·4). */}
                  {meta.unvalidated && ' · 🔬 기법 재현 · 검증 전'}
                </span>
              </div>
              <div className="bt-card-universe">
                {cfg.symbols.slice(0, 4).map((sym) => (
                  <code key={sym}>{symbolLabel(sym)}</code>
                ))}
                {cfg.symbols.length > 4 && <code>+{cfg.symbols.length - 4}</code>}
              </div>
              {s ? (
                <>
                  <div className="bt-card-1y">
                    <span className="lbl">최근 1년</span>
                    {s.return1yPct === undefined ? (
                      <span className="vs bt-restale">재평가 필요 — 위 "전체 모델 일괄 평가"를 다시 누르세요</span>
                    ) : s.return1yPct != null ? (
                      <>
                        <strong className={s.return1yPct >= 0 ? 'bt-pos' : 'bt-neg'}>{fmtPct(s.return1yPct)}</strong>
                        <span className="vs">
                          벤치 {fmtPct(s.bench1yPct)}
                          {s.bench1yPct != null && (
                            <b className={s.return1yPct - s.bench1yPct >= 0 ? 'bt-pos' : 'bt-neg'}>
                              {' '}({s.return1yPct - s.bench1yPct >= 0 ? '+' : ''}
                              {(s.return1yPct - s.bench1yPct).toFixed(1)}%p)
                            </b>
                          )}
                        </span>
                        {s.oneYearPartial && <span className="vs">· 구간 1년 미만</span>}
                      </>
                    ) : (
                      <span className="vs">시뮬레이션 구간이 1년 미만</span>
                    )}
                  </div>
                  <div className="bt-card-metrics">
                    <div>
                      <span className="lbl">전체 수익률</span>
                      <span className={s.totalReturnPct >= 0 ? 'bt-pos' : 'bt-neg'}>{fmtPct(s.totalReturnPct)}</span>
                    </div>
                    <div>
                      <span className="lbl">벤치대비</span>
                      <span className={beat ? 'bt-pos' : 'bt-neg'}>{beat ? '↑ 초과' : '↓ 미달'}</span>
                    </div>
                    <div>
                      <span className="lbl">CAGR</span>
                      <span>{fmtPct(s.cagrPct)}</span>
                    </div>
                    <div>
                      <span className="lbl">MDD</span>
                      <span className="bt-neg">{fmtPct(s.mddPct)}</span>
                    </div>
                    <div>
                      <span className="lbl">샤프</span>
                      <span>{Number.isFinite(s.sharpe) ? s.sharpe.toFixed(2) : '—'}</span>
                    </div>
                    <div>
                      <span className="lbl">칼마</span>
                      <span>{s.calmar != null ? s.calmar.toFixed(2) : '—'}</span>
                    </div>
                    <div>
                      <span className="lbl">변동성</span>
                      <span>{fmtPct(s.volPct, 0)}</span>
                    </div>
                    <div>
                      <span className="lbl">연도 초과</span>
                      <span>{s.yearsBeatBench}</span>
                    </div>
                  </div>
                  <div className="bt-card-foot">
                    {s.period} · 평가 {new Date(s.ranAt).toLocaleDateString('ko-KR')}
                  </div>
                </>
              ) : (
                <div className="bt-card-empty">아직 평가 전 — 카드를 열어 실행하거나 전체 일괄 평가를 누르세요</div>
              )}
            </button>
          )
        })}
      </div>

      <div className="bt-stage-info">
        <strong>운용 단계 체계</strong> — ① 백테스트(현재): 과거 데이터 워크포워드 검증 → ② 모의운용: 실시간 페이퍼
        트레이딩으로 전방 검증 → ③ 대표 검토: 지표·전략 납득 여부 판단 → ④ 실계좌: <u>대표 본인이 직접</u> 연동·집행.
        실계좌 주문·API 연동·자동매매 파이프라인은 이 플랫폼이 자동으로 수행하지 않습니다(투자 거버넌스 T0 — 시스템이
        아닌 대표 본인의 수동 절차).
      </div>
    </div>
  )
}

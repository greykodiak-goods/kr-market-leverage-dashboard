// 투자봇 시뮬레이터 플랫폼 — "모델 1개 = 가상 투자자 1명".
//
// 보드(전체 모델 트랙레코드 요약) ↔ 모델 상세(전용 조회·편집·실행) 2단 구조.
// 각 모델은 자기 유니버스(국장·미장 혼합 가능한 여러 종목)를 자기 규칙으로
// 운용하고, 기본·위험조정·일관성 지표로 평가된다.
//
// 시점 규율: 각 시점에서 그 이후(미래) 데이터는 일절 참조하지 않는다
// (워크포워드). 규칙형은 당일 종가 판단 → 익일 시가 체결, 알고리즘형은 원저
// 방식대로 당일 종가 LOC 체결. 수수료·거래세·슬리피지 반영.
//
// 실계좌 주문·브로커 API 연동·자동매매 파이프라인은 이 코드베이스에서
// 만들지 않는다(투자 거버넌스 T0 — 대표 본인만 수동으로 진행).

import { useState } from 'react'
import { getDailyHistory, type HistoryResult } from '../../lib/history'
import { runPortfolio, type PortfolioResult } from './portfolio'
import { ALL_MODEL_IDS, defaultConfig, loadBoard, loadConfigs, modelMeta, saveBoard, saveConfigs, type BoardSummary, type ModelConfig } from './models'
import { ModelBoard } from './ModelBoard'
import { ModelDetail } from './ModelDetail'
import { InfoTip } from '../../components/InfoTip'

function summarize(res: PortfolioResult): BoardSummary {
  return {
    ranAt: Date.now(),
    universe: res.universe,
    period: `${res.startDate} ~ ${res.endDate}`,
    totalReturnPct: res.metrics.totalReturnPct,
    benchmarkReturnPct: res.metrics.benchmarkReturnPct,
    cagrPct: res.metrics.cagrPct,
    mddPct: res.metrics.mddPct,
    sharpe: res.metrics.sharpe,
    sortino: res.advanced.sortino,
    calmar: res.advanced.calmar,
    volPct: res.advanced.volPct,
    yearsBeatBench: res.advanced.yearsBeatBench,
  }
}

export function BacktestSection() {
  const [configs, setConfigs] = useState<Record<string, ModelConfig>>(loadConfigs)
  const [board, setBoard] = useState<Record<string, BoardSummary>>(loadBoard)
  const [openId, setOpenId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, PortfolioResult>>({})
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)

  function patch(id: string, p: Partial<ModelConfig>) {
    setConfigs((prev) => {
      const next = { ...prev, [id]: { ...prev[id], ...p } }
      saveConfigs(next)
      return next
    })
  }

  function resetModel(id: string) {
    setConfigs((prev) => {
      const next = { ...prev, [id]: defaultConfig(id) }
      saveConfigs(next)
      return next
    })
  }

  function acceptResult(id: string, res: PortfolioResult) {
    setResults((prev) => ({ ...prev, [id]: res }))
    setBoard((prev) => {
      const next = { ...prev, [id]: summarize(res) }
      saveBoard(next)
      return next
    })
  }

  async function runAll() {
    setBusy(true)
    try {
      const histCache: Record<string, HistoryResult> = {}
      const nextBoard = { ...board }
      const nextResults = { ...results }
      for (const id of ALL_MODEL_IDS) {
        const cfg = configs[id]
        setProgress(`${modelMeta(id).short} 평가 중…`)
        const histories: Record<string, HistoryResult> = {}
        for (const sym of cfg.symbols) {
          const key = `${sym}:${cfg.range}`
          try {
            histories[sym] = histCache[key] ?? (histCache[key] = await getDailyHistory(sym, cfg.range))
          } catch {
            /* 로드 실패 종목은 제외하고 나머지로 실행 */
          }
        }
        try {
          const res = runPortfolio(id, cfg, histories)
          nextResults[id] = res
          nextBoard[id] = summarize(res)
        } catch {
          /* 유니버스 전체 실패 시 해당 모델은 이전 요약 유지 */
        }
      }
      setResults(nextResults)
      setBoard(nextBoard)
      saveBoard(nextBoard)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <div className="panel bt-panel">
      <div className="panel-head">
        <h2>
          🤖 투자 모델 시뮬레이터 플랫폼
          <InfoTip text="모델 1개 = 가상 투자자 1명. 각 모델이 자기 유니버스(국장·미장 혼합 가능)를 자기 규칙으로 운용한 트랙레코드를 기본·위험조정·일관성 지표로 평가합니다. 각 시점에서 미래 데이터는 일절 참조하지 않습니다(워크포워드). 모의 시뮬레이션 전용이며 실주문·실계좌와 연결되지 않습니다." />
        </h2>
        <span className="badge sample">모의 시뮬레이션 · 실주문 없음</span>
      </div>
      <div className="panel-sub">
        모델 = 가상 투자자 1명. 여러 종목(국장·미장)을 자기 규칙으로 굴린 성적을 수익률뿐 아니라 위험조정·일관성
        지표로 평가합니다. 과거 성과는 미래 수익을 보장하지 않습니다.
      </div>

      {openId == null ? (
        <ModelBoard
          configs={configs}
          board={board}
          busy={busy}
          progress={progress}
          onOpen={setOpenId}
          onRunAll={runAll}
        />
      ) : (
        <ModelDetail
          modelId={openId}
          cfg={configs[openId]}
          result={results[openId] ?? null}
          onPatch={(p) => patch(openId, p)}
          onReset={() => resetModel(openId)}
          onBack={() => setOpenId(null)}
          onResult={(res) => acceptResult(openId, res)}
        />
      )}

      <div className="bt-disclaimer">
        본 플랫폼은 모의(백테스트) 전용이며 실주문·실계좌·브로커 API와 연결되어 있지 않습니다. 실계좌 운용은 대표
        본인이 별도로 판단·집행해야 하며, 이 시스템은 주문을 대신 내지 않습니다. 라오어 무한매수법·VR은 공개된
        방법론의 근사 구현으로 원저·실제 운용 버전과 다를 수 있습니다. 백테스트는 생존편향·과최적화·체결 가정의
        한계를 가지며, 좋은 과거 성적이 미래 수익을 보장하지 않습니다. 본 내용은 정보·참고용이며 투자자문이
        아닙니다. 작성자는 투자자문 라이선스가 없습니다. 매수/매도 권유가 아니며, 모든 투자 판단과 실행·손익 책임은
        대표 본인에게 있습니다. 시장은 불확실하며 손실이 발생할 수 있습니다. 데이터 출처: Yahoo Finance
        일봉(수정주가 기준이 아닐 수 있어 배당·감자 등은 미반영).
      </div>
    </div>
  )
}

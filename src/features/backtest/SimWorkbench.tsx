// 전략 시뮬레이터 — 시뮬레이터 탭의 **유일한** 화면.
//
// 2026-08-06 대표 지시로 통합했다("비슷한기능인데 왜 나눠져잇냐").
// 이전에는 sim 탭에 최상위 패널이 3개 쌓여 있었다 — 조건식 시뮬레이터,
// 모델 플랫폼, QQQ 배수 프리셋. 셋 다 하는 일은 "전략 하나를 과거에 굴려
// 성적을 본다"로 같고, 다른 건 **전략을 어디서 가져오느냐**뿐이었다
// (사람이 쓴다 / 코드에서 고른다 / 이미 구워진 걸 읽는다).
// 그래서 입력 3종을 카드로 세우고 화면 구조는 하나로 합쳤다.
// 기획: ops/context/investing/시뮬탭-통합기획_2026-08-06.md
//
//   #sim            → 전략 보드(카드 그리드 하나)
//   #sim/spec       → 조건식 직접 작성 (SpecSimulator)
//   #sim/us-lev     → 미장 배수 프리셋 (UsLeveragePanel · 사전계산 읽기 전용)
//   #sim/<modelId>  → 모델 상세 (ModelDetail) — **기존 URL 그대로**
//
// 모델 1개 = 가상 투자자 1명. 각 모델은 자기 유니버스(국장·미장 혼합 가능한
// 여러 종목)를 자기 규칙으로 운용하고, 기본·위험조정·일관성 지표로 평가된다.
//
// 시점 규율: 각 시점에서 그 이후(미래) 데이터는 일절 참조하지 않는다
// (워크포워드). 규칙형은 당일 종가 판단 → 익일 시가 체결, 알고리즘형은 원저
// 방식대로 당일 종가 LOC 체결. 수수료·거래세·슬리피지 반영.
//
// 실계좌 주문·브로커 API 연동·자동매매 파이프라인은 이 코드베이스에서
// 만들지 않는다(투자 거버넌스 T0 — 대표 본인만 수동으로 진행).

import { useCallback, useEffect, useRef, useState } from 'react'
import { getDailyHistory, type HistoryResult } from '../../lib/history'
import { runPortfolio, type PortfolioResult } from './portfolio'
import { ALL_MODEL_IDS, defaultConfig, loadBoard, loadConfigs, modelMeta, saveBoard, saveConfigs, type BoardSummary, type ModelConfig } from './models'
import { ModelBoard } from './ModelBoard'
import { ModelDetail } from './ModelDetail'
import { SpecSimulator } from './SpecSimulator'
import { UsLeveragePanel } from './UsLeveragePanel'
import { US_LEVERAGE_PRESETS } from './usLeveragePresets'
import { loadEnrollments, saveEnrollments, type Enrollment } from './spec'
import { InfoTip } from '../../components/InfoTip'

function summarize(res: PortfolioResult): BoardSummary {
  return {
    ranAt: Date.now(),
    universe: res.universe,
    period: `${res.startDate} ~ ${res.endDate}`,
    totalReturnPct: res.metrics.totalReturnPct,
    benchmarkReturnPct: res.metrics.benchmarkReturnPct,
    return1yPct: res.advanced.return1yPct,
    bench1yPct: res.advanced.bench1yPct,
    oneYearPartial: res.advanced.oneYearPartial,
    cagrPct: res.metrics.cagrPct,
    mddPct: res.metrics.mddPct,
    sharpe: res.metrics.sharpe,
    sortino: res.advanced.sortino,
    calmar: res.advanced.calmar,
    volPct: res.advanced.volPct,
    yearsBeatBench: res.advanced.yearsBeatBench,
  }
}

// ── 도구 라우트 ─────────────────────────────────────────────────────────────
// 모델이 아닌 카드(직접 작성·사전계산)도 같은 해시 공간을 쓴다. 모델 id와 절대
// 겹치면 안 되므로 아래 SIM_ROUTE_CONFLICTS 검사와 테스트가 그것을 강제한다.
export const SIM_SPEC_ROUTE = 'spec'
export const SIM_US_LEV_ROUTE = 'us-lev'
export const SIM_TOOL_ROUTES: readonly string[] = [SIM_SPEC_ROUTE, SIM_US_LEV_ROUTE]

/** 도구 라우트가 모델 id를 가려버리는 충돌 — 있으면 안 된다(tests/simworkbench.test.ts). */
export function simRouteConflicts(): string[] {
  return SIM_TOOL_ROUTES.filter((r) => ALL_MODEL_IDS.includes(r))
}

/** 해시 하위 경로가 이 탭이 아는 화면인지. 모르는 값이면 보드로 떨어진다. */
export function isKnownSimRoute(sub: string): boolean {
  return SIM_TOOL_ROUTES.includes(sub) || ALL_MODEL_IDS.includes(sub)
}

// 열린 화면을 URL 해시의 하위 경로(#sim/<id>)로 표현한다.
// 브라우저 뒤로가기가 보드로 돌아가고, 특정 화면을 링크로 공유할 수 있다.
export function readOpenIdFromHash(hash?: string): string | null {
  const raw = (hash ?? (typeof location !== 'undefined' ? location.hash : '')).replace(/^#/, '')
  const [tab, sub] = raw.split('/')
  if (tab !== 'sim' || !sub) return null
  return isKnownSimRoute(sub) ? sub : null
}

export function SimWorkbench() {
  const [configs, setConfigs] = useState<Record<string, ModelConfig>>(loadConfigs)
  const [board, setBoard] = useState<Record<string, BoardSummary>>(loadBoard)
  const [openId, setOpenId] = useState<string | null>(() => readOpenIdFromHash())
  // 앱 안에서 열어 히스토리 항목을 쌓았는지 — 뒤로가기 버튼 동작을 가른다.
  const pushedRef = useRef(false)

  // 브라우저 뒤로/앞으로 → 해시 변경 → 화면 동기화
  useEffect(() => {
    const onHash = () => {
      const next = readOpenIdFromHash()
      setOpenId(next)
      if (next == null) pushedRef.current = false
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 화면 열기(모델·도구 공통) — 히스토리 항목을 쌓아 뒤로가기가 보드로 돌아가게 한다.
  const openModel = useCallback((id: string) => {
    pushedRef.current = true
    location.hash = `sim/${id}`
  }, [])

  // 다른 기법으로 전환 — 항목을 쌓지 않고 교체(뒤로가기 시 보드로).
  const switchModel = useCallback((id: string) => {
    history.replaceState(null, '', `#sim/${id}`)
    setOpenId(id)
  }, [])

  // 보드로 — 앱에서 열었으면 실제 뒤로가기, 직접 URL로 들어왔으면 해시 교체.
  const backToBoard = useCallback(() => {
    if (pushedRef.current) {
      history.back()
    } else {
      history.replaceState(null, '', '#sim')
      setOpenId(null)
    }
  }, [])
  const [results, setResults] = useState<Record<string, PortfolioResult>>({})
  const [histories, setHistories] = useState<Record<string, Record<string, HistoryResult>>>({})
  const [enrollments, setEnrollments] = useState<Record<string, Enrollment>>(loadEnrollments)
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

  function acceptResult(id: string, res: PortfolioResult, hists: Record<string, HistoryResult>) {
    setResults((prev) => ({ ...prev, [id]: res }))
    setHistories((prev) => ({ ...prev, [id]: hists }))
    setBoard((prev) => {
      const next = { ...prev, [id]: summarize(res) }
      saveBoard(next)
      return next
    })
  }

  function enroll(id: string, e: Enrollment) {
    setEnrollments((prev) => {
      const next = { ...prev, [id]: e }
      saveEnrollments(next)
      return next
    })
  }

  function unenroll(id: string) {
    setEnrollments((prev) => {
      const next = { ...prev }
      delete next[id]
      saveEnrollments(next)
      return next
    })
  }

  async function runAll() {
    setBusy(true)
    try {
      const histCache: Record<string, HistoryResult> = {}
      const nextBoard = { ...board }
      const nextResults = { ...results }
      const nextHistories = { ...histories }
      for (const id of ALL_MODEL_IDS) {
        const cfg = configs[id]
        setProgress(`${modelMeta(id).short} 평가 중…`)
        const loaded: Record<string, HistoryResult> = {}
        for (const sym of cfg.symbols) {
          const key = `${sym}:${cfg.range}`
          try {
            loaded[sym] = histCache[key] ?? (histCache[key] = await getDailyHistory(sym, cfg.range))
          } catch {
            /* 로드 실패 종목은 제외하고 나머지로 실행 */
          }
        }
        try {
          const res = runPortfolio(id, cfg, loaded)
          nextResults[id] = res
          nextHistories[id] = loaded
          nextBoard[id] = summarize(res)
        } catch {
          /* 유니버스 전체 실패 시 해당 모델은 이전 요약 유지 */
        }
      }
      setResults(nextResults)
      setHistories(nextHistories)
      setBoard(nextBoard)
      saveBoard(nextBoard)
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  // ── 도구 화면 ────────────────────────────────────────────────────────────
  // 조건식·프리셋 화면은 자기 패널(.panel)을 들고 있으므로 여기서 또 감싸지 않는다.
  // 되돌아갈 길(← 전략 보드)만 위에 얹는다 — 내부 로직은 한 줄도 건드리지 않았다.
  if (openId === SIM_SPEC_ROUTE || openId === SIM_US_LEV_ROUTE) {
    return (
      <div>
        <div className="bt-detail-head" style={{ marginBottom: 8 }}>
          <button type="button" className="bt-btn-mini" onClick={backToBoard}>
            ← 전략 보드
          </button>
          <h3>{openId === SIM_SPEC_ROUTE ? '⚡ 조건식 직접 작성' : '📊 미장 배수 프리셋'}</h3>
        </div>
        {openId === SIM_SPEC_ROUTE ? <SpecSimulator /> : <UsLeveragePanel />}
      </div>
    )
  }

  return (
    <div className="panel bt-panel">
      <div className="panel-head">
        <h2>
          🤖 전략 시뮬레이터
          <InfoTip text="전략 하나를 과거 데이터에 굴려 성적을 보는 화면입니다. 전략을 가져오는 방법이 셋뿐이라 카드로 나눠 놓았을 뿐, 평가 방식은 같습니다 — 조건식을 직접 쓰거나, 코드에 있는 모델을 고르거나, 미리 구워진 프리셋을 읽습니다. 각 시점에서 미래 데이터는 일절 참조하지 않습니다(워크포워드). 모의 시뮬레이션 전용이며 실주문·실계좌와 연결되지 않습니다." />
        </h2>
        <span className="badge sample">모의 시뮬레이션 · 실주문 없음</span>
      </div>
      <div className="panel-sub">
        카드 1장 = 전략 1개. 눌러서 열고, 성적은 수익률뿐 아니라 위험조정·일관성 지표로 봅니다. 과거 성과는 미래
        수익을 보장하지 않습니다.
      </div>

      {openId == null ? (
        <ModelBoard
          configs={configs}
          board={board}
          enrollments={enrollments}
          busy={busy}
          progress={progress}
          onOpen={openModel}
          onRunAll={runAll}
          leadingCards={
            <>
              {/* 모델이 아닌 두 입력도 같은 그리드 안에 둔다 — 첫 화면은 카드 하나뿐이어야 한다. */}
              <button type="button" className="bt-card" onClick={() => openModel(SIM_SPEC_ROUTE)}>
                <div className="bt-card-head">
                  <span className="bt-card-type">직접작성</span>
                  <strong>⚡ 조건식 시뮬레이터</strong>
                  <span className="bt-card-stage">국장 · KRX 실측 유니버스</span>
                </div>
                <div className="bt-card-universe">
                  <code>영웅문 조건식</code>
                  <code>2차검증</code>
                </div>
                <div className="bt-card-1y">
                  <span className="lbl">쓰는 법</span>
                  <span className="vs">조건을 적으면 그 자리에서 백테스트됩니다.</span>
                </div>
              </button>

              <button type="button" className="bt-card" onClick={() => openModel(SIM_US_LEV_ROUTE)}>
                <div className="bt-card-head">
                  <span className="bt-card-type">사전계산</span>
                  <strong>📊 미장 배수 프리셋</strong>
                  {/* 43차 관문 통과 0 — 보드에서부터 탈락 사실을 말한다(규칙 3·4). */}
                  <span className="bt-card-stage">❌ 관문 미통과 · 기록용</span>
                </div>
                <div className="bt-card-universe">
                  <code>QQQ</code>
                  <code>QLD</code>
                  <code>TQQQ</code>
                </div>
                <div className="bt-card-1y">
                  <span className="lbl">담긴 것</span>
                  <span className="vs">
                    낙폭 밴드 {US_LEVERAGE_PRESETS.length}종 — 브라우저에서 다시 못 돌립니다(시세 키 비노출).
                  </span>
                </div>
              </button>
            </>
          }
        />
      ) : (
        <ModelDetail
          modelId={openId}
          cfg={configs[openId]}
          result={results[openId] ?? null}
          histories={histories[openId] ?? {}}
          enrollment={enrollments[openId] ?? null}
          onPatch={(p) => patch(openId, p)}
          onReset={() => resetModel(openId)}
          onBack={backToBoard}
          onSwitch={switchModel}
          onResult={(res, hists) => acceptResult(openId, res, hists)}
          onEnroll={(e) => enroll(openId, e)}
          onUnenroll={() => unenroll(openId)}
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

// 퀀트 모델 파라미터 편집기 — 6층 구조를 층별로 조정한다.

import { FACTOR_LABELS, type FactorKind, type FactorSpec } from './factors'
import type { QuantParams } from './quantEngine'
import { InfoTip } from '../../components/InfoTip'

const ALL_FACTORS: FactorKind[] = [
  'momentum',
  'trendQuality',
  'lowVol',
  'shortReversal',
  'distanceFromHigh',
  'volumeSurge',
]

function num(v: string, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

interface Props {
  quant: QuantParams
  onChange: (next: QuantParams) => void
}

export function QuantEditor({ quant, onChange }: Props) {
  const { factor, regime, risk } = quant

  const setFactor = (i: number, patch: Partial<FactorSpec>) =>
    onChange({ ...quant, factor: { ...factor, factors: factor.factors.map((f, j) => (j === i ? { ...f, ...patch } : f)) } })

  const addFactor = (kind: FactorKind) =>
    onChange({ ...quant, factor: { ...factor, factors: [...factor.factors, { kind, weight: 0.5, lookback: 126 }] } })

  const removeFactor = (i: number) =>
    onChange({ ...quant, factor: { ...factor, factors: factor.factors.filter((_, j) => j !== i) } })

  const unused = ALL_FACTORS.filter((k) => !factor.factors.some((f) => f.kind === k))

  return (
    <div className="bt-quant-editor">
      {/* 2층 — 알파 신호 */}
      <div className="bt-layer">
        <div className="bt-layer-head">
          <span className="bt-layer-no">2층</span>
          <strong>알파 신호 — 다중 팩터 합성</strong>
          <InfoTip text="팩터 하나에 전부 걸면 그 팩터가 죽는 해에 계좌도 같이 죽습니다. 서로 다른 이유로 작동하는 팩터를 z-score로 표준화해 가중 합성하면, 하나가 부진해도 나머지가 버팁니다. 수익을 키우는 장치가 아니라 기복을 줄이는 장치입니다." />
        </div>
        {factor.factors.map((f, i) => (
          <div key={`${f.kind}-${i}`} className="bt-factor-row">
            <span className="bt-factor-name">{FACTOR_LABELS[f.kind].name}</span>
            <label>
              가중치
              <input
                type="number"
                step={0.1}
                min={-3}
                max={3}
                value={f.weight}
                onChange={(e) => setFactor(i, { weight: num(e.target.value, 1) })}
              />
            </label>
            <label>
              기간
              <input
                type="number"
                min={5}
                max={504}
                value={f.lookback}
                onChange={(e) => setFactor(i, { lookback: num(e.target.value, 126) })}
              />
            </label>
            <button type="button" className="bt-btn-mini danger" onClick={() => removeFactor(i)}>
              ✕
            </button>
            <span className="bt-factor-desc">{FACTOR_LABELS[f.kind].desc}</span>
          </div>
        ))}
        {unused.length > 0 && (
          <div className="bt-factor-add">
            <span>팩터 추가:</span>
            {unused.map((k) => (
              <button key={k} type="button" className="bt-btn-mini" onClick={() => addFactor(k)}>
                + {FACTOR_LABELS[k].name}
              </button>
            ))}
          </div>
        )}
        <div className="bt-controls bt-algo-params">
          <label>
            보유 종목 수
            <input
              type="number"
              min={1}
              max={20}
              value={factor.topN}
              onChange={(e) => onChange({ ...quant, factor: { ...factor, topN: num(e.target.value, 4) } })}
            />
          </label>
          <label>
            리밸런싱 주기(거래일)
            <input
              type="number"
              min={5}
              max={252}
              value={factor.rebalanceDays}
              onChange={(e) => onChange({ ...quant, factor: { ...factor, rebalanceDays: num(e.target.value, 21) } })}
            />
          </label>
          <label>
            합성점수 하한
            <InfoTip text="이 점수 미만이면 아예 후보에서 제외합니다. 0이면 제한 없음(상위 N개를 무조건 채움). 양수로 두면 '평균 이상인 종목이 없으면 안 산다'는 뜻이라 현금 비중이 늘어납니다." />
            <input
              type="number"
              step={0.1}
              value={factor.minScore}
              onChange={(e) => onChange({ ...quant, factor: { ...factor, minScore: num(e.target.value, 0) } })}
            />
          </label>
          <label className="bt-check">
            <input
              type="checkbox"
              checked={factor.trendFilter}
              onChange={(e) => onChange({ ...quant, factor: { ...factor, trendFilter: e.target.checked } })}
            />
            개별 종목 추세 필터
          </label>
          <label>
            추세 이평
            <input
              type="number"
              min={20}
              max={300}
              value={factor.trendSma}
              onChange={(e) => onChange({ ...quant, factor: { ...factor, trendSma: num(e.target.value, 200) } })}
            />
          </label>
        </div>
      </div>

      {/* 3층 — 레짐 */}
      <div className="bt-layer">
        <div className="bt-layer-head">
          <span className="bt-layer-no">3층</span>
          <strong>레짐 필터 — 시장 상태</strong>
          <InfoTip text="시장 전체가 무너질 때는 어떤 종목을 골라도 같이 빠집니다. 기준 자산이 장기 이평선 아래로 내려가면 투자 비중 자체를 낮춰 방어합니다. 대신 급반등 초입에서는 복귀가 늦습니다." />
        </div>
        <div className="bt-controls bt-algo-params">
          <label>
            기준
            <select
              value={regime.mode}
              onChange={(e) => onChange({ ...quant, regime: { ...regime, mode: e.target.value as typeof regime.mode } })}
            >
              <option value="poolAverage">후보 풀 평균지수</option>
              <option value="symbol">특정 종목/지수</option>
              <option value="off">사용 안 함</option>
            </select>
          </label>
          {regime.mode === 'symbol' && (
            <label>
              기준 심볼
              <input
                type="text"
                value={regime.symbol}
                onChange={(e) => onChange({ ...quant, regime: { ...regime, symbol: e.target.value.toUpperCase() } })}
              />
            </label>
          )}
          <label>
            판정 이평(일)
            <input
              type="number"
              min={20}
              max={300}
              value={regime.sma}
              onChange={(e) => onChange({ ...quant, regime: { ...regime, sma: num(e.target.value, 200) } })}
            />
          </label>
          <label>
            위험 국면 노출 %
            <InfoTip text="레짐이 위험일 때 유지할 총 투자 비중입니다. 0이면 전액 현금, 20이면 20%만 남기고 현금화합니다." />
            <input
              type="number"
              min={0}
              max={100}
              value={regime.riskOffExposurePct}
              onChange={(e) => onChange({ ...quant, regime: { ...regime, riskOffExposurePct: num(e.target.value, 0) } })}
            />
          </label>
        </div>
      </div>

      {/* 4층 — 리스크 */}
      <div className="bt-layer">
        <div className="bt-layer-head">
          <span className="bt-layer-no">4층</span>
          <strong>리스크 — 비중 배분 · 변동성 타게팅</strong>
          <InfoTip text="계좌를 흔드는 건 금액 비중이 아니라 위험 기여도입니다. 변동성이 큰 종목을 적게 담아 각 종목의 위험 기여를 비슷하게 맞추고(역변동성 가중), 포트폴리오 전체 변동성을 목표치에 맞춰 노출을 조절합니다." />
        </div>
        <div className="bt-controls bt-algo-params">
          <label>
            배분 방식
            <select
              value={risk.sizing}
              onChange={(e) => onChange({ ...quant, risk: { ...risk, sizing: e.target.value as typeof risk.sizing } })}
            >
              <option value="inverseVol">역변동성 가중(리스크 패리티 근사)</option>
              <option value="equal">균등 배분</option>
            </select>
          </label>
          <label>
            변동성 추정 기간
            <input
              type="number"
              min={20}
              max={252}
              value={risk.volLookback}
              onChange={(e) => onChange({ ...quant, risk: { ...risk, volLookback: num(e.target.value, 60) } })}
            />
          </label>
          <label className="bt-check">
            <input
              type="checkbox"
              checked={risk.volTarget}
              onChange={(e) => onChange({ ...quant, risk: { ...risk, volTarget: e.target.checked } })}
            />
            변동성 타게팅
          </label>
          <label>
            목표 변동성 %
            <input
              type="number"
              min={3}
              max={60}
              value={risk.targetVolPct}
              onChange={(e) => onChange({ ...quant, risk: { ...risk, targetVolPct: num(e.target.value, 15) } })}
            />
          </label>
          <label>
            총 노출 상한 %
            <InfoTip text="레버리지를 쓰지 않으므로 100%가 상한입니다. 낮추면 항상 일정 비율을 현금으로 남깁니다." />
            <input
              type="number"
              min={10}
              max={100}
              value={risk.maxExposurePct}
              onChange={(e) => onChange({ ...quant, risk: { ...risk, maxExposurePct: num(e.target.value, 100) } })}
            />
          </label>
        </div>
      </div>

      {/* 5층 — 리밸런싱 밴드 */}
      <div className="bt-layer">
        <div className="bt-layer-head">
          <span className="bt-layer-no">5층</span>
          <strong>리밸런싱 밴드</strong>
          <InfoTip text="목표 비중과 현재 비중의 차이가 이 값을 넘을 때만 주문을 냅니다. 매일 목표에 정확히 맞추면 회전율과 비용이 폭증하기 때문입니다. 넓힐수록 매매가 줄고 목표에서 더 벗어납니다." />
        </div>
        <div className="bt-controls bt-algo-params">
          <label>
            밴드 폭 %p
            <input
              type="number"
              min={0}
              max={30}
              step={0.5}
              value={quant.rebalanceBandPct}
              onChange={(e) => onChange({ ...quant, rebalanceBandPct: num(e.target.value, 5) })}
            />
          </label>
        </div>
      </div>
    </div>
  )
}

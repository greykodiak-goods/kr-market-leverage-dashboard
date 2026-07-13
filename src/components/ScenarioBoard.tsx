import { format } from 'date-fns'
import { useOutlook } from '../hooks/useOutlook'
import { assessScenario, STATUS_LABEL } from '../lib/scenario'
import type { IndicatorResult } from '../lib/indicators'
import type { ScenarioKey } from '../lib/outlook'

function won(v: number) {
  return `₩${Math.round(v).toLocaleString('ko-KR')}`
}

const KEY_LABEL: Record<ScenarioKey, string> = { bull: '강세', base: '기준', bear: '약세' }

export function ScenarioBoard({ result }: { result: IndicatorResult | null }) {
  const { data: outlook } = useOutlook()
  if (!outlook) return null

  const assessment = result ? assessScenario(result) : null
  const computedActive = assessment?.active

  return (
    <div className="scenario-board">
      <div className="scenario-head">
        <h3>기술적 시나리오 보드 <span className="badge" style={{ fontSize: 11 }}>관찰 국면</span></h3>
        <div className="scenario-meta">
          해설 기준 {format(new Date(outlook.updatedAt), 'yyyy.MM.dd HH:mm')} · 하루 2회 갱신
        </div>
      </div>

      <div className="scenario-active-line">
        <span>
          해설(JSON) 활성:{' '}
          <strong>{KEY_LABEL[outlook.activeScenario]}</strong>
        </span>
        <span>
          실시간 지표 판정:{' '}
          <strong style={{ color: 'var(--accent)' }}>
            {computedActive ? KEY_LABEL[computedActive] : '계산 대기'}
          </strong>
        </span>
      </div>

      <div className="scenario-cards">
        {outlook.scenarios.map((s) => {
          const status = assessment?.statusByKey[s.key] ?? 'inactive'
          const isActive = computedActive === s.key
          return (
            <div key={s.key} className={`scenario-card ${s.key}${isActive ? ' active' : ''}`}>
              <div className="scenario-card-head">
                <span className="scenario-title">
                  {s.emoji} {s.label}
                </span>
                <span className={`scenario-status ${status}`}>{STATUS_LABEL[status]}</span>
              </div>

              <div className="scenario-levels">
                <span>지지 {won(s.levels.support)}</span>
                <span>저항 {won(s.levels.resistance)}</span>
              </div>

              <div className="scenario-sub">발동 조건</div>
              <ul className="scenario-triggers">
                {s.triggers.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>

              <p className="scenario-commentary">{s.commentary}</p>
            </div>
          )
        })}
      </div>

      {assessment && assessment.reasons.length > 0 && (
        <div className="scenario-reasons">
          현재 지표 근거: {assessment.reasons.join(' · ')}
        </div>
      )}

      <div className="news-foot">{outlook.disclaimer}</div>
    </div>
  )
}

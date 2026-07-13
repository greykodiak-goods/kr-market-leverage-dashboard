import { useQuote, useFxQuote } from '../../hooks/useQuote'
import { useOutlook } from '../scenario-outlook/useOutlook'
import type { ScenarioKey } from '../scenario-outlook/outlook'

const ADR_ORDINARY_RATIO = 0.1 // 1 ADR = 원주 1/10 (SEC 424B4)

const SCEN: Record<ScenarioKey, { emoji: string; label: string }> = {
  bull: { emoji: '🟢', label: '강세' },
  base: { emoji: '⚪', label: '기준' },
  bear: { emoji: '🔴', label: '약세' },
}

function pctColor(v: number | null | undefined) {
  if (v == null) return 'var(--text-faint)'
  return v > 0 ? 'var(--up)' : v < 0 ? 'var(--down)' : 'var(--text-faint)'
}
function signPct(v: number | null | undefined) {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

// Always-on KPI strip between header and tab bar. Numbers + badges only (no
// interpretation), so the headline reads at a glance from any tab. These few
// symbols poll continuously regardless of the active tab.
export function StatusStrip() {
  const hynix = useQuote('000660.KS', '1D')
  const adr = useQuote('SKHY', '1D')
  const sox = useQuote('^SOX', '1D')
  const fx = useFxQuote('1D')
  const vix = useQuote('^VIX', '1D')
  const { data: outlook } = useOutlook()

  let premiumPct: number | null = null
  if (adr.data && hynix.data && fx.data) {
    const implied = (adr.data.price * fx.data.price) / ADR_ORDINARY_RATIO
    premiumPct = (implied / hynix.data.price - 1) * 100
  }

  const scen = outlook ? SCEN[outlook.activeScenario] : null

  return (
    <div className="status-strip" aria-label="핵심 지표 요약">
      <Kpi label="하이닉스" value={hynix.data ? `₩${Math.round(hynix.data.price).toLocaleString('ko-KR')}` : '—'} sub={signPct(hynix.data?.changePct)} subColor={pctColor(hynix.data?.changePct)} />
      <Kpi label="ADR 프리미엄" value={premiumPct != null ? `${premiumPct >= 0 ? '+' : ''}${premiumPct.toFixed(1)}%` : '—'} subColor={pctColor(premiumPct)} />
      <Kpi label="SOX" value={sox.data ? sox.data.price.toLocaleString('ko-KR', { maximumFractionDigits: 0 }) : '—'} sub={signPct(sox.data?.changePct)} subColor={pctColor(sox.data?.changePct)} />
      <Kpi label="USD/KRW" value={fx.data ? `₩${Math.round(fx.data.price).toLocaleString('ko-KR')}` : '—'} sub={signPct(fx.data?.changePct)} subColor={pctColor(fx.data?.changePct)} />
      <Kpi label="VIX" value={vix.data ? vix.data.price.toFixed(1) : '—'} sub={signPct(vix.data?.changePct)} subColor={pctColor(vix.data?.changePct)} />
      <div className="status-kpi">
        <span className="status-label">시나리오(참고)</span>
        <span className="status-value">{scen ? `${scen.emoji} ${scen.label}` : '—'}</span>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div className="status-kpi">
      <span className="status-label">{label}</span>
      <span className="status-value">
        {value}
        {sub && <span className="status-sub" style={{ color: subColor }}> {sub}</span>}
      </span>
    </div>
  )
}

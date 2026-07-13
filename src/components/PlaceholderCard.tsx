import { InfoTip } from './InfoTip'

// Card for indicators that have no free real-time source yet (외국인/기관 수급,
// DRAM 현물가). Shows a clear "실데이터 연동 예정" badge instead of fake numbers.
export function PlaceholderCard({ label, note, info }: { label: string; note: string; info?: string }) {
  return (
    <div className="mini-card placeholder">
      <div className="mini-head">
        <span className="mini-label">
          {label}
          {info && <InfoTip text={info} />}
        </span>
        <span className="mini-tag pending">실데이터 연동 예정</span>
      </div>
      <div className="placeholder-body">{note}</div>
    </div>
  )
}

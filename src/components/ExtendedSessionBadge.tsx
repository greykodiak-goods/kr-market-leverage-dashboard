import type { ExtendedQuote } from '../lib/quotes'
import { US_SESSION_LABEL } from '../lib/quotes'
import { changeArrow, formatSignedPercent } from '../lib/format'

// 미국 프리장/애프터장 체결 표시 — 공용 컴포넌트.
// 등락은 항상 "정규 종가 대비"라서 라벨·툴팁으로 기준을 명시한다.
// size 'lg' = ADR 실시간 카드용, 'sm' = 미니카드(NVDA·MU·TSM·EWY)용.

interface Props {
  extended: ExtendedQuote
  currency?: string // 기본 USD
  size?: 'lg' | 'sm'
}

export function ExtendedSessionBadge({ extended, currency = 'USD', size = 'lg' }: Props) {
  const up = extended.change > 0
  const down = extended.change < 0
  const cc = up ? 'var(--up)' : down ? 'var(--down)' : 'var(--text-faint)'
  const sym = currency === 'USD' ? '$' : currency === 'KRW' ? '₩' : ''
  const digits = currency === 'KRW' ? 0 : 2
  const priceTxt = `${sym}${extended.price.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`
  // sm(미니카드)은 폭이 좁아 이모지-라벨 사이 공백을 줄인다.
  const label = size === 'sm' ? US_SESSION_LABEL[extended.session].replace(' ', '') : US_SESSION_LABEL[extended.session]

  return (
    <span
      className={`ext-session-badge ${size}`}
      title="정규장 종가 대비 확장 세션(프리·애프터) 등락 — 거래량이 적어 변동이 과장될 수 있음"
    >
      <span className="ext-session-label">{label}</span>
      <strong>{priceTxt}</strong>
      <span style={{ color: cc, fontWeight: 600 }}>
        {changeArrow(extended.change)} {formatSignedPercent(extended.changePct)}
      </span>
      {size === 'lg' && <span className="ext-session-base">정규 종가 대비</span>}
    </span>
  )
}

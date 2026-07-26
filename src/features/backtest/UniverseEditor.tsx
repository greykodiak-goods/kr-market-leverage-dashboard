// 모델 유니버스(운용 종목 목록) 편집기 — 국장·미장 혼합 가능.
// 자본은 종목 수만큼 균등 분할(슬리브)되어 각 종목이 독립 운용된다.

import { useState } from 'react'

const SUGGESTED: { symbol: string; label: string }[] = [
  { symbol: '000660.KS', label: 'SK하이닉스' },
  { symbol: '005930.KS', label: '삼성전자' },
  { symbol: '069500.KS', label: 'KODEX 200' },
  { symbol: '122630.KS', label: 'KODEX 레버리지 2배⚠' },
  { symbol: '^KS11', label: 'KOSPI' },
  { symbol: 'QQQ', label: 'QQQ' },
  { symbol: 'SPY', label: 'SPY' },
  { symbol: 'NVDA', label: '엔비디아' },
  { symbol: 'SOXL', label: 'SOXL 3배⚠' },
  { symbol: 'TQQQ', label: 'TQQQ 3배⚠' },
]

export function symbolLabel(symbol: string): string {
  return SUGGESTED.find((s) => s.symbol === symbol)?.label ?? symbol
}

interface Props {
  symbols: string[]
  onChange: (next: string[]) => void
}

export function UniverseEditor({ symbols, onChange }: Props) {
  const [custom, setCustom] = useState('')

  function toggle(sym: string) {
    if (symbols.includes(sym)) onChange(symbols.filter((s) => s !== sym))
    else onChange([...symbols, sym])
  }

  function addCustom() {
    const sym = custom.trim().toUpperCase()
    if (!sym || symbols.includes(sym)) return
    onChange([...symbols, sym])
    setCustom('')
  }

  return (
    <div className="bt-universe">
      <div className="bt-universe-head">
        운용 유니버스 ({symbols.length}종목 — 자본 균등분할·독립 운용)
      </div>
      <div className="bt-universe-chips">
        {symbols.map((sym) => (
          <span key={sym} className="bt-uchip on">
            {symbolLabel(sym)} <code>{sym}</code>
            <button type="button" aria-label={`${sym} 제거`} onClick={() => toggle(sym)}>
              ✕
            </button>
          </span>
        ))}
        {symbols.length === 0 && <span className="bt-cond-empty">종목이 없습니다 — 아래에서 추가하세요</span>}
      </div>
      <div className="bt-universe-chips">
        {SUGGESTED.filter((s) => !symbols.includes(s.symbol)).map((s) => (
          <button key={s.symbol} type="button" className="bt-uchip add" onClick={() => toggle(s.symbol)}>
            + {s.label}
          </button>
        ))}
        <span className="bt-ucustom">
          <input
            type="text"
            placeholder="야후 심볼 직접 추가 (예: 035420.KS, AAPL)"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
          />
          <button type="button" className="bt-btn-mini" onClick={addCustom}>
            추가
          </button>
        </span>
      </div>
    </div>
  )
}

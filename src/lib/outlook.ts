// Hynix technical-outlook scenario board data.
// Commentary/levels live in a STATIC asset (public/data/hynix-outlook.json) so a
// scheduled job can replace just that file on gh-pages (no rebuild) and the site
// picks it up on the next poll. The client re-derives the "active" scenario from
// live 000660 indicators and shows it alongside the JSON's activeScenario.

export type ScenarioKey = 'bull' | 'base' | 'bear'

export interface Scenario {
  key: ScenarioKey
  label: string
  emoji: string
  triggers: string[]
  levels: { support: number; resistance: number }
  commentary: string
}

export interface Outlook {
  updatedAt: string
  activeScenario: ScenarioKey
  scenarios: Scenario[]
  disclaimer: string
}

const BASE = import.meta.env.BASE_URL

// Fallback used if the asset is missing/unfetchable — never render an empty board.
export const SEED_OUTLOOK: Outlook = {
  updatedAt: '2026-07-13T09:00:00+09:00',
  activeScenario: 'base',
  disclaimer:
    '본 전망은 과거 데이터 기반 기술적 참고 정보이며 투자자문·매매권유가 아닙니다. 미래 가격·수익을 보장하지 않습니다.',
  scenarios: [
    {
      key: 'bull',
      label: '강세',
      emoji: '🟢',
      triggers: [
        '종가가 20일선 위 & 20일선 > 60일선(골든크로스)',
        'RSI(14) 50~70 구간에서 상승 탄력 유지',
        'SOX·엔비디아 강세 및 HBM 수요 모멘텀(있으면 가점)',
      ],
      levels: { support: 1850000, resistance: 2200000 },
      commentary:
        '이동평균 정배열과 RSI 중립~강세 구간이 함께 확인되면 상승 관찰 국면으로 본다. 과열(RSI 70 상회) 구간에서는 변동성 확대에 유의한다.',
    },
    {
      key: 'base',
      label: '기준',
      emoji: '⚪',
      triggers: ['종가가 20일선~60일선 사이 박스권', 'RSI(14) 40~60 중립 구간', '뚜렷한 매크로 촉매 부재'],
      levels: { support: 1750000, resistance: 2000000 },
      commentary:
        '추세가 뚜렷하지 않고 이동평균이 수렴하는 관망 국면. 지지·저항 사이 등락하며 방향성 재료를 기다리는 구간으로 해석한다.',
    },
    {
      key: 'bear',
      label: '약세',
      emoji: '🔴',
      triggers: [
        '20일선 < 60일선(데드크로스) 또는 종가 < 120일선',
        'RSI(14) 30 접근(과매도 압력)',
        '관세·수출규제·지정학 악재 또는 VIX 급등(있으면 가점)',
      ],
      levels: { support: 1500000, resistance: 1850000 },
      commentary:
        '이동평균 역배열이나 장기선 이탈이 나타나면 하락 관찰 국면으로 본다. 과매도(RSI 30 이하) 구간은 기술적 반등 관찰 지점이기도 하다.',
    },
  ],
}

export async function fetchOutlook(): Promise<Outlook> {
  // Cache-busting query so a replaced static file is picked up without a rebuild.
  const url = `${BASE}data/hynix-outlook.json?t=${Date.now()}`
  try {
    const res = await fetch(url, { cache: 'no-cache' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as Outlook
    if (!json.scenarios?.length) throw new Error('empty scenarios')
    return json
  } catch {
    return SEED_OUTLOOK
  }
}

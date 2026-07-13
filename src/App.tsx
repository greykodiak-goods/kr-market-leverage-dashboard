import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchDashboardData } from './lib/data'
import { tickDateLong } from './components/chartUtils'
import { DashboardLayout } from './features/dashboard-layout/DashboardLayout'
import { useSectionOrder } from './features/dashboard-layout/useSectionOrder'
import { DEFAULT_ORDER } from './dashboard/sections'

// Thin composition root: header controls + data-driven section layout + footer.
// All feature logic lives under src/features/*; section order is a registry.
export default function App() {
  const [editing, setEditing] = useState(false)
  const { order, setOrder, move, reset } = useSectionOrder(DEFAULT_ORDER)

  // Header/footer meta only (deduped with feature sections via shared query key).
  const { data } = useQuery({ queryKey: ['dashboard'], queryFn: fetchDashboardData })
  const meta = data?.credit.meta
  const isLive = meta?.source === 'LIVE'
  const asOfDate = data?.credit.series[data.credit.series.length - 1]?.date ?? meta?.asOf

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>국내증시 레버리지 · 투자심리 대시보드</h1>
          <div className="subtitle">시나리오 전망 · 실시간 시세 · 시장 온도 · 뉴스</div>
        </div>
        <div className="badges">
          <span className={`badge ${isLive ? 'live' : 'sample'}`}>{isLive ? '실데이터' : '샘플 데이터'}</span>
          {asOfDate && (
            <span className="badge" title={isLive ? undefined : '샘플 시계열의 최신 날짜 · 실데이터 연동 시 자동 갱신'}>
              {isLive ? '기준일' : '샘플 기준일'} {tickDateLong(asOfDate)}
            </span>
          )}
          <button className={`edit-toggle${editing ? ' on' : ''}`} onClick={() => setEditing((e) => !e)}>
            {editing ? '편집 완료' : '배치 편집'}
          </button>
          {editing && (
            <button className="edit-reset" onClick={reset}>
              기본 배치로 초기화
            </button>
          )}
        </div>
      </header>

      {editing && (
        <div className="edit-hint">드래그(⠿) 또는 ▲▼ 버튼으로 섹션 순서를 바꾸세요. 배치는 자동 저장됩니다.</div>
      )}

      <DashboardLayout editing={editing} order={order} onReorder={setOrder} onMove={move} />

      <footer className="footer">
        <div>
          데이터 출처: 금융투자협회 FreeSIS(freesis.kofia.or.kr), KRX 정보데이터시스템(data.krx.co.kr), Yahoo Finance(시세), Google 뉴스.
          {' '}
          {isLive ? '실데이터 연동됨.' : '레버리지 지표는 공개통계 구조를 반영한 샘플이며 실제 수치와 다를 수 있습니다.'}
        </div>
        {asOfDate && meta && (
          <div>{isLive ? '기준일' : '샘플 기준일'} {tickDateLong(asOfDate)} · 단위 {meta.unit}(100만원의 100배)</div>
        )}
        <div>본 대시보드는 정보 제공 목적이며 투자 자문이 아닙니다.</div>
      </footer>
    </div>
  )
}

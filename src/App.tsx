import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchDashboardData } from './lib/data'
import { tickDateLong } from './components/chartUtils'
import { DashboardLayout } from './features/dashboard-layout/DashboardLayout'
import { useTabLayout } from './features/dashboard-layout/useTabLayout'
import { useTabHash } from './features/dashboard-layout/useTabHash'
import { TabBar } from './features/dashboard-layout/TabBar'
import { StatusStrip } from './features/status-strip/StatusStrip'
import { InfoTip } from './components/InfoTip'

// Thin composition root: header + always-on KPI strip + topic tab bar +
// per-tab draggable section layout + footer. Only the active tab's sections
// mount, so inactive-tab polling stops automatically.
export default function App() {
  const [editing, setEditing] = useState(false)
  const [tab, selectTab] = useTabHash()
  const { layout, setTabOrder, move, reset } = useTabLayout()

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
          <div className="subtitle">하이닉스 · 반도체 · 시장 · 뉴스 — 주제별 탭</div>
        </div>
        <div className="badges">
          <span className={`badge ${isLive ? 'live' : 'sample'}`}>{isLive ? '실데이터' : '샘플 데이터'}</span>
          {asOfDate && (
            <span className="badge">
              {isLive ? '기준일' : '샘플 기준일'} {tickDateLong(asOfDate)}
            </span>
          )}
          {meta && (
            <InfoTip
              label="데이터 범위 설명"
              text={
                isLive
                  ? `${meta.sourceLabel} · 기준일 ${tickDateLong(meta.asOf)}. 하이닉스 시세·ADR·환율·전망은 이와 별개로 항상 실시간 연동됩니다.`
                  : `이 배지는 레버리지·수급(신용융자·대차 등) 지표 기준입니다: ${meta.sourceLabel} · 샘플 기준일 ${tickDateLong(meta.asOf)}. 하이닉스 시세·ADR·환율·전망은 이와 별개로 실시간 연동됩니다.`
              }
            />
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

      <StatusStrip />

      <TabBar active={tab} onSelect={selectTab} />

      {editing && (
        <div className="edit-hint">
          현재 탭 안에서 드래그(⠿) 또는 ▲▼로 섹션 순서를 바꾸세요. 탭별로 자동 저장됩니다. (탭 간 이동은 미지원)
        </div>
      )}

      <div key={tab} id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
        <DashboardLayout
          key={tab}
          editing={editing}
          order={layout[tab]}
          onReorder={(next) => setTabOrder(tab, next)}
          onMove={(id, dir) => move(tab, id, dir)}
        />
      </div>

      <footer className="footer">
        <div>
          데이터 출처: 금융투자협회 FreeSIS, KRX 정보데이터시스템, Yahoo Finance(시세), Google 뉴스.
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

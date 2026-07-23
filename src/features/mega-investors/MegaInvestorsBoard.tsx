import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { InfoTip } from '../../components/InfoTip'
import {
  fetchMegaInvestors,
  formatAumKrw,
  formatAumUsd,
  INVESTOR_TYPE_LABELS,
  SEED_MEGA_INVESTORS,
  type MegaInvestor,
} from './megaInvestors'

// §6 하이닉스 연결 앵글 — 해석·권유가 아닌 "관찰 관점" 나열.
const HYNIX_ANGLES: { emoji: string; title: string; text: string }[] = [
  { emoji: '🌐', title: '외국인 수급', text: '패시브 3사·국부펀드가 하이닉스 외국인 지분의 실체 — 지수 리밸런싱 시 기계적 매매.' },
  { emoji: '🤖', title: 'AI capex 사이클', text: '소프트뱅크·사우디 PIF 등 AI 인프라 베팅 = HBM/메모리 수요 상단 신호.' },
  { emoji: '🏛', title: '국민연금', text: '국내 기관 수급의 축 — 보유·대량보유공시 관찰.' },
  { emoji: '📄', title: '지분공시', text: '노르웨이 GPFG 등 국부펀드 하이닉스 지분율 변동 = 스마트머니 시그널.' },
]

type CatFilter = 'all' | 'asset-manager' | 'sov-pension'

const columnHelper = createColumnHelper<MegaInvestor>()

// 세계 초대형 투자사 정적 레퍼런스 보드. 데이터는 public/data/mega-investors.json
// (분기~반기 수동 갱신, 대략값) — 코드↔데이터 분리. 커트라인(AUM 약 1,000조원)
// 미달 항목은 접이식 참고 소섹션으로 분리한다.
export function MegaInvestorsBoard() {
  const { data } = useQuery({
    queryKey: ['mega-investors'],
    queryFn: fetchMegaInvestors,
    staleTime: Infinity, // static reference file; refreshed on reload
  })
  const d = data ?? SEED_MEGA_INVESTORS

  const [catFilter, setCatFilter] = useState<CatFilter>('all')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'aumUsd', desc: true }])

  const mainRows = useMemo(() => {
    const main = d.investors.filter((iv) => !iv.belowCutoff)
    if (catFilter === 'asset-manager') return main.filter((iv) => iv.type === 'asset-manager')
    if (catFilter === 'sov-pension') return main.filter((iv) => iv.type === 'sovereign-wealth' || iv.type === 'pension')
    return main
  }, [d.investors, catFilter])

  const belowRows = useMemo(
    () => [...d.investors.filter((iv) => iv.belowCutoff)].sort((a, b) => b.aumUsd - a.aumUsd),
    [d.investors],
  )

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: '이름',
        cell: (info) => (
          <div className="mega-name">
            <span className="mega-name-en">{info.getValue()}</span>
            <span className="mega-name-ko">{info.row.original.nameKo}</span>
          </div>
        ),
      }),
      columnHelper.accessor('type', {
        header: '유형',
        enableSorting: false,
        cell: (info) => <span className={`mega-type mega-type-${info.getValue()}`}>{INVESTOR_TYPE_LABELS[info.getValue()]}</span>,
      }),
      columnHelper.accessor('aumUsd', {
        header: 'AUM(달러)',
        cell: (info) => <span className="mega-aum">{formatAumUsd(info.getValue())}</span>,
      }),
      columnHelper.accessor((row) => row.aumUsd, {
        id: 'aumKrw',
        header: '원화 환산',
        enableSorting: false,
        cell: (info) => formatAumKrw(info.getValue(), d.fxUsdKrw),
      }),
      columnHelper.accessor('asOf', {
        header: '기준',
        enableSorting: false,
        cell: (info) => <span className="mega-asof">{info.getValue()}</span>,
      }),
      columnHelper.display({
        id: 'relevance',
        header: '하이닉스·반도체 관련성',
        cell: (info) => (
          <div className="mega-rel">
            <div className="mega-tags">
              {info.row.original.relevanceTags.map((t) => (
                <span key={t} className="mega-tag">{t}</span>
              ))}
            </div>
            <div className="mega-rel-note">{info.row.original.relevanceNote}</div>
          </div>
        ),
      }),
    ],
    [d.fxUsdKrw],
  )

  const table = useReactTable({
    data: mainRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <section className="panel mega-panel">
      <div className="panel-head" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2>
            세계 초대형 투자사 레퍼런스{' '}
            <InfoTip
              label="레퍼런스 기준 설명"
              text={`메인 목록은 운용자산(AUM) 약 1,000조원($700B, 환율 ${d.fxUsdKrw.toLocaleString('ko-KR')}원 기준) 이상. AUM은 각 사 공시·보도 기반 대략값이며 기준연월을 함께 표기합니다. 원화 환산은 표기용 근사치입니다.`}
            />
          </h2>
          <div className="panel-sub">
            메인: AUM 약 1,000조원($700B) 이상 · 수치는 대략값(기준연월 표기) · 기준 {d.asOf}
          </div>
        </div>
        <div className="period-selector">
          <button className={`period-btn${catFilter === 'all' ? ' active' : ''}`} onClick={() => setCatFilter('all')}>
            전체
          </button>
          <button
            className={`period-btn${catFilter === 'asset-manager' ? ' active' : ''}`}
            onClick={() => setCatFilter('asset-manager')}
          >
            자산운용사
          </button>
          <button
            className={`period-btn${catFilter === 'sov-pension' ? ' active' : ''}`}
            onClick={() => setCatFilter('sov-pension')}
          >
            국부펀드·연기금
          </button>
        </div>
      </div>

      <div className="mega-angles" aria-label="하이닉스 연결 관찰 관점">
        {HYNIX_ANGLES.map((a) => (
          <div key={a.title} className="mega-angle">
            <span className="mega-angle-emoji" aria-hidden>{a.emoji}</span>
            <span>
              <strong>{a.title}</strong> — {a.text}
            </span>
          </div>
        ))}
      </div>

      <div className="mega-table-wrap">
        <table className="mega-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const canSort = h.column.getCanSort()
                  const dir = h.column.getIsSorted()
                  return (
                    <th key={h.id}>
                      {canSort ? (
                        <button
                          type="button"
                          className="mega-sort-btn"
                          onClick={h.column.getToggleSortingHandler()}
                          aria-label={`${String(h.column.columnDef.header)} 정렬`}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <span className="mega-sort-ind">{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : ''}</span>
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="mega-below">
        <summary>
          관련 큰손 참고 ({belowRows.length}) — AUM 1,000조원 미만, 하이닉스 관련성으로만 참고(메인 아님)
        </summary>
        <div className="mega-table-wrap">
          <table className="mega-table mega-table-dim">
            <thead>
              <tr>
                <th>이름</th>
                <th>유형</th>
                <th>규모(달러)</th>
                <th>원화 환산</th>
                <th>기준</th>
                <th>왜 참고하나</th>
              </tr>
            </thead>
            <tbody>
              {belowRows.map((iv) => (
                <tr key={iv.id}>
                  <td>
                    <div className="mega-name">
                      <span className="mega-name-en">{iv.name}</span>
                      <span className="mega-name-ko">{iv.nameKo}</span>
                    </div>
                  </td>
                  <td>
                    <span className={`mega-type mega-type-${iv.type}`}>{INVESTOR_TYPE_LABELS[iv.type]}</span>
                  </td>
                  <td>
                    <span className="mega-aum">{formatAumUsd(iv.aumUsd)}</span>
                  </td>
                  <td>{formatAumKrw(iv.aumUsd, d.fxUsdKrw)}</td>
                  <td>
                    <span className="mega-asof">{iv.asOf}</span>
                  </td>
                  <td>
                    <div className="mega-rel">
                      <div className="mega-tags">
                        {iv.relevanceTags.map((t) => (
                          <span key={t} className="mega-tag">{t}</span>
                        ))}
                      </div>
                      <div className="mega-rel-note">{iv.relevanceNote}</div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="news-foot">
        {d.disclaimer} 환산 환율 1달러 ≈ {d.fxUsdKrw.toLocaleString('ko-KR')}원(표기용 근사). 갱신: 수동(분기~반기), 기준 {d.asOf}.
        실제 보유지분(13F·공시) 실시간 연동은 향후 과제입니다.
      </div>
    </section>
  )
}

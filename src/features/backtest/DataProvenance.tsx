// 데이터 출처·정합성 패널 — 어떤 데이터를 어떤 보정으로 쓰는지, 한계는
// 무엇인지 화면에서 직접 확인할 수 있게 한다(검증 2026-07-26).

import type { HistoryResult } from '../../lib/history'

interface Props {
  histories: Record<string, HistoryResult>
}

export function DataProvenance({ histories }: Props) {
  const rows = Object.values(histories)
  if (rows.length === 0) return null
  const anySplitOnly = rows.some((h) => h.adjustment === 'split-only')

  return (
    <details className="bt-doc">
      <summary>🔍 데이터 출처·정합성 확인</summary>
      <div className="bt-doc-body">
        <div className="bt-table-wrap">
          <table>
            <thead>
              <tr>
                <th>종목</th>
                <th>거래소</th>
                <th>통화</th>
                <th>봉수</th>
                <th>기간</th>
                <th>보정</th>
                <th>결측</th>
                <th>경로</th>
                <th>수신</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.symbol}>
                  <td>
                    <code>{h.symbol}</code>
                  </td>
                  <td>{h.exchange || '—'}</td>
                  <td>{h.currency || '—'}</td>
                  <td>{h.bars.length.toLocaleString()}</td>
                  <td>
                    {h.bars[0]?.date} ~ {h.bars[h.bars.length - 1]?.date}
                  </td>
                  <td className={h.adjustment === 'split+dividend' ? 'bt-pos' : 'bt-neg'}>
                    {h.adjustment === 'split+dividend' ? '분할+배당' : '분할만'}
                  </td>
                  <td>{h.droppedBars}</td>
                  <td>{h.proxyUsed}</td>
                  <td>
                    {new Date(h.fetchedAt).toLocaleString('ko-KR')}
                    {h.stale && <span className="bt-warn"> (캐시)</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bt-doc-sec">
          <h4>출처</h4>
          <ul>
            <li>
              Yahoo Finance chart API v8 (<code>query1.finance.yahoo.com/v8/finance/chart/…</code>) — Yahoo 웹사이트가
              쓰는 것과 동일한 공개 엔드포인트. API 키·유료 계약 없음.
            </li>
            <li>
              브라우저에서 Yahoo로 직접 호출하면 CORS로 막히므로, 자체 Supabase Edge Function 프록시(호스트
              허용목록 적용)를 1순위로 쓰고 실패 시 공개 CORS 프록시로 폴백합니다. 위 표의 "경로"가 실제 사용된
              프록시입니다.
            </li>
          </ul>
        </div>

        <div className="bt-doc-sec">
          <h4>가격 보정 (중요)</h4>
          <ul>
            <li>
              Yahoo의 OHLC는 <strong>액면분할은 반영</strong>되지만 <strong>배당은 반영되지 않습니다</strong>(배당은
              adjclose에만 반영). 이 앱은 봉마다 <code>adjclose ÷ close</code> 계수를 구해 시가·고가·저가·종가에
              곱해, 배당 재투자를 포함한 <strong>총수익 기준</strong> 시계열로 변환합니다.
            </li>
            <li>
              위 표의 "보정" 열이 <strong>분할+배당</strong>이면 정상입니다. <strong>분할만</strong>으로 표시되면 그
              종목은 adjclose가 제공되지 않아 배당수익이 빠져 있습니다(지수 심볼 등).
              {anySplitOnly && ' ← 현재 일부 종목이 여기에 해당합니다.'}
            </li>
          </ul>
        </div>

        <div className="bt-doc-sec">
          <h4>알려진 한계 · 리스크</h4>
          <ul>
            <li>
              <strong>비공식 엔드포인트</strong> — Yahoo는 2017년 공식 API를 종료했고 이 경로는 문서화되지 않은
              내부용입니다. Yahoo 이용약관 위반 소지가 있고, 사전 통보 없이 차단·구조 변경될 수 있습니다. 상업적
              운용에는 유료 라이선스 데이터가 필요합니다.
            </li>
            <li>
              <strong>지연</strong> — 실시간이 아니라 15~20분 지연 시세입니다. 일봉 종가는 장 마감 후 확정되며,
              장중에 조회하면 미확정 종가로 판정이 계산됩니다.
            </li>
            <li>
              <strong>정확성 미보증</strong> — 무료·비공식 소스라 결측·오기·소급 정정이 있을 수 있습니다. 위 "결측"
              열은 OHLC가 비어 제외한 봉 수입니다. 중요한 판단 전에는 증권사 HTS/공식 거래소 데이터와 대조하세요.
            </li>
            <li>
              <strong>생존편향</strong> — 상장폐지·합병된 종목은 조회되지 않으므로, 살아남은 종목만으로 하는 백테스트는
              실제보다 성적이 좋게 나오는 경향이 있습니다.
            </li>
            <li>
              <strong>환율</strong> — 국장·미장 혼합 시 각 종목은 현지통화 수익률로 합산되며 원/달러 변동 손익은
              반영되지 않습니다.
            </li>
          </ul>
        </div>
      </div>
    </details>
  )
}

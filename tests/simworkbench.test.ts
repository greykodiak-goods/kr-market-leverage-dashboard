// 시뮬레이터 탭 통합 — **구조 불변식** 테스트.
//
// 2026-08-06 대표 지시로 sim 탭의 최상위 패널 3개(조건식·모델·프리셋)를 보드 하나로
// 합쳤다. 합친 것이 다시 갈라지거나, 해시 라우팅이 조용히 깨지는 것을 여기서 막는다.
// 기획: ops/context/investing/시뮬탭-통합기획_2026-08-06.md
//
// .tsx는 이 러너가 실행하지 않으므로(다른 화면 테스트와 같은 방식) **소스를 읽어**
// 검사한다. 라우팅 순수함수만 models.ts에서 실제 값을 가져와 대조한다.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, eq, section, finish } from './harness'
import { ALL_MODEL_IDS } from '../src/features/backtest/models'

const ROOT = process.env.REPO_ROOT ?? process.cwd()
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

const workbench = read('src', 'features', 'backtest', 'SimWorkbench.tsx')
const sections = read('src', 'dashboard', 'sections.tsx')
const board = read('src', 'features', 'backtest', 'ModelBoard.tsx')

// 소스에서 도구 라우트 문자열을 뽑는다 — 코드가 바뀌면 이 테스트도 같이 본다.
function routeConst(name: string): string {
  const m = new RegExp(`export const ${name} = '([^']+)'`).exec(workbench)
  if (!m) throw new Error(`${name} 상수를 SimWorkbench.tsx에서 못 찾았다`)
  return m[1]
}
const SPEC_ROUTE = routeConst('SIM_SPEC_ROUTE')
const US_LEV_ROUTE = routeConst('SIM_US_LEV_ROUTE')

// ============================================================================
section('1. sim 탭은 섹션 하나뿐이다 (통합의 본체)')
// ============================================================================

const simSections = [...sections.matchAll(/\{\s*id:\s*'([^']+)',\s*tab:\s*'sim'/g)].map((m) => m[1])
eq('sim 탭 최상위 섹션 수', simSections.length, 1)
eq('그 섹션 id', simSections[0], 'sim')
check('SimWorkbench를 쓴다', /Component:\s*SimWorkbench/.test(sections))

// 옛 섹션들이 되살아나면(=다시 갈라지면) 실패한다.
for (const gone of ['spec-sim', 'us-leverage', 'backtest']) {
  check(`옛 섹션 '${gone}'이 레지스트리에 없다`, !new RegExp(`id:\\s*'${gone}'`).test(sections), gone)
}
check('sections.tsx는 SpecSimulator를 직접 import하지 않는다', !/SpecSimulator/.test(sections))
check('sections.tsx는 UsLeveragePanel을 직접 import하지 않는다', !/UsLeveragePanel/.test(sections))

// ============================================================================
section('2. 세 입력이 모두 워크벤치 안에 살아 있다 (삭제가 아니라 통합이다)')
// ============================================================================

check('SpecSimulator를 렌더한다', /<SpecSimulator\s*\/>/.test(workbench))
check('UsLeveragePanel을 렌더한다', /<UsLeveragePanel\s*\/>/.test(workbench))
check('ModelDetail을 렌더한다', /<ModelDetail\b/.test(workbench))
check('ModelBoard를 렌더한다', /<ModelBoard\b/.test(workbench))

// ============================================================================
section('3. 해시 라우팅 — 도구 경로가 모델 id를 가리지 않는다')
// ============================================================================

check('모델 id가 비어있지 않다', ALL_MODEL_IDS.length > 0, `${ALL_MODEL_IDS.length}종`)
check(`'${SPEC_ROUTE}'는 모델 id가 아니다`, !ALL_MODEL_IDS.includes(SPEC_ROUTE))
check(`'${US_LEV_ROUTE}'는 모델 id가 아니다`, !ALL_MODEL_IDS.includes(US_LEV_ROUTE))
check('두 도구 경로가 서로 다르다', SPEC_ROUTE !== US_LEV_ROUTE)

// 라우팅 규칙을 소스가 아니라 **의미**로 다시 적어 대조한다(원본 함수는 .tsx라 import 불가).
const TOOL_ROUTES = [SPEC_ROUTE, US_LEV_ROUTE]
function expectedOpenId(hash: string): string | null {
  const [tab, sub] = hash.replace(/^#/, '').split('/')
  if (tab !== 'sim' || !sub) return null
  return TOOL_ROUTES.includes(sub) || ALL_MODEL_IDS.includes(sub) ? sub : null
}

eq('#sim → 보드', expectedOpenId('#sim'), null)
eq('#sim/ → 보드', expectedOpenId('#sim/'), null)
eq('#hynix → 보드(다른 탭)', expectedOpenId('#hynix'), null)
eq('모르는 하위경로 → 보드', expectedOpenId('#sim/nope'), null)
eq(`#sim/${SPEC_ROUTE} → 조건식`, expectedOpenId(`#sim/${SPEC_ROUTE}`), SPEC_ROUTE)
eq(`#sim/${US_LEV_ROUTE} → 프리셋`, expectedOpenId(`#sim/${US_LEV_ROUTE}`), US_LEV_ROUTE)
// 기존 공유 링크가 깨지지 않는지 — 모델 전부에 대해 확인한다.
for (const id of ALL_MODEL_IDS) eq(`#sim/${id} → 모델 상세(기존 URL 유지)`, expectedOpenId(`#sim/${id}`), id)

// 라우팅 함수가 hash를 인자로 받을 수 있어야 위 대조가 의미를 갖는다(테스트 가능성 고정).
check('readOpenIdFromHash가 export 되어 있다', /export function readOpenIdFromHash\(/.test(workbench))
check('충돌 검사 함수가 있다', /export function simRouteConflicts\(/.test(workbench))

// ============================================================================
section('4. 보드는 그리드 하나다 (카드로 갈라지되 화면은 안 갈라진다)')
// ============================================================================

eq('bt-board 그리드는 ModelBoard에 하나뿐', (board.match(/className="bt-board"/g) ?? []).length, 1)
check('리딩 카드가 그 그리드 안에 들어간다', /className="bt-board">\s*\{leadingCards\}/.test(board))
check('워크벤치가 leadingCards를 넘긴다', /leadingCards=\{/.test(workbench))
check('워크벤치에 bt-board를 따로 만들지 않는다', !/className="bt-board"/.test(workbench))

// ============================================================================
section('5. 정직성 — 통합하면서 경고를 잃지 않았다 (규칙 3·4)')
// ============================================================================

check('프리셋 카드가 관문 미통과를 먼저 말한다', /❌ 관문 미통과/.test(workbench))
check('면책 고지가 남아 있다', /투자자문이\s*\n?\s*아닙니다|투자자문이 아닙니다/.test(workbench))
check('실주문 없음 배지가 남아 있다', /실주문 없음/.test(workbench))
// 고지는 한 벌이면 된다 — 통합의 목적이 중복 제거였다.
eq('면책 블록은 한 벌', (workbench.match(/bt-disclaimer/g) ?? []).length, 1)

finish()

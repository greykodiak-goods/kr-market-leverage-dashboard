// 시크릿 로딩 규칙 검증 — ops governance/SECRETS-POLICY.md 를 코드로 강제한 부분.
//
// 이 테스트가 지키는 것:
//   §1.1 Doppler 우선  §1.4 폴백 시 출처 로그  §2 값 미출력
// 재발방지: 다음 세션이 평문 파일 경로를 기본값으로 되돌리면 여기서 깨진다.

import { check, eq, finish, section } from './harness'
// @ts-expect-error — .mjs 라이브러리(타입 선언 없음). esbuild가 번들한다.
import { SOURCE, maskerFor, missingHelp, resolveSecret, sourceLine } from '../scripts/lib/loadSecret.mjs'

// ------------------------------------------------------------ 1) 우선순위
section('1) 출처 우선순위')
{
  // doppler run 이 주입하면 DOPPLER_PROJECT 가 함께 온다 → Doppler 판정
  const d = resolveSecret({
    name: 'KRX_API_KEY',
    env: { KRX_API_KEY: 'abc123456', DOPPLER_PROJECT: 'investing-ops', DOPPLER_CONFIG: 'prd' },
  })
  eq('doppler run 주입 → doppler', d.source, SOURCE.DOPPLER)
  eq('값 그대로 반환', d.value, 'abc123456')
  check('detail에 프로젝트/config', d.detail.includes('investing-ops') && d.detail.includes('prd'))

  // DOPPLER_* 없으면 수동 env → 폴백
  const e = resolveSecret({ name: 'KRX_API_KEY', env: { KRX_API_KEY: 'abc123456' } })
  eq('수동 env → env(폴백)', e.source, SOURCE.ENV)

  // env 없고 파일만 → 파일 폴백
  const f = resolveSecret({
    name: 'KRX_API_KEY',
    env: { KRX_API_KEY_FILE: '/secrets/krx.txt' },
    fileEnv: 'KRX_API_KEY_FILE',
    readFile: (p: string) => (p === '/secrets/krx.txt' ? '  filekey123  \n' : ''),
  })
  eq('파일 폴백 동작', f.source, SOURCE.FILE)
  eq('앞뒤 공백·개행 제거', f.value, 'filekey123')

  // env가 있으면 파일보다 우선
  const both = resolveSecret({
    name: 'KRX_API_KEY',
    env: { KRX_API_KEY: 'envkey123', KRX_API_KEY_FILE: '/secrets/krx.txt', DOPPLER_PROJECT: 'investing-ops' },
    fileEnv: 'KRX_API_KEY_FILE',
    readFile: () => 'filekey123',
  })
  eq('Doppler가 파일보다 우선', both.value, 'envkey123')
  eq('출처도 doppler', both.source, SOURCE.DOPPLER)
}

// ------------------------------------------------------------ 2) 없음 처리
section('2) 시크릿 부재')
{
  const n = resolveSecret({ name: 'KRX_API_KEY', env: {} })
  eq('없으면 none', n.source, SOURCE.NONE)
  eq('값은 null', n.value, null)

  // 빈 문자열·공백만 있는 env는 없는 것으로 본다
  eq('빈 문자열 → none', resolveSecret({ name: 'K', env: { K: '' } }).source, SOURCE.NONE)
  eq('공백만 → none', resolveSecret({ name: 'K', env: { K: '   ' } }).source, SOURCE.NONE)

  // 파일 읽기 실패해도 죽지 않는다
  const err = resolveSecret({
    name: 'K',
    env: { K_FILE: '/없는/경로' },
    fileEnv: 'K_FILE',
    readFile: () => {
      throw new Error('ENOENT')
    },
  })
  eq('파일 읽기 실패 → none', err.source, SOURCE.NONE)

  // 파일이 비어 있으면 none
  eq(
    '빈 파일 → none',
    resolveSecret({ name: 'K', env: { K_FILE: '/p' }, fileEnv: 'K_FILE', readFile: () => '\n  \n' }).source,
    SOURCE.NONE,
  )

  // readFile을 안 주면 파일 폴백 자체가 비활성 (allowFile:false 경로)
  eq(
    'readFile 미제공 시 파일 폴백 없음',
    resolveSecret({ name: 'K', env: { K_FILE: '/p' }, fileEnv: 'K_FILE' }).source,
    SOURCE.NONE,
  )
}

// --------------------------------------------------- 3) 값 미출력 (§2 핵심)
section('3) 로그에 값이 새지 않는가')
{
  const SECRET = 'super-secret-krx-key-9876543210'
  const r = resolveSecret({ name: 'KRX_API_KEY', env: { KRX_API_KEY: SECRET, DOPPLER_PROJECT: 'investing-ops' } })
  const line = sourceLine('KRX_API_KEY', r)
  check('출처 로그에 값 없음', !line.includes(SECRET), line)
  check('길이는 표기', line.includes(String(SECRET.length)))
  check('Doppler는 ✅ 표기', line.startsWith('✅'))

  const fb = sourceLine('KRX_API_KEY', resolveSecret({ name: 'KRX_API_KEY', env: { KRX_API_KEY: SECRET } }))
  check('폴백은 ⚠️ 표기', fb.startsWith('⚠️'), fb)
  check('폴백 로그에도 값 없음', !fb.includes(SECRET))
  check('폴백 안내에 doppler run 언급', fb.includes('doppler run'))

  const none = sourceLine('KRX_API_KEY', resolveSecret({ name: 'KRX_API_KEY', env: {} }))
  check('부재는 ⛔ 표기', none.startsWith('⛔'))

  // 안내문에도 값이 들어갈 여지가 없어야 한다
  const help = missingHelp('KRX_API_KEY', 'investing-ops')
  check('안내문에 doppler run 표준 제시', help.includes('doppler run') && help.includes('investing-ops'))
  check('안내문이 값 입력을 대표 전용으로 명시', help.includes('대표만') || help.includes('대표 본인만'))
  check('안내문이 파일 방식을 권장하지 않음으로 표기', help.includes('권장하지 않'))
}

// ------------------------------------------------------------- 4) 마스킹
section('4) 마스킹')
{
  const SECRET = 'abcdefgh12345678'
  const mask = maskerFor(SECRET)
  eq('본문 내 시크릿 치환', mask(`url?AUTH_KEY=${SECRET}&x=1`), 'url?AUTH_KEY=****&x=1')
  eq('여러 번 나와도 전부', mask(`${SECRET}/${SECRET}`), '****/****')
  eq('없으면 그대로', mask('아무것도 없음'), '아무것도 없음')
  eq('null 안전', mask(null), null)

  // 너무 짧은 값은 마스킹 대상에서 제외 — 흔한 문자열을 다 지워버리면 로그가 망가진다
  const short = maskerFor('abc')
  eq('짧은 값은 마스킹 안 함', short('abcdef'), 'abcdef')

  // 여러 시크릿 동시
  const multi = maskerFor('key1key1key1', 'key2key2key2')
  eq('복수 시크릿 마스킹', multi('a key1key1key1 b key2key2key2'), 'a **** b ****')
}

// --------------------------------------- 5) 회귀 방지 — 기본값이 평문 경로면 안 된다
section('5) 재발방지 — 평문 경로가 기본값이 되지 않는가')
{
  // env가 완전히 비어 있으면 어떤 파일도 자동으로 읽히면 안 된다.
  // (사고 원인: DEFAULT_KEY_FILE 하드코딩 → 다음 세션이 그대로 복사)
  let readAttempts = 0
  const r = resolveSecret({
    name: 'KRX_API_KEY',
    env: {},
    fileEnv: 'KRX_API_KEY_FILE',
    readFile: () => {
      readAttempts++
      return 'should-not-be-read'
    },
  })
  eq('경로 env 없으면 파일 접근 시도 자체를 안 함', readAttempts, 0)
  eq('따라서 값도 없음', r.value, null)
}

finish()

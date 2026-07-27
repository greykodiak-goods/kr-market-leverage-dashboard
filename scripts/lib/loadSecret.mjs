// 시크릿 로딩 단일 구현 — ops `governance/SECRETS-POLICY.md` 를 코드로 강제한다.
//
// 왜 라이브러리로 묶었나:
//   정책이 문서로만 있으면 다음 세션이 옆 스크립트의 기존 코드를 복사한다.
//   실제로 그렇게 사고가 났다(KRX 키를 평문 파일 경로로 안내). 그래서 "시크릿을 어떻게
//   읽는가"의 구현을 여기 하나로 두고, 스크립트는 이것만 부르게 한다.
//
// 정책 요약 (SECRETS-POLICY.md):
//   §1.1 새 시크릿은 Doppler에 먼저 등록한다. 플랫폼 env에 직접 넣지 않는다.
//   §1.4 폴백 필수 — Doppler 우선 → 실패 시 기존값. **출처를 로그로 남긴다**(✅/⚠️).
//   §2   AI는 실제 시크릿 값을 조회·기록·출력하지 않는다. 값 미출력, 존재/길이만.
//
// 표준 실행법:
//   doppler run --project investing-ops --config prd -- node scripts/<script>.mjs
//   (doppler run 이 env로 주입하므로 스크립트는 env만 읽으면 된다)

import { readFileSync } from 'node:fs'

/** 시크릿 출처 — 로그에 이것만 남기고 값은 절대 남기지 않는다. */
export const SOURCE = {
  DOPPLER: 'doppler',
  ENV: 'env',
  FILE: 'file',
  NONE: 'none',
}

/**
 * 순수 해석부 — 실제 fs/env를 건드리지 않아 테스트 가능하다.
 *
 * 우선순위:
 *   1) doppler run 주입 (DOPPLER_PROJECT 가 함께 있으면 Doppler 경유로 판정)
 *   2) 수동 env
 *   3) 파일 (레거시 폴백 — 신규 시크릿에는 쓰지 말 것)
 *
 * @param {object} o
 * @param {string} o.name            시크릿 이름 (예: 'KRX_API_KEY')
 * @param {Record<string,string|undefined>} o.env  환경변수 맵
 * @param {(p:string)=>string} [o.readFile]        파일 읽기 (없으면 파일 폴백 비활성)
 * @param {string} [o.fileEnv]       파일 경로를 담은 env 이름 (예: 'KRX_API_KEY_FILE')
 * @returns {{ value: string|null, source: string, detail: string }}
 */
export function resolveSecret({ name, env, readFile, fileEnv }) {
  const raw = env[name]
  if (raw && raw.trim()) {
    const viaDoppler = Boolean(env.DOPPLER_PROJECT || env.DOPPLER_CONFIG)
    return viaDoppler
      ? {
          value: raw.trim(),
          source: SOURCE.DOPPLER,
          detail: `Doppler ${env.DOPPLER_PROJECT ?? '?'}/${env.DOPPLER_CONFIG ?? '?'}`,
        }
      : { value: raw.trim(), source: SOURCE.ENV, detail: '환경변수 직접 주입' }
  }

  const path = fileEnv ? env[fileEnv] : undefined
  if (path && readFile) {
    try {
      const v = readFile(path).trim()
      if (v) return { value: v, source: SOURCE.FILE, detail: '평문 키 파일(레거시)' }
    } catch {
      /* 아래 none 으로 떨어진다 */
    }
  }

  return { value: null, source: SOURCE.NONE, detail: '어디에서도 찾지 못함' }
}

/** 값은 빼고 출처·길이만 남기는 로그 한 줄. (§2 값 미출력) */
export function sourceLine(name, r) {
  if (r.source === SOURCE.DOPPLER) return `✅ ${name}: ${r.detail} (길이 ${r.value.length})`
  if (r.source === SOURCE.ENV) return `⚠️ 폴백 ${name}: ${r.detail} — 표준은 doppler run (길이 ${r.value.length})`
  if (r.source === SOURCE.FILE) return `⚠️ 폴백 ${name}: ${r.detail} — Doppler 이관 대상 (길이 ${r.value.length})`
  return `⛔ ${name}: ${r.detail}`
}

/** 표준 안내문 — 키를 못 찾았을 때 모든 스크립트가 같은 문구를 낸다. */
export function missingHelp(name, project = 'investing-ops') {
  return [
    `${name} 를 찾지 못했습니다.`,
    '',
    '표준 (ops governance/SECRETS-POLICY.md — 시크릿 단일 원본 = Doppler):',
    `  doppler run --project ${project} --config prd -- node ${process.argv[1] ?? '<script>'}`,
    '',
    '아직 Doppler에 없다면 (대표 본인만·T0):',
    `  1) Doppler에 프로젝트 ${project} / config prd 생성`,
    `  2) ${name} 값 입력  ← 값 입력은 대표만. AI 세션엔 DOPPLER_TOKEN 주지 않음`,
    '  3) read-only 서비스 토큰 발급 → 실행 환경에 DOPPLER_TOKEN 배치',
    '',
    '임시 폴백 (권장하지 않음 · 평문이 디스크에 남음):',
    `  ${name}=<값> node <script>            # 셸 히스토리에 남으니 주의`,
    `  ${name}_FILE=<키파일경로> node <script>`,
  ].join('\n')
}

/**
 * 실제 로딩 — 스크립트가 쓰는 진입점.
 * 값은 반환만 하고 절대 출력하지 않는다. 출처 한 줄만 stderr로 남긴다.
 */
export function loadSecret(name, { project = 'investing-ops', allowFile = true } = {}) {
  const r = resolveSecret({
    name,
    env: process.env,
    readFile: allowFile ? (p) => readFileSync(p, 'utf8') : undefined,
    fileEnv: `${name}_FILE`,
  })
  console.error(sourceLine(name, r))
  return { ...r, help: r.value ? null : missingHelp(name, project) }
}

/** 로그·에러 문자열에 시크릿이 섞여 나가지 않게 마스킹. */
export function maskerFor(...secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 8)
  return (s) => {
    if (s == null) return s
    let out = String(s)
    for (const sec of list) out = out.split(sec).join('****')
    return out
  }
}

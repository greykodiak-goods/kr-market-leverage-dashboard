// 초경량 테스트 하네스 — 외부 러너 의존 없이 esbuild 번들 → node 실행.

let failures = 0
let passes = 0
const failed: string[] = []

export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passes++
    console.log(`  ok  ${name}`)
  } else {
    failures++
    failed.push(name)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

export function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`)
}

export function close(name: string, actual: number, expected: number, tol = 1e-9): void {
  check(name, Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`)
}

export function section(title: string): void {
  console.log(`\n${title}`)
}

export function finish(): never {
  console.log(`\n${passes} passed, ${failures} failed`)
  if (failures > 0) console.log(`실패: ${failed.join(', ')}`)
  process.exit(failures === 0 ? 0 : 1)
}

// 결정적 난수 (Math.random 금지 — 테스트 재현성)
export function rng(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

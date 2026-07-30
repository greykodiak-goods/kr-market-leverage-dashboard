// Convex 기본(V8) 런타임의 process.env 타입 선언 — Node 전체 타입을 끌어오지 않기 위한 최소 선언.
// (Convex 런타임은 Node가 아니며 process.env만 노출한다. 값은 대시보드/CLI env로 주입.)
declare const process: {
  env: {
    DART_API_KEY?: string
    INGEST_TOKEN?: string
    // Phase A ingest — INGEST_TOKEN과 같은 용도. 둘 중 등록된 것을 쓴다(http.ts ingestSecret()).
    INGEST_SECRET?: string
    [key: string]: string | undefined
  }
}

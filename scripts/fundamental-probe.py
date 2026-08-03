#!/usr/bin/env python3
"""재무데이터 프로브 (KRX) — 밸류·퀄리티 팩터 착수 전 5항목 실측 확정.

왜 프로브가 먼저인가 (ops governance/TOP-PRIORITY.md 규칙 4):
  저PBR·저PER·고ROE 팩터를 백테스트에 붙이려면 **각 시점에 그때 알 수 있었던 값**이
  필요하다. KRX 통계 백엔드(MDCSTAT03502 · pykrx `get_market_fundamental`)가 과거 날짜에
  대해 **그 시점에 공표된 값(as-published)** 을 주는지, 아니면 지금 확정된 값을
  **소급 적용(retro-recalculated)** 해 주는지가 이 경로의 생사를 가른다.
  소급이면 그 값을 쓰는 순간 규칙 1(미래참조 금지) 위반이고 백테스트는 통째로 거짓이 된다.
  그래서 **코드를 짜기 전에 실응답으로 판정**한다. 판정 못 하면 "판정 불가"로 남기고
  추측하지 않는다.

이 스크립트가 확정하는 것 (규칙 4의 5항목 중 KRX 몫):
  A-1 소급 재계산 여부   ← 🔴 통과 못 하면 이 경로 폐기
  A-2 데이터 시작 연도   ← DART의 2015 절벽을 우회할 수 있는지
  A-3 필드·단위·타입     ← 적자기업 PER·무배당 DIV 표현 (랭킹을 뒤집는 처리 규칙)
  A-4 효율·백필 소요     ← 종목별 조회 vs 전 종목 단면 조회

원칙:
  - **조용한 폴백 금지.** 못 받으면 던진다. 기본값·직전값 승계·빈 배열 대체 없음.
  - **성공 카운터.** 전량 실패면 종료코드 1. 정상 0건(데이터 없음)과 실패 0건(차단·오류)을
    구분해 출력한다 — 항목별 try·except가 오류를 삼켜 "다 실패했는데 종료코드 0"이 되는 것을 막는다.
  - **수집·저장 금지.** 순수 조사용이라 파일을 한 개도 쓰지 않는다(리포에 데이터 커밋 없음).
  - 확정 못 한 항목은 `[미검증]` 으로 남긴다. 시크릿 값은 어떤 경로로도 출력하지 않는다(길이만).

시크릿 (ops governance/SECRETS-POLICY.md · 리포 규칙 2-1):
  KRX_ID / KRX_PW 를 env로 받는다(2025-12-27 KRX 회원제 전환으로 로그인 필수).
  표준 실행:
    doppler run --project investing-ops --config prd -- python3 scripts/fundamental-probe.py

실행 장소 (리포 CLAUDE.md "실행 장소 규칙"):
  **EC2(국내 IP) 전용.** data.krx.co.kr 은 해외 IP에서 403으로 막힌다.

한계 (규칙 3 — 정직성):
  data.krx.co.kr 통계 백엔드는 **문서화된 공식 API가 아니다.** SLA·정확성 보증이 없고
  화면 개편 시 일괄로 깨진다. 여기서 나온 판정도 "이 시점의 실측"이지 계약이 아니다.
"""

import contextlib
import io
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))

# 프로브 대상 — 오래 상장돼 있고 결산 시점이 12월인 대형주(시작 연도 측정에 유리).
PROBE_TICKERS = [
    ("005930", "삼성전자"),
    ("000660", "SK하이닉스"),
    ("005380", "현대차"),
    ("051910", "LG화학"),
]
# A-1 판정 대상 연도 — 한 해만 보면 그 해의 특수사정에 속으므로 여러 해로 본다.
BOUNDARY_YEARS = [2016, 2019, 2023]
# A-2 시작 연도 탐침 — 오래된 쪽부터. KRX가 2010까지 닿으면 DART 2015 절벽을 우회할 수 있다.
START_YEAR_PROBES = [2005, 2008, 2010, 2012, 2014, 2015, 2016]
# 지시서에 명시된 경계 표본 — 범위 스캔과 별개로 이 두 날짜의 값을 그대로 찍어 둔다.
EXPLICIT_PAIR = ("20230428", "20230508")

# 결산(사업보고서) 반영이 일어날 수 있는 달 — 사업보고서 제출기한이 사업연도 종료 후 90일
# (12월 결산이면 3월 말)이라, as-published라면 지표 갱신은 3~6월에 나타나야 한다.
PUBLISH_MONTHS = {3, 4, 5, 6}

# 성공/실패/빈응답 카운터 — 전량 실패를 종료코드로 드러낸다.
STAT = {"ok": 0, "empty": 0, "fail": 0}
FINDINGS = {}  # 판정 요약 블록에 쓸 값


def log(msg=""):
    print(f"[fundamental-probe] {msg}", file=sys.stderr)


def out(msg=""):
    """판정·측정 결과는 stdout 으로 — 총괄이 그대로 보고에 복사한다."""
    print(msg)


class _Masking(io.TextIOBase):
    """pykrx 는 로그인 시 stdout 에 '로그인 ID: <값>' 을 그대로 찍는다.
    로그에 남으면 자격증명 노출이므로(SECRETS-POLICY §2) 가로채 마스킹한다."""

    def __init__(self, secrets):
        self._secrets = [s for s in secrets if s and len(s) >= 3]

    def write(self, s):
        o = s
        for sec in self._secrets:
            o = o.replace(sec, "****")
        o = re.sub(r"(로그인\s*ID\s*:\s*)\S+", r"\1****", o)
        sys.stderr.write(o)
        return len(s)


@contextlib.contextmanager
def no_credential_leak():
    with contextlib.redirect_stdout(_Masking([os.environ.get("KRX_ID"), os.environ.get("KRX_PW")])):
        yield


def check_credentials():
    """값은 출력하지 않고 존재·길이만 확인한다(SECRETS-POLICY §2)."""
    kid, kpw = os.environ.get("KRX_ID"), os.environ.get("KRX_PW")
    via_doppler = bool(os.environ.get("DOPPLER_PROJECT") or os.environ.get("DOPPLER_CONFIG"))
    if kid and kpw:
        src = (
            f"✅ Doppler {os.environ.get('DOPPLER_PROJECT', '?')}/{os.environ.get('DOPPLER_CONFIG', '?')}"
            if via_doppler
            else "⚠️ 폴백(환경변수 직접) — 표준은 doppler run"
        )
        log(f"{src} · KRX_ID({len(kid)}자) KRX_PW({len(kpw)}자)")
        return True
    log("⛔ KRX_ID / KRX_PW 가 없습니다.")
    log("   표준: doppler run --project investing-ops --config prd -- python3 scripts/fundamental-probe.py")
    return False


# ---------------------------------------------------------------- pykrx 호출부
# pykrx 는 버전에 따라 통합 API(get_market_fundamental)와 구 API(_by_date/_by_ticker)가
# 갈린다. **후보를 순회하는 것은 "함수 이름 확정"이지 데이터 폴백이 아니다** — 어느 것을
# 썼는지 로그에 남기고, 전부 실패하면 던진다(조용한 폴백 금지).
_RESOLVED = {}


def _resolve(*names):
    from pykrx import stock

    key = names[0]
    if key in _RESOLVED:
        return _RESOLVED[key]
    for n in names:
        fn = getattr(stock, n, None)
        if callable(fn):
            log(f"pykrx 함수 확정: {n}")
            _RESOLVED[key] = (fn, n)
            return _RESOLVED[key]
    raise RuntimeError(f"pykrx 에 {names} 가 모두 없습니다 — 라이브러리 버전 확인 필요")


def fundamental_by_date(frm, to, ticker):
    """종목 1개의 기간 시계열. 반환: (rows, 함수명)"""
    fn, name = _resolve("get_market_fundamental_by_date", "get_market_fundamental")
    return fn(frm, to, ticker), name


def fundamental_by_ticker(day, market="ALL"):
    """특정 일자의 전 종목 단면. 반환: (df, 함수명)

    통합 API(`get_market_fundamental`)는 2번째 위치인자가 `todate` 라 시장 문자열을
    위치로 넘기면 안 된다. 키워드를 먼저 시도하고, 구 API 시그니처면 위치로 재시도한다.
    (둘 다 실패하면 던진다 — 조용한 폴백 금지)"""
    fn, name = _resolve("get_market_fundamental_by_ticker", "get_market_fundamental")
    try:
        return fn(day, market=market), name
    except TypeError:
        return fn(day, market), name


def ohlcv_by_date(frm, to, ticker):
    fn, _ = _resolve("get_market_ohlcv_by_date", "get_market_ohlcv")
    return fn(frm, to, ticker)


def rows_of(df):
    """DataFrame → [(YYYY-MM-DD, {col: value})] 정렬 리스트. 이후 분석은 순수 파이썬으로 한다."""
    out_rows = []
    if df is None:
        raise RuntimeError("응답이 None — pykrx 가 데이터프레임을 주지 않았다")
    for idx, r in df.iterrows():
        d = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)
        out_rows.append((d, {c: r[c] for c in df.columns}))
    out_rows.sort(key=lambda x: x[0])
    return out_rows


def fnum(v):
    """숫자화. 못 바꾸면 None (NaN 포함) — 0 으로 뭉개지 않는다(적자 PER 판별이 걸려 있다)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


def pick(d, *names):
    for n in names:
        if n in d:
            return fnum(d[n])
    return None


# ------------------------------------------------------- A-1 소급 재계산 판정
def analyze_series(rs, year):
    """한 종목의 (year-1 ~ year) EPS/BPS 시계열에서 PIT 성립 여부를 읽는다.

    판정 논리 두 축:
      ① **갱신 시점**: as-published 라면 EPS·BPS 는 사업보고서 제출 이후(3~6월)에 계단식으로
         바뀐다. 회계연도 시작(1월 첫 거래일)에 바뀌면 그 해 실적을 연초에 이미 안다는 뜻 →
         소급(미래참조).
      ② **연초 값의 정체**: as-published 면 Y년 1월의 EPS 는 Y-1년 6월의 EPS 와 같아야 한다
         (둘 다 FY(Y-2) 확정치). 소급이면 Y년 1월 EPS 가 Y년 6월 EPS 와 같아진다.
    """
    if not rs:
        return {"verdict": "EMPTY", "note": "행 없음"}

    def val_on(prefix_list, col):
        """주어진 연·월 접두사 중 가장 이른 행의 값."""
        for pre in prefix_list:
            for d, r in rs:
                if d.startswith(pre):
                    v = pick(r, col)
                    if v is not None:
                        return d, v
        return None, None

    col = "EPS"
    if col not in rs[0][1]:
        return {"verdict": "NOFIELD", "note": f"{col} 컬럼 없음 — 컬럼: {list(rs[0][1])}"}

    # 값이 바뀐 날짜들
    changes = []
    prev = None
    for d, r in rs:
        v = pick(r, col)
        if v is None:
            continue
        if prev is not None and abs(v - prev) > 1e-9:
            changes.append((d, prev, v))
        prev = v

    d_jan, v_jan = val_on([f"{year}-01"], col)
    d_jun_prev, v_jun_prev = val_on([f"{year - 1}-06", f"{year - 1}-07"], col)
    d_jun, v_jun = val_on([f"{year}-06", f"{year}-07", f"{year}-08"], col)

    same = lambda a, b: a is not None and b is not None and abs(a - b) <= max(1e-9, abs(a) * 1e-6)

    axis2 = "UNKNOWN"
    if same(v_jan, v_jun_prev) and v_jun is not None and not same(v_jan, v_jun):
        axis2 = "PUBLISHED"  # 연초엔 아직 옛 확정치 → 정상
    elif same(v_jan, v_jun) and v_jun_prev is not None and not same(v_jan, v_jun_prev):
        axis2 = "RETRO"  # 연초에 이미 그 해 확정치 → 소급
    elif same(v_jan, v_jun) and same(v_jan, v_jun_prev):
        axis2 = "FLAT"  # 2년 내내 안 바뀜 — 판정 불가(무변화 기업일 수도)

    year_changes = [c for c in changes if c[0].startswith(str(year))]
    months = sorted({int(c[0][5:7]) for c in year_changes})
    jan_first_change = any(c[0] == rs[0][0] for c in year_changes) or any(m == 1 for m in months)
    axis1 = "UNKNOWN"
    if months and set(months) & PUBLISH_MONTHS:
        axis1 = "PUBLISHED"
    if jan_first_change:
        axis1 = "RETRO"
    if not months:
        axis1 = "NOCHANGE"

    if axis1 == "RETRO" or axis2 == "RETRO":
        verdict = "RETRO"
    elif axis1 == "PUBLISHED" and axis2 in ("PUBLISHED", "UNKNOWN", "FLAT"):
        verdict = "PUBLISHED"
    elif axis2 == "PUBLISHED":
        verdict = "PUBLISHED"
    else:
        verdict = "UNKNOWN"

    return {
        "verdict": verdict,
        "axis1": axis1,
        "axis2": axis2,
        "changeMonths": months,
        "changes": year_changes[:4],
        "jan": (d_jan, v_jan),
        "junPrev": (d_jun_prev, v_jun_prev),
        "jun": (d_jun, v_jun),
        "rowCount": len(rs),
    }


def probe_a1():
    out("\n" + "=" * 78)
    out("A-1. 소급 재계산 여부 — 🔴 이 경로의 생사")
    out("=" * 78)
    out("판정 기준: 결산 반영 경계(3~6월)에서 EPS/BPS 가 **계단식으로 점프**하면 as-published(PIT 사용 가능).")
    out("           회계연도 시작(1월)에 바뀌거나 연초부터 그 해 확정치를 들고 있으면 소급 재계산(미래참조).")

    verdicts = []
    for year in BOUNDARY_YEARS:
        out(f"\n--- {year}년 (조회 구간 {year - 1}0101 ~ {year}1231) ---")
        for ticker, name in PROBE_TICKERS:
            try:
                df, fn_used = fundamental_by_date(f"{year - 1}0101", f"{year}1231", ticker)
                rs = rows_of(df)
            except Exception as e:  # noqa: BLE001 — 프로브라 원인 문자열을 그대로 보여준다
                STAT["fail"] += 1
                out(f"  ⛔ {name}({ticker}) 실패: {type(e).__name__}: {e}")
                continue
            if not rs:
                STAT["empty"] += 1
                out(f"  ○ {name}({ticker}) 정상 0건 (데이터 없음 — 실패 아님)")
                continue
            STAT["ok"] += 1
            a = analyze_series(rs, year)
            verdicts.append((year, ticker, a["verdict"]))
            out(f"  {name}({ticker}) [{fn_used}] {a['rowCount']}행 · 판정={a['verdict']}")
            out(f"      갱신 시점축={a.get('axis1')} (변경 월 {a.get('changeMonths')}) · 연초값축={a.get('axis2')}")
            out(f"      EPS {year - 1}-06={a['junPrev'][1]} → {year}-01={a['jan'][1]} → {year}-06={a['jun'][1]}")
            for d, before, after in a.get("changes", []):
                out(f"      · {d} EPS {before} → {after}")

    # 지시서 명시 표본 — 경계 두 날짜의 원값을 그대로 남긴다
    out(f"\n--- 명시 표본 {EXPLICIT_PAIR[0]} vs {EXPLICIT_PAIR[1]} ---")
    for ticker, name in PROBE_TICKERS:
        vals = []
        for day in EXPLICIT_PAIR:
            try:
                df, _ = fundamental_by_date(day, day, ticker)
                rs = rows_of(df)
            except Exception as e:  # noqa: BLE001
                STAT["fail"] += 1
                vals.append(f"실패({type(e).__name__})")
                continue
            if not rs:
                STAT["empty"] += 1
                vals.append("0건")
                continue
            STAT["ok"] += 1
            r = rs[0][1]
            vals.append(
                f"EPS={pick(r, 'EPS')} BPS={pick(r, 'BPS')} PER={pick(r, 'PER')} PBR={pick(r, 'PBR')}"
            )
        out(f"  {name}({ticker})")
        out(f"      {EXPLICIT_PAIR[0]}: {vals[0] if vals else '-'}")
        out(f"      {EXPLICIT_PAIR[1]}: {vals[1] if len(vals) > 1 else '-'}")

    # 자기검증 — PER ≈ 종가 / EPS 인지 확인(단위·의미 확정)
    out("\n--- 자기검증: PER ≈ 종가 ÷ EPS ---")
    try:
        t = PROBE_TICKERS[0][0]
        df, _ = fundamental_by_date("20230508", "20230512", t)
        frs = rows_of(df)
        prs = rows_of(ohlcv_by_date("20230508", "20230512", t))
        pmap = {d: pick(r, "종가", "close") for d, r in prs}
        for d, r in frs[:2]:
            eps, per, bps, pbr = pick(r, "EPS"), pick(r, "PER"), pick(r, "BPS"), pick(r, "PBR")
            close = pmap.get(d)
            calc_per = (close / eps) if (close and eps) else None
            calc_pbr = (close / bps) if (close and bps) else None
            out(f"  {d} 종가={close} EPS={eps} → 계산PER={calc_per} vs 응답PER={per}")
            out(f"  {d} 종가={close} BPS={bps} → 계산PBR={calc_pbr} vs 응답PBR={pbr}")
        STAT["ok"] += 1
    except Exception as e:  # noqa: BLE001
        STAT["fail"] += 1
        out(f"  ⛔ 자기검증 실패: {type(e).__name__}: {e}")

    kinds = {v for _, _, v in verdicts}
    if not verdicts:
        FINDINGS["a1"] = "❓ 판정 불가 — 유효 응답 0건 (추측하지 않는다)"
    elif "RETRO" in kinds:
        bad = [f"{y}/{t}" for y, t, v in verdicts if v == "RETRO"]
        FINDINGS["a1"] = f"⛔ 소급 재계산 의심 — 경로 폐기 (해당: {', '.join(bad)})"
    elif kinds == {"PUBLISHED"}:
        FINDINGS["a1"] = f"✅ as-published (PIT 사용 가능) — 표본 {len(verdicts)}건 전부 일치"
    elif "PUBLISHED" in kinds:
        n = sum(1 for _, _, v in verdicts if v == "PUBLISHED")
        FINDINGS["a1"] = f"❓ 판정 불가 — as-published {n}/{len(verdicts)}건, 나머지 불명확(추가 표본 필요)"
    else:
        FINDINGS["a1"] = f"❓ 판정 불가 — 판별축이 모두 불명확 ({sorted(kinds)})"
    out(f"\n>>> A-1 판정: {FINDINGS['a1']}")


# ------------------------------------------------------------ A-2 시작 연도
def probe_a2():
    out("\n" + "=" * 78)
    out("A-2. 데이터 시작 연도 (KRX가 2010까지 닿으면 DART 2015 절벽 우회 가능)")
    out("=" * 78)
    ticker, name = PROBE_TICKERS[0]
    earliest = None
    for y in START_YEAR_PROBES:
        # 1월 초 2주를 조회한다 — 휴장일 하루를 찍어 "없다"고 오판하지 않기 위함
        frm, to = f"{y}0102", f"{y}0115"
        try:
            df, _ = fundamental_by_date(frm, to, ticker)
            rs = rows_of(df)
        except Exception as e:  # noqa: BLE001
            STAT["fail"] += 1
            out(f"  {y}: ⛔ 실패 {type(e).__name__}: {e}")
            continue
        usable = [(d, r) for d, r in rs if pick(r, "BPS") not in (None, 0)]
        if rs:
            STAT["ok"] += 1
        else:
            STAT["empty"] += 1
        if usable:
            d, r = usable[0]
            earliest = earliest or y
            out(f"  {y}: ✅ {len(rs)}행 · 첫 유효일 {d} · BPS={pick(r, 'BPS')} EPS={pick(r, 'EPS')} PER={pick(r, 'PER')} PBR={pick(r, 'PBR')} DIV={pick(r, 'DIV')}")
        else:
            out(f"  {y}: ○ 값 없음 ({len(rs)}행 · 정상 0건 — 실패 아님)")
    FINDINGS["a2"] = (
        f"{earliest}년부터 값 존재 ({name} 기준 실측)" if earliest else "❓ 시작 연도 판정 불가 — 유효 값 0건"
    )
    out(f"\n>>> A-2 판정: {FINDINGS['a2']}")


# --------------------------------------------------- A-3 필드·단위·타입
def probe_a3():
    out("\n" + "=" * 78)
    out("A-3. 필드·단위·타입 — 적자기업 PER / 무배당 DIV 표현 (랭킹을 뒤집는 처리 규칙)")
    out("=" * 78)
    day = os.environ.get("PROBE_SNAPSHOT_DAY", "20240102")
    try:
        df, _fn = fundamental_by_ticker(day, "ALL")
    except Exception as e:  # noqa: BLE001
        STAT["fail"] += 1
        out(f"  ⛔ 전 종목 단면({day}) 실패: {type(e).__name__}: {e}")
        FINDINGS["a3"] = "❓ 판정 불가 — 단면 조회 실패"
        out(f"\n>>> A-3 판정: {FINDINGS['a3']}")
        return

    cols = list(df.columns)
    out(f"  단면 일자 {day} · 종목 {len(df)}개 · 컬럼 {cols}")
    out(f"  dtypes: {dict(df.dtypes.astype(str))}")
    if len(df) == 0:
        STAT["empty"] += 1
        FINDINGS["a3"] = "❓ 판정 불가 — 단면 0건(휴장일 가능). PROBE_SNAPSHOT_DAY 로 재시도"
        out(f"\n>>> A-3 판정: {FINDINGS['a3']}")
        return
    STAT["ok"] += 1

    # 표현 분포 — 적자기업 PER, 무배당 DIV 가 0인지 NaN인지 공란인지가 핵심
    def dist(col):
        if col not in df.columns:
            return f"{col}: 컬럼 없음"
        vals = [fnum(v) for v in df[col].tolist()]
        raw = df[col].tolist()
        nan = sum(1 for v, r in zip(vals, raw) if v is None and str(r).strip() != "")
        blank = sum(1 for r in raw if str(r).strip() == "")
        zero = sum(1 for v in vals if v is not None and v == 0)
        neg = sum(1 for v in vals if v is not None and v < 0)
        pos = sum(1 for v in vals if v is not None and v > 0)
        return f"{col}: 양수 {pos} · 0 {zero} · 음수 {neg} · NaN/비수치 {nan} · 공란 {blank}"

    for c in ["BPS", "PER", "PBR", "EPS", "DIV", "DPS"]:
        out("  " + dist(c))

    # 적자기업 실표본 — EPS ≤ 0 인 종목의 PER 이 무엇으로 오는지 직접 본다
    shown = 0
    out("  적자 표본(EPS ≤ 0):")
    for tk, r in df.iterrows():
        eps = fnum(r.get("EPS"))
        if eps is not None and eps <= 0:
            out(f"    {tk} EPS={r.get('EPS')!r} PER={r.get('PER')!r} PBR={r.get('PBR')!r} BPS={r.get('BPS')!r}")
            shown += 1
            if shown >= 5:
                break
    if shown == 0:
        out("    (표본 없음 — [미검증])")

    shown = 0
    out("  무배당 표본(DPS = 0 또는 DIV = 0):")
    for tk, r in df.iterrows():
        dps, div = fnum(r.get("DPS")), fnum(r.get("DIV"))
        if (dps is not None and dps == 0) or (div is not None and div == 0):
            out(f"    {tk} DIV={r.get('DIV')!r} DPS={r.get('DPS')!r}")
            shown += 1
            if shown >= 5:
                break
    if shown == 0:
        out("    (표본 없음 — [미검증])")

    FINDINGS["a3"] = f"컬럼 {cols} · 분포는 위 출력 참조 (적자 PER·무배당 DIV 표현 실측 완료)"
    out(f"\n>>> A-3 판정: {FINDINGS['a3']}")


# ------------------------------------------------------------ A-4 효율·소요
def probe_a4():
    out("\n" + "=" * 78)
    out("A-4. 효율 — 종목별 시계열 조회 vs 전 종목 단면 조회 · 80종목 × 약 2,800영업일 백필 소요")
    out("=" * 78)
    ticker, name = PROBE_TICKERS[0]

    t0 = time.time()
    per_ticker_rows = 0
    try:
        df, _ = fundamental_by_date("20150102", "20241230", ticker)
        per_ticker_rows = len(rows_of(df))
        STAT["ok"] += 1
    except Exception as e:  # noqa: BLE001
        STAT["fail"] += 1
        out(f"  ⛔ 종목별 장기 조회 실패: {type(e).__name__}: {e}")
    t_ticker = time.time() - t0
    out(f"  [종목별] {name} 2015-01-02~2024-12-30 1회 호출: {t_ticker:.2f}s · {per_ticker_rows}행")

    t0 = time.time()
    snap_rows = 0
    try:
        d, _fn = fundamental_by_ticker("20240102", "ALL")
        snap_rows = len(d)
        STAT["ok"] += 1
    except Exception as e:  # noqa: BLE001
        STAT["fail"] += 1
        out(f"  ⛔ 전 종목 단면 실패: {type(e).__name__}: {e}")
    t_snap = time.time() - t0
    out(f"  [단면] 2024-01-02 전 종목 1회 호출: {t_snap:.2f}s · {snap_rows}종목")

    N_TICKERS, N_DAYS = 80, 2800
    est_ticker = t_ticker * N_TICKERS if t_ticker > 0 else None
    est_snap = t_snap * N_DAYS if t_snap > 0 else None
    if est_ticker:
        out(f"  ▶ 종목별 경로 예상: {t_ticker:.2f}s × {N_TICKERS}종목 = {est_ticker / 60:.1f}분 (약 {N_TICKERS}회 호출)")
    if est_snap:
        out(f"  ▶ 단면 경로 예상:   {t_snap:.2f}s × {N_DAYS}일 = {est_snap / 60:.1f}분 (약 {N_DAYS}회 호출)")
    if est_ticker and est_snap:
        faster = "종목별 시계열" if est_ticker < est_snap else "전 종목 단면"
        ratio = max(est_ticker, est_snap) / max(1e-9, min(est_ticker, est_snap))
        FINDINGS["a4"] = (
            f"{faster} 경로가 {ratio:.1f}배 빠름 · 80종목×2800일 백필 예상 "
            f"{min(est_ticker, est_snap) / 60:.1f}분"
        )
        out(f"  ▶ 권장: **{faster}** 경로 (다른 쪽 대비 {ratio:.1f}배 빠름)")
        out("     주: 단면 경로는 그 날짜의 **전 종목**을 주므로 유니버스가 커지면 유리해진다.")
    else:
        FINDINGS["a4"] = "❓ 측정 불가 — 호출 실패"
    out(f"\n>>> A-4 판정: {FINDINGS['a4']}")


# ------------------------------------------------------------------- 요약
def summary():
    out("\n" + "=" * 78)
    out("판정 요약 (KRX fundamental) — 총괄 보고용")
    out("=" * 78)
    out(f"  A-1 소급 재계산 여부 : {FINDINGS.get('a1', '❓ 미실행')}")
    out(f"  A-2 데이터 시작 연도 : {FINDINGS.get('a2', '❓ 미실행')}")
    out(f"  A-3 필드·표현 규칙   : {FINDINGS.get('a3', '❓ 미실행')}")
    out(f"  A-4 백필 소요        : {FINDINGS.get('a4', '❓ 미실행')}")
    out("")
    out(f"  호출 성공 {STAT['ok']}건 · 정상 0건(데이터없음) {STAT['empty']}건 · 실패 {STAT['fail']}건")
    a1 = FINDINGS.get("a1", "")
    if a1.startswith("✅"):
        go = "✅ 착수 가능 — KRX fundamental 을 PIT 소스로 채택하고 팩터 백필 설계로 진행"
    elif a1.startswith("⛔"):
        go = "⛔ 착수 불가 — 이 경로 폐기. DART 원문(rcept_no 기준 PIT)으로만 팩터를 만든다"
    else:
        go = "⏸ 보류 — A-1 판정 불가. 표본을 늘려 재측정하기 전에는 착수하지 않는다(추측 금지)"
    out(f"  착수 가능 여부       : {go}")
    out("")
    out("  ※ data.krx.co.kr 통계 백엔드는 공식 API가 아니다(SLA·정확성 보증 없음) — 규칙 3 병기 대상.")
    out("  ※ 여기서 '판정 불가'로 남은 항목은 [미검증]이며 추측으로 메우지 않는다.")


def main():
    started = datetime.now(KST).isoformat(timespec="seconds")
    log(f"시작 {started} · 조사 전용(파일 미기록·데이터 미저장)")
    if not check_credentials():
        return 2  # 자격증명 없음 — 실패가 아니라 "건너뜀"

    try:
        with no_credential_leak():
            probe_a1()
            probe_a2()
            probe_a3()
            probe_a4()
    except ImportError as e:
        log(f"⛔ pykrx 미설치: {e}")
        log("   EC2에서: pip3 install --user pykrx")
        return 1
    finally:
        summary()

    if STAT["ok"] == 0:
        log("⛔ 성공 호출 0건 — 전량 실패로 종료(종료코드 1). 해외 IP 차단·로그인 실패를 먼저 의심할 것.")
        return 1
    log(f"완료 — 성공 {STAT['ok']} · 0건 {STAT['empty']} · 실패 {STAT['fail']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

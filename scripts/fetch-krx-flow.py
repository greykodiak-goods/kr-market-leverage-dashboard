#!/usr/bin/env python3
"""KRX 수급 수집기 — 샘플로 남아 있던 3개 블록을 실데이터로 바꾼다.

채우는 것:
  1) supply-demand.json  flow.daily   외인·기관 일별 순매수 + 외국인 보유율
  2) hynix-short-balance.json         종목 공매도 잔고 일별

왜 파이썬인가:
  KRX 공식 오픈API(openapi.krx.co.kr)는 서비스 31개 전부가 시세·종목기본정보이고
  **투자자별 거래실적·외국인 보유율을 제공하지 않는다**(2026-07-27 조사 확정).
  유일한 무료·비브로커 경로가 data.krx.co.kr 통계 백엔드이고, 그 접근을 관리하는
  래퍼가 pykrx(파이썬)뿐이라 이 수집기만 파이썬이다.

시크릿 (ops governance/SECRETS-POLICY.md):
  KRX_ID / KRX_PW 를 env로 받는다. **값을 출력하지 않는다.**
  표준 실행:
    doppler run --project investing-ops --config prd -- python3 scripts/fetch-krx-flow.py
  ⚠️ KRX 로그인 자격증명이므로 대표 개인 상용 계정을 재사용하지 말고
     이 파이프라인 전용 계정을 쓴다(계정 탈취 시 피해 범위 격리).

한계 (화면에 반드시 표기 — 규칙 3):
  - data.krx.co.kr 통계 백엔드는 **문서화된 공식 API가 아니다.** SLA·정확성 보증이
    없고 화면 개편 시 일괄로 깨진다. 그래서 실패해도 기존 JSON을 덮지 않는다.
  - 당일 확정치는 장 마감 후(18시경). 장중 값은 없다.
  - 투자자별 **공매도**는 종목 단위가 없다(시장 집계만). 이 수집기는 종목 단위로
    확보 가능한 공매도 **잔고**만 채운다.
"""

import contextlib
import io
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

TICKER = "000660"  # SK하이닉스
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "data"
KST = timezone(timedelta(hours=9))
EOK = 100_000_000  # 1억


def log(msg: str) -> None:
    print(f"[fetch-krx-flow] {msg}", file=sys.stderr)


class _Masking(io.TextIOBase):
    """pykrx는 로그인 시 stdout에 '로그인 ID: <값>'을 그대로 찍는다.
    CI 로그에 남으면 자격증명 노출이므로(SECRETS-POLICY §2) 가로채 마스킹한다.
    라이브러리 출력을 없애지는 않는다 — 진단 정보는 남기되 값만 지운다."""

    def __init__(self, secrets):
        self._secrets = [s for s in secrets if s and len(s) >= 3]

    def write(self, s: str) -> int:
        out = s
        for sec in self._secrets:
            out = out.replace(sec, "****")
        # 값이 없어도 'ID:' 뒤 토큰은 통째로 지운다(형식이 바뀌어도 새지 않도록)
        out = re.sub(r"(로그인\s*ID\s*:\s*)\S+", r"\1****", out)
        sys.stderr.write(out)
        return len(s)


@contextlib.contextmanager
def _no_credential_leak():
    m = _Masking([os.environ.get("KRX_ID"), os.environ.get("KRX_PW")])
    with contextlib.redirect_stdout(m):
        yield


def check_credentials() -> bool:
    """값은 출력하지 않고 존재 여부만 확인한다(SECRETS-POLICY §2)."""
    kid, kpw = os.environ.get("KRX_ID"), os.environ.get("KRX_PW")
    via_doppler = bool(os.environ.get("DOPPLER_PROJECT") or os.environ.get("DOPPLER_CONFIG"))
    if kid and kpw:
        src = (
            f"✅ Doppler {os.environ.get('DOPPLER_PROJECT','?')}/{os.environ.get('DOPPLER_CONFIG','?')}"
            if via_doppler
            else "⚠️ 폴백(환경변수 직접) — 표준은 doppler run"
        )
        log(f"{src} · KRX_ID({len(kid)}자) KRX_PW({len(kpw)}자)")
        return True
    log("⛔ KRX_ID / KRX_PW 가 없습니다. 기존 JSON을 그대로 두고 종료합니다.")
    log("")
    log("  표준: doppler run --project investing-ops --config prd -- python3 scripts/fetch-krx-flow.py")
    log("")
    log("  아직 없다면 (대표 본인만·T0):")
    log("    1) data.krx.co.kr 무료 회원가입 — ⚠️ 이 파이프라인 전용 계정으로")
    log("    2) Doppler investing-ops/prd 에 KRX_ID, KRX_PW 입력")
    log("       (2025-12-27 KRX 회원제 전환으로 로그인 없이는 통계 조회가 막혔습니다)")
    return False


def ymd(d: date) -> str:
    return d.strftime("%Y%m%d")


def collect(days: int):
    """pykrx 호출부. import를 함수 안에 둔 이유: pykrx는 import 시점에 KRX 로그인을
    시도하므로, 자격증명 확인 전에 import하면 불필요한 로그인 실패가 찍힌다."""
    from pykrx import stock

    end = datetime.now(KST).date()
    start = end - timedelta(days=days)
    f, t = ymd(start), ymd(end)
    log(f"조회 구간 {f} ~ {t} · 종목 {TICKER}")

    # 투자자별 순매수 (금액) — 컬럼: 기관합계·기타법인·개인·외국인합계·전체
    value = stock.get_market_trading_value_by_date(f, t, TICKER)
    # 외국인 보유율 — 컬럼: 상장주식수·보유수량·지분율·한도수량·한도소진율
    foreign = stock.get_exhaustion_rates_of_foreign_investment_by_date(f, t, TICKER)
    # OHLCV — 종가·거래대금
    ohlcv = stock.get_market_ohlcv_by_date(f, t, TICKER)
    # 공매도 잔고 — 컬럼: 공매도잔고·상장주식수·공매도금액·시가총액·비중
    short_bal = stock.get_shorting_balance_by_date(f, t, TICKER)
    return value, foreign, ohlcv, short_bal


def pick(df, row, *names):
    """컬럼명이 버전에 따라 흔들리므로 후보를 순서대로 시도한다."""
    for n in names:
        if n in df.columns:
            v = row[n]
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
    return None


def build_flow(value, foreign, ohlcv):
    daily = []
    for idx, row in value.iterrows():
        d = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)
        fo = pick(value, row, "외국인합계", "외국인")
        inst = pick(value, row, "기관합계", "기관")
        rec = {
            "date": d,
            "foreignNetEok": round(fo / EOK) if fo is not None else None,
            "instNetEok": round(inst / EOK) if inst is not None else None,
        }
        if idx in ohlcv.index:
            o = ohlcv.loc[idx]
            c = pick(ohlcv, o, "종가")
            v = pick(ohlcv, o, "거래대금")
            rec["close"] = round(c) if c is not None else None
            rec["valueEok"] = round(v / EOK) if v is not None else None
        if idx in foreign.index:
            fr = foreign.loc[idx]
            r = pick(foreign, fr, "지분율")
            rec["foreignHoldRatio"] = round(r, 2) if r is not None else None
        daily.append(rec)
    return daily


def build_short(short_bal):
    out = []
    for idx, row in short_bal.iterrows():
        d = idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx)
        shares = pick(short_bal, row, "공매도잔고", "공매도")
        amount = pick(short_bal, row, "공매도금액", "공매도잔고금액")
        ratio = pick(short_bal, row, "비중")
        out.append(
            {
                "date": d,
                "shares": int(shares) if shares is not None else None,
                "amountEok": round(amount / EOK) if amount is not None else None,
                "ratioPct": round(ratio, 3) if ratio is not None else None,
            }
        )
    return out


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"기록 {path.name}")


def main() -> int:
    if not check_credentials():
        return 2  # 자격증명 없음 — 실패가 아니라 "건너뜀". 기존 JSON 보존.

    days = int(os.environ.get("KRX_DAYS", "400"))
    try:
        # pykrx의 로그인 출력이 그대로 새지 않도록 stdout을 마스킹 경유로 돌린다.
        with _no_credential_leak():
            value, foreign, ohlcv, short_bal = collect(days)
    except Exception as e:
        # 비공식 경로라 언제든 깨질 수 있다. 깨지면 기존 JSON을 **덮지 않는다**.
        log(f"⛔ 수집 실패 — 기존 JSON 유지: {type(e).__name__}: {e}")
        log("   data.krx.co.kr 통계 백엔드는 공식 API가 아니라 화면 개편 시 깨집니다.")
        return 1

    now = datetime.now(KST).isoformat(timespec="seconds")
    flow_daily = build_flow(value, foreign, ohlcv)
    short_series = build_short(short_bal)
    as_of = flow_daily[-1]["date"] if flow_daily else None
    log(f"수집 완료 — flow {len(flow_daily)}일 · 공매도잔고 {len(short_series)}일 · 기준 {as_of}")

    # 1) supply-demand.json 의 flow 블록만 교체 (events/overhang/concentration는 DART 담당)
    sd_path = OUT_DIR / "supply-demand.json"
    sd = json.loads(sd_path.read_text(encoding="utf-8"))
    sd["flow"] = {"daily": flow_daily}
    sd["sources"]["flow"] = "krx"
    sd["meta"]["sourceLabel"] = (
        "공시 LIVE (DART OpenAPI) · 수급 LIVE (KRX 통계 — 비공식 경로·로그인 필요)"
    )
    sd["meta"]["notes"] = (
        "5%룰·내부자 공시는 사유 발생 후 최대 5영업일 지연 보고되는 사후 확인 정보. "
        "수급(외인·기관 순매수·외국인 보유율)은 KRX 통계 백엔드에서 수집하며 문서화된 공식 API가 "
        "아니라 정확성·지속성 보증이 없다. 당일 확정치는 장 마감 후 반영."
    )
    sd["meta"]["fetchedAt"] = now
    if as_of:
        sd["meta"]["asOf"] = as_of
    write_json(sd_path, sd)

    # 2) 공매도 잔고
    sb_path = OUT_DIR / "hynix-short-balance.json"
    sb = json.loads(sb_path.read_text(encoding="utf-8"))
    sb["meta"].update(
        {
            "source": "LIVE",
            "sourceLabel": "LIVE — KRX 공매도 잔고 (비공식 경로·로그인 필요)",
            "generatedAt": now,
            "asOf": short_series[-1]["date"] if short_series else sb["meta"].get("asOf"),
            "notes": (
                "KRX 통계 백엔드에서 수집. 문서화된 공식 API가 아니므로 정확성·지속성 보증이 없다. "
                "공매도 잔고는 T+2 기준으로 공시되어 거래일과 시차가 있다."
            ),
        }
    )
    sb["series"] = short_series
    write_json(sb_path, sb)

    log("✅ 완료")
    return 0


if __name__ == "__main__":
    sys.exit(main())

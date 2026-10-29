"""Core model, merge and scoring logic for FairRecorder.

Kept free of CLI/report-rendering concerns so it can be unit tested directly.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2

# (code, zh_label, en_label)
CATEGORIES = [
    ("shower_enclosure", "淋浴房整体", "Shower Enclosure"),
    ("smart_toilet", "智能马桶", "Smart Toilet"),
    ("floor_toilet", "普通马桶", "Floor-Standing Toilet"),
    ("tempered_glass", "钢化玻璃", "Tempered Glass"),
    ("aluminium_profile", "铝型材", "Aluminium Profile"),
    ("hardware", "五金配件", "Hardware & Fittings"),
    ("roller_hinge", "滑轮/铰链", "Rollers & Hinges"),
    ("seal", "密封条/磁条", "Seals & Magnetic Strips"),
    ("tray", "底盆/石基", "Shower Tray & Base"),
    ("faucet_shower", "龙头/花洒", "Faucets & Shower Sets"),
    ("vanity", "浴室柜", "Bathroom Vanity"),
    ("other", "其他", "Other"),
]
COMPLIANCE_ITEMS = [
    ("CE", "CE 标识", "CE marking"),
    ("EN14428", "EN 14428 淋浴房", "EN 14428 (shower enclosures)"),
    ("EN12150", "EN 12150 钢化玻璃", "EN 12150 (tempered glass)"),
    ("KTW", "KTW 德国饮用水", "KTW (German drinking water)"),
    ("DWD", "DWD 饮用水", "DWD (drinking water)"),
    ("REACH", "REACH", "REACH"),
    ("RoHS", "RoHS", "RoHS"),
    ("ISO9001", "ISO 9001", "ISO 9001"),
]
# Evidence states — a supplier claim is NOT the same as a held document.
CSTAT = {
    "unknown": ("未知", "Unknown"),
    "supplier_claimed": ("供应商声称", "Supplier claimed"),
    "document_seen": ("现场看到文件", "Document seen"),
    "copy_received": ("已取得副本", "Copy received"),
    "not_available": ("无/不适用", "Not available"),
}
# v1.7 起评分三项：Design / Quality / Details，每项 1–5 星，权重合计 100。
SCORE_DIMS = [
    ("design", "设计与外观", "Design"),
    ("quality", "质量与工艺", "Quality"),
    ("details", "细节做工", "Details"),
]
DEFAULT_WEIGHTS = {"design": 30, "quality": 50, "details": 20}
# 老版本记录用的是六维评分，读到这里折算成三维口径，否则已评分厂家会变成未评分。
LEGACY_SCORE_MAP = {"design": "fit", "details": "compliance"}
FOLLOWUPS = {
    "new": ("新建立", "New"), "docs": ("索要资料", "Request Docs"),
    "quote": ("待报价", "Quote"), "sample": ("待样品", "Sample"),
    "hq": ("总部评审", "HQ Review"), "hold": ("暂缓", "Hold"), "reject": ("淘汰", "Reject"),
}
PHOTO_TYPES = {
    "booth": ("展位", "Booth"), "namecard": ("名片", "Name card"),
    "product": ("产品", "Product"), "certificate": ("证书", "Certificate"),
    "highlight": ("亮点产品", "Highlight"), "other": ("其他", "Other"),
}
# 名片上的字段：v1.7 起和联系人字段分开记，抬头常常和实际对接人不是一个人
NAMECARD_FIELDS = [
    ("name", "Name"), ("title", "Title"), ("phone", "Tel"), ("mobile", "Mobile"),
    ("email", "Email"), ("website", "Web"), ("address", "Address"), ("note", "Other"),
]
MARKETS = {
    "Germany 德国": "Germany", "EU (other) 欧盟其他": "EU (other)", "UK 英国": "UK",
    "North America 北美": "North America", "Middle East 中东": "Middle East",
    "Asia (other) 亚洲其他": "Asia (other)", "Other 其他": "Other",
}
CAT_EN = {c[0]: c[2] for c in CATEGORIES}
CAT_ZH = {c[0]: c[1] for c in CATEGORIES}
XLSX_SHEET_BAD = re.compile(r"[\[\]:*?/\\]")


# --------------------------------------------------------------------------- #
# normalisation helpers
# --------------------------------------------------------------------------- #
def norm_booth(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v or "")).strip().upper()


def norm_company(v: Any) -> str:
    s = re.sub(r"\s+", "", str(v or ""))
    s = s.replace("（", "(").replace("）", ")")
    s = re.sub(r"(有限公司|股份有限公司|\(CO\.,?\s*LTD\.?\)|CO\.?,?\s*LTD\.?|LIMITED|INC\.?)$", "", s, flags=re.I)
    return s.lower()


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and not v.strip())


def missing_fields(s: dict) -> list[str]:
    """Fields required before a record may leave draft state."""
    m = []
    if _blank(s.get("companyNameZh")) and _blank(s.get("companyNameEn")):
        m.append("company name")
    if _blank(s.get("contactName")):
        m.append("contact")
    # v1.7：联系方式不再是必填。现场很多摊位只留个姓名，硬填会造出假号码。
    if not s.get("categories"):
        m.append("category")
    if not s.get("photoIds"):
        m.append("photo")
    return m


def migrate_score(s: dict) -> dict:
    """六维老数据 → 三维新口径。补进去但不删原字段，老记录照样能溯源。"""
    sc = s.setdefault("score", {})
    if not isinstance(sc, dict):
        s["score"] = sc = {}
        return sc
    for new, old in LEGACY_SCORE_MAP.items():
        v = sc.get(new)
        if v is None and isinstance(sc.get(old), (int, float)):
            sc[new] = sc[old]
    return sc


def score_filled(s: dict) -> bool:
    sc = s.get("score") or {}
    return all(isinstance(sc.get(d[0]), (int, float)) for d in SCORE_DIMS)


def state_of(s: dict) -> str:
    """Draft wins over rated: a record missing mandatory fields is not usable."""
    if missing_fields(s):
        return "draft"
    return "rated" if score_filled(s) else "complete"


def weighted_score(s: dict, weights: dict) -> float | None:
    """0-100 scale, weights sum to 100. None when any dimension is missing."""
    if not score_filled(s):
        return None
    sc = s.get("score") or {}
    total = 0.0
    for d in SCORE_DIMS:
        total += float(weights.get(d[0], 0)) * (float(sc[d[0]]) / 5.0)
    return round(total, 1)


def tier_of(score: float | None) -> str:
    if score is None:
        return "Not rated"
    if score >= 80:
        return "Shortlist"
    if score >= 70:
        return "Follow-up"
    if score >= 60:
        return "Reserve"
    return "Low priority"


def compliance_blockers(s: dict) -> list[str]:
    comp = s.get("compliance") or {}
    out = []
    for code, zh, en in COMPLIANCE_ITEMS:
        st = (comp.get(code) or {}).get("status", "unknown")
        if st == "not_available":
            out.append(en)
    return out


def company_display(s: dict) -> str:
    en = str(s.get("companyNameEn") or "").strip()
    zh = str(s.get("companyNameZh") or "").strip()
    if en and zh:
        return f"{en} ({zh})"
    return en or zh or "(unnamed)"


def categories_en(s: dict) -> list[str]:
    return [CAT_EN.get(c, c) for c in (s.get("categories") or [])]


def markets_en(s: dict) -> list[str]:
    return [MARKETS.get(m, m) for m in (s.get("exportMarkets") or [])]


def price_text(s: dict) -> str:
    lo, hi = s.get("priceMin"), s.get("priceMax")
    cur = str(s.get("currency") or "").strip()
    unit = str(s.get("priceUnit") or "").strip()
    inco = str(s.get("incoterm") or "").strip()
    if _blank(lo) and _blank(hi):
        return "n/a"
    if _blank(hi) or hi == lo:
        amt = f"{cur} {lo}".strip()
    else:
        amt = f"{cur} {lo}–{hi}".strip()
    tail = " / ".join([p for p in (unit, inco if inco and inco != "Unknown" else "") if p])
    return f"{amt} {('per ' + tail) if tail else ''}".strip()


def price_key(s: dict) -> tuple:
    return (
        str(s.get("currency") or "").strip(),
        str(s.get("incoterm") or "").strip(),
        str(s.get("priceUnit") or "").strip(),
    )


def moq_text(s: dict) -> str:
    if _blank(s.get("moqValue")):
        return "n/a"
    return f"{s['moqValue']} {s.get('moqUnit') or ''}".strip()


def capacity_text(s: dict) -> str:
    if _blank(s.get("capacityValue")):
        return "n/a"
    return f"{s['capacityValue']} {s.get('capacityUnit') or ''}".strip()


def compliance_state_en(s: dict, code: str) -> str:
    st = ((s.get("compliance") or {}).get(code) or {}).get("status", "unknown")
    return CSTAT.get(st, (st, st))[1]


def cert_no(s: dict, code: str) -> str:
    return str(((s.get("compliance") or {}).get(code) or {}).get("certNo") or "").strip()


def followup_en(s: dict) -> str:
    return FOLLOWUPS.get(str(s.get("followUpStatus") or "new"), ("New", "New"))[1]


def source_en(s: dict) -> str:
    """How the record entered the system: planned visit / manual entry / walk-in."""
    return {"planned": "Planned", "manual": "Manual entry"}.get(s.get("source"), "Walk-in")


# --------------------------------------------------------------------------- #
# reading exports
# --------------------------------------------------------------------------- #
@dataclass
class Export:
    path: Path
    bundle: dict
    zf: zipfile.ZipFile
    issues: list[str] = field(default_factory=list)


@dataclass
class PhotoRef:
    photo_id: str
    supplier_id: str
    type: str
    zip_path: str
    sha256: str
    size: int
    created_at: str
    export: Export
    highlight_id: str = ""


def _safe_name(name: str) -> bool:
    if not name or name.startswith("/") or "\\" in name:
        return False
    parts = name.split("/")
    if any(p in ("..", "") for p in parts[:-1]):
        return False
    return parts[-1] != ""


def load_exports(inbox: Path, issues: list[str]) -> list[Export]:
    exports: list[Export] = []
    if not inbox.exists():
        inbox.mkdir(parents=True, exist_ok=True)
        return exports
    for zp in sorted(inbox.glob("*.zip")):
        try:
            zf = zipfile.ZipFile(zp)
        except zipfile.BadZipFile as e:
            issues.append(f"{zp.name}: not a readable ZIP ({e})")
            continue
        bad = zf.testzip()
        if bad:
            issues.append(f"{zp.name}: CRC failure in {bad}, file skipped")
            zf.close()
            continue
        try:
            raw = zf.read("suppliers.json")
        except KeyError:
            issues.append(f"{zp.name}: no suppliers.json inside, file skipped")
            zf.close()
            continue
        try:
            bundle = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            issues.append(f"{zp.name}: suppliers.json unreadable ({e}), file skipped")
            zf.close()
            continue
        got = int(bundle.get("schemaVersion", 0))
        if got == 0:
            issues.append(f"{zp.name}: no schemaVersion field, parsed anyway")
        elif got > SCHEMA_VERSION:
            issues.append(f"{zp.name}: schema v{got} is newer than this script (v{SCHEMA_VERSION}) "
                          "— update the scripts before trusting the output")
        unsafe = [n for n in zf.namelist() if not _safe_name(n)]
        if unsafe:
            issues.append(f"{zp.name}: ignored unsafe paths {unsafe[:3]}")
        exports.append(Export(path=zp, bundle=bundle, zf=zf))
    return exports


def _iso(v: Any) -> str:
    return str(v or "")


# --------------------------------------------------------------------------- 展会
UNKNOWN_FAIR = "_unknown"


def fair_id_of(s: dict) -> str:
    """老版本导出没有 fairId，统一归到 _unknown，保证旧数据仍能出报告。"""
    return str(s.get("fairId") or UNKNOWN_FAIR)


def collect_fair_meta(exports: list[Export]) -> dict[str, dict]:
    """fairId -> 展会元信息（同名展会以最新一次导出为准）。"""
    meta: dict[str, dict] = {}
    for ex in exports:
        f = ex.bundle.get("fair")
        if not isinstance(f, dict) or not f.get("id"):
            continue
        fid = str(f["id"])
        stamp = _iso((ex.bundle.get("export") or {}).get("createdAt"))
        prev = meta.get(fid)
        if prev is None or stamp >= _iso(prev.get("_stamp")):
            m = dict(f)
            m["_stamp"] = stamp
            meta[fid] = m
    return meta


def fair_dir_name(fid: str, meta: dict | None) -> str:
    """报告输出目录名：2026-140th-canton-fair-phase-ii"""
    meta = meta or {}
    base = str(meta.get("slug") or meta.get("nameEn") or meta.get("name") or "")
    if not base:
        base = fid if fid != UNKNOWN_FAIR else "unfiled"
    safe = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", base).strip("-").lower()
    if not safe:
        safe = "fair"
    year = str(meta.get("startDate") or "")[:4]
    if not year or safe.startswith(year):      # slug 里已带年份就别重复
        return safe
    return f"{year}-{safe}"


def fair_event(meta: dict | None) -> dict:
    meta = meta or {}
    dates = "..".join(x for x in (meta.get("startDate"), meta.get("endDate")) if x)
    venue = " · ".join(x for x in (meta.get("venue"), meta.get("city")) if x)
    # 不含 prepared_for：那是 config.json 的事，别让展会记录把它冲掉
    return {
        "name": meta.get("nameEn") or meta.get("name") or "Trade Fair",
        "phase": meta.get("phase") or "",
        "dates": dates,
        "venue": venue,
    }


def _filter_export(ex: Export, fid: str) -> Export:
    """把一份导出裁剪成只含某个展会的内容（记录 / 计划 / 照片）。"""
    b = ex.bundle
    nb = dict(b)
    nb["suppliers"] = [s for s in (b.get("suppliers") or []) if fair_id_of(s) == fid]
    nb["visitPlans"] = [p for p in (b.get("visitPlans") or [])
                        if str(p.get("fairId") or UNKNOWN_FAIR) == fid]
    ids = {s.get("id") for s in nb["suppliers"]}
    nb["photos"] = [p for p in (b.get("photos") or [])
                    if p.get("supplierId") in ids
                    or str(p.get("fairId") or UNKNOWN_FAIR) == fid]
    return Export(path=ex.path, bundle=nb, zf=ex.zf)


def merge_suppliers(exports: list[Export], issues: list[str]) -> tuple[list[dict], dict]:
    """Upsert by id (newest updatedAt wins), then apply deletion tombstones."""
    merged: dict[str, dict] = {}
    for ex in exports:
        for s in ex.bundle.get("suppliers") or []:
            sid = s.get("id")
            if not sid:
                issues.append(f"{ex.path.name}: supplier without id, skipped")
                continue
            cur = merged.get(sid)
            if cur is None or _iso(s.get("updatedAt")) > _iso(cur.get("updatedAt")):
                merged[sid] = dict(s)
    tombs = {k: v for k, v in merged.items() if v.get("deletedAt")}
    live = {k: v for k, v in merged.items() if not v.get("deletedAt")}
    return list(live.values()), tombs


def merge_plans(exports: list[Export]) -> list[dict]:
    merged: dict[str, dict] = {}
    for ex in exports:
        for p in ex.bundle.get("visitPlans") or []:
            pid = p.get("id")
            if not pid:
                continue
            cur = merged.get(pid)
            if cur is None or _iso(p.get("updatedAt")) > _iso(cur.get("updatedAt")):
                merged[pid] = dict(p)
    return [p for p in merged.values() if not p.get("deletedAt")]


def collect_photos(exports: list[Export], keep_ids: set[str]) -> dict[str, PhotoRef]:
    out: dict[str, PhotoRef] = {}
    for ex in exports:
        for meta in ex.bundle.get("photos") or []:
            pid, sid = meta.get("id"), meta.get("supplierId")
            if not pid or sid not in keep_ids:
                continue
            zp = meta.get("path") or f"photos/{sid}/{pid}.jpg"
            if not _safe_name(zp) or zp not in ex.zf.namelist():
                continue
            if pid in out and _iso(meta.get("createdAt")) <= _iso(out[pid].created_at):
                continue
            out[pid] = PhotoRef(
                photo_id=pid, supplier_id=sid, type=meta.get("type") or "other",
                zip_path=zp, sha256=str(meta.get("sha256") or ""), size=int(meta.get("size") or 0),
                created_at=_iso(meta.get("createdAt")), export=ex,
                highlight_id=str(meta.get("highlightId") or ""),
            )
    return out


def dedupe_business(suppliers: list[dict], issues: list[str]) -> tuple[list[dict], list[dict]]:
    """Cross-device duplicates: merge only when company+booth match and contact agrees."""
    def contact_fp(s: dict) -> str:
        vals = [str(s.get(k) or "").strip() for k in ("phone", "email", "wechat")]
        return "|".join(v for v in vals if v)

    groups: dict[tuple, list[dict]] = {}
    for s in suppliers:
        key = (norm_company(s.get("companyNameZh") or s.get("companyNameEn")), norm_booth(s.get("boothNo")))
        if not key[0]:
            continue
        groups.setdefault(key, []).append(s)

    keep: list[dict] = []
    candidates: list[dict] = []
    for key, grp in groups.items():
        if len(grp) == 1:
            keep.append(grp[0])
            continue
        fps = {contact_fp(s) for s in grp if contact_fp(s)}
        auto = len(fps) <= 1 and bool(key[1] or fps)
        if not auto:
            keep.extend(grp)
            candidates.append({
                "company": company_display(grp[0]), "booth": grp[0].get("boothNo"),
                "records": [{"id": s.get("id"), "contact": s.get("contactName"), "fp": contact_fp(s)} for s in grp],
                "reason": "same company+booth but contact details differ — review before merging",
            })
            continue
        canon = sorted(grp, key=lambda s: _iso(s.get("createdAt")))[0]
        for other in grp:
            if other is canon:
                continue
            for k, v in other.items():
                if k in ("id", "createdAt", "updatedAt", "photoIds", "score", "compliance"):
                    continue
                if _blank(canon.get(k)) and not _blank(v):
                    canon[k] = v
            for k in ("photoIds",):
                merged_ids = list(dict.fromkeys((canon.get(k) or []) + (other.get(k) or [])))
                canon[k] = merged_ids
            for dim in SCORE_DIMS:
                a = (canon.get("score") or {}).get(dim[0])
                b = (other.get("score") or {}).get(dim[0])
                if a is None and b is not None:
                    canon.setdefault("score", {})[dim[0]] = b
            for code, _, _ in COMPLIANCE_ITEMS:
                ca = (canon.get("compliance") or {}).get(code) or {}
                cb = (other.get("compliance") or {}).get(code) or {}
                if ca.get("status", "unknown") == "unknown" and cb.get("status") not in (None, "unknown"):
                    canon.setdefault("compliance", {})[code] = cb
            canon["updatedAt"] = max(_iso(canon.get("updatedAt")), _iso(other.get("updatedAt")))
        issues.append(
            f"merged {len(grp)} records for {company_display(canon)} (booth {canon.get('boothNo')}) into {canon.get('id')}"
        )
        keep.append(canon)
    return keep, candidates


# --------------------------------------------------------------------------- #
# photo materialisation
# --------------------------------------------------------------------------- #
def materialise_photos(
    photos: dict[str, PhotoRef], out_root: Path
) -> tuple[dict[str, dict[str, str]], list[str]]:
    from PIL import Image, ImageOps

    issues: list[str] = []
    photo_dir = out_root / "photos"
    thumb_dir = out_root / "thumbnails"
    photo_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, dict[str, str]] = {}
    for pid, ref in photos.items():
        try:
            data = ref.export.zf.read(ref.zip_path)
        except KeyError:
            issues.append(f"photo {pid}: missing inside {ref.export.path.name}")
            continue
        digest = hashlib.sha256(data).hexdigest()
        if ref.sha256 and digest != ref.sha256:
            issues.append(f"photo {pid}: sha256 mismatch (declared {ref.sha256[:12]}…, actual {digest[:12]}…)")
        if ref.size and abs(ref.size - len(data)) > 2:
            issues.append(f"photo {pid}: size mismatch (declared {ref.size}, actual {len(data)})")
        dst = photo_dir / f"{pid}.jpg"
        dst.write_bytes(data)
        entry = {"file": str(dst), "id": pid, "type": ref.type, "supplierId": ref.supplier_id,
                 "highlightId": ref.highlight_id}
        try:
            with Image.open(dst) as im:
                im = ImageOps.exif_transpose(im)
                im = im.convert("RGB")
                # report 900/Q78 与手机端一致；excel 只进工作簿缩略图，小一点足够
                for tag, maxside, qual in (("report", 900, 78), ("excel", 160, 72)):
                    c = im.copy()
                    c.thumbnail((maxside, maxside), Image.LANCZOS)
                    p = thumb_dir / f"{pid}_{tag}.jpg"
                    c.save(p, "JPEG", quality=int(qual), optimize=True, progressive=True)
                    entry[tag] = str(p)
        except Exception as e:  # noqa: BLE001 - keep the pipeline alive
            issues.append(f"photo {pid}: thumbnail failed ({e})")
        result[pid] = entry
    return result, issues


# --------------------------------------------------------------------------- #
# assembly
# --------------------------------------------------------------------------- #
@dataclass
class Context:
    suppliers: list[dict]
    plans: list[dict]
    photo_index: dict[str, dict[str, str]]
    photos_by_supplier: dict[str, list[dict]]
    weights: dict
    issues: list[str]
    exports: list[dict]
    top_n: int
    event: dict
    summary: str
    generated_at: str


def build_context(inbox: Path, out_root: Path, top_n: int = 5,
                  event_override: dict | None = None,
                  fair_id: str | None = None,
                  fair_meta: dict | None = None) -> Context:
    """单展会上下文。fair_id 为 None 时把 inbox 里所有展会混在一起（兼容旧行为）。"""
    issues: list[str] = []
    exports = load_exports(inbox, issues)
    if fair_id is not None:
        exports = [_filter_export(ex, fair_id) for ex in exports]
        meta = fair_meta if fair_meta is not None else collect_fair_meta(exports).get(fair_id) or {}
    else:
        meta = fair_meta or {}
    return build_fair_context(exports, out_root, top_n, event_override, meta, issues)


def build_fair_context(exports: list[Export], out_root: Path, top_n: int,
                       event_override: dict | None, fair_meta: dict,
                       issues: list[str]) -> Context:
    suppliers, tombs = merge_suppliers(exports, issues)
    suppliers, candidates = dedupe_business(suppliers, issues)
    plans = merge_plans(exports)

    weights = dict(DEFAULT_WEIGHTS)
    for ex in exports:
        w = (ex.bundle.get("export") or {}).get("weights")
        if isinstance(w, dict) and all(isinstance(w.get(d[0]), (int, float)) for d in SCORE_DIMS):
            weights = {d[0]: float(w[d[0]]) for d in SCORE_DIMS}
    if abs(sum(weights.values()) - 100) > 0.01:
        issues.append(f"exported weights sum to {sum(weights.values())} (expected 100); using defaults")
        weights = dict(DEFAULT_WEIGHTS)

    keep_ids = {s["id"] for s in suppliers}
    # 照片可能缺 supplierId（老数据 / 早期导入）。用厂家自己记录的 photoIds 反查归属，
    # 否则手机里显示的照片数会大于报告里出现的照片数。
    owner_of: dict[str, str] = {}
    for s in suppliers:
        for pid in (s.get("photoIds") or []):
            owner_of[str(pid)] = s["id"]
    for ex in exports:
        for meta in ex.bundle.get("photos") or []:
            if not meta.get("supplierId") and str(meta.get("id")) in owner_of:
                meta["supplierId"] = owner_of[str(meta.get("id"))]
    photos = collect_photos(exports, keep_ids)
    photo_index, pissues = materialise_photos(photos, out_root)
    issues.extend(pissues)

    photos_by_supplier: dict[str, list[dict]] = {}
    for pid, entry in photo_index.items():
        photos_by_supplier.setdefault(entry["supplierId"], []).append(entry)
    order = {"product": 0, "booth": 1, "certificate": 2, "namecard": 3, "other": 4}
    for sid, lst in photos_by_supplier.items():
        lst.sort(key=lambda e: (order.get(e.get("type"), 9), e.get("id", "")))

    for s in suppliers:
        migrate_score(s)          # 老六维记录折算到 Design / Quality / Details
        s["_state"] = state_of(s)
        s["_missing"] = missing_fields(s)
        s["_score"] = weighted_score(s, weights)
        # Only complete + fully rated records may drive the ranking.
        s["_rankable"] = s["_state"] == "rated"
        s["_tier"] = tier_of(s["_score"]) if s["_rankable"] else "Not ranked"
        s["_blockers"] = compliance_blockers(s)
        s["_photoCount"] = len(photos_by_supplier.get(s["id"], []))
        s["_company"] = company_display(s)

    def sort_key(s: dict):
        comp = (s.get("score") or {}).get("compliance") or 0
        fit = (s.get("score") or {}).get("fit") or 0
        sc = s["_score"]
        return (0 if s["_rankable"] else 1, -(sc if sc is not None else -1),
                -float(comp), -float(fit), s["_company"])

    suppliers.sort(key=sort_key)

    # 抬头优先级：手机端展会记录 > config.json > 中性默认值。
    # 注意顺序：config 先落地（提供 prepared_for 这类通用字段），
    # 展会自带的 name/phase/dates/venue 再覆盖它——否则多展会时会被 config 串味。
    event = {
        "name": "Trade Fair", "phase": "", "dates": "", "venue": "",
        "prepared_for": "Sourcing team",
    }
    if isinstance(event_override, dict):
        event.update({k: v for k, v in event_override.items() if v})
    event.update({k: v for k, v in fair_event(fair_meta).items() if v})
    for ex in exports:
        ev = (ex.bundle.get("export") or {}).get("event")
        if isinstance(ev, dict):
            if not event.get("dates") and ev.get("dates"):
                event["dates"] = ev["dates"]
            if not event.get("name") and ev.get("name"):
                event["name"] = ev["name"]

    ctx = Context(
        suppliers=suppliers, plans=plans, photo_index=photo_index,
        photos_by_supplier=photos_by_supplier, weights=weights, issues=issues,
        exports=[{"file": ex.path.name, "counts": (ex.bundle.get("export") or {}).get("counts", {}),
                  "createdAt": (ex.bundle.get("export") or {}).get("createdAt")} for ex in exports],
        top_n=top_n, event=event, summary=str((fair_meta or {}).get("summary") or ""),
        generated_at=datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
    )
    ctx.duplicate_candidates = candidates  # type: ignore[attr-defined]
    ctx.tombstones = len(tombs)  # type: ignore[attr-defined]
    ctx.fair = dict(fair_meta or {})  # type: ignore[attr-defined]
    ctx.fair_id = str((fair_meta or {}).get("id") or UNKNOWN_FAIR)  # type: ignore[attr-defined]
    ctx.fair_dir = fair_dir_name(ctx.fair_id, fair_meta)  # type: ignore[attr-defined]
    return ctx


def build_all_contexts(inbox: Path, out_root: Path, top_n: int = 5,
                       event_override: dict | None = None,
                       only_fair: str | None = None) -> tuple[list[Context], list[str]]:
    """按展会拆分成多份上下文，每份一个输出子目录。

    only_fair 可填展会 id、输出目录名或 slug，只出该展会；None = 全部。
    """
    global_issues: list[str] = []
    exports = load_exports(inbox, global_issues)
    fmeta = collect_fair_meta(exports)

    order: list[str] = []
    for ex in exports:
        for s in ex.bundle.get("suppliers") or []:
            fid = fair_id_of(s)
            if fid not in order:
                order.append(fid)
    if not order:
        order = [UNKNOWN_FAIR]

    if only_fair:
        key = str(only_fair).lower()

        def matches(fid: str) -> bool:
            meta = fmeta.get(fid) or {}
            hay = " ".join(str(x or "").lower() for x in (
                fid, fair_dir_name(fid, meta), meta.get("slug"),
                meta.get("name"), meta.get("nameEn")))
            return key == fid.lower() or key in hay

        order = [f for f in order if matches(f)]
        if not order:
            global_issues.append(f"no fair matched --fair {only_fair!r}")

    contexts: list[Context] = []
    for fid in order:
        meta = fmeta.get(fid) or {}
        sub = out_root / fair_dir_name(fid, meta)
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "data").mkdir(parents=True, exist_ok=True)
        sub_exports = [_filter_export(ex, fid) for ex in exports]
        issues: list[str] = []
        ctx = build_fair_context(sub_exports, sub, top_n, event_override, meta, issues)
        ctx.fair_id = fid  # type: ignore[attr-defined]
        ctx.fair = meta    # type: ignore[attr-defined]
        ctx.fair_dir = fair_dir_name(fid, meta)  # type: ignore[attr-defined]
        contexts.append(ctx)

    contexts.sort(key=lambda c: (str((c.fair or {}).get("startDate") or "9"), c.fair_dir))  # type: ignore[attr-defined]
    return contexts, global_issues


def grouped_by_category(ctx: Context) -> list[tuple[str, str, list[dict]]]:
    buckets: dict[str, list[dict]] = {}
    for s in ctx.suppliers:
        cats = s.get("categories") or ["other"]
        for c in cats:
            buckets.setdefault(c, []).append(s)
    order = {code: i for i, (code, _zh, _en) in enumerate(CATEGORIES)}
    out = []
    for code, items in buckets.items():
        uniq = list({s["id"]: s for s in items}.values())
        uniq.sort(key=lambda s: (0 if s["_rankable"] else 1,
                                 -(s["_score"] if s["_score"] is not None else -1), s["_company"]))
        out.append((code, CAT_EN.get(code, code), uniq))
    # 数量多的组在前；数量相同按 CATEGORIES 表顺序。
    # 只按数量排会让同数量的组保持录入顺序，手机端（app/report.js 的 grouped()）
    # 却按品类表排，两个通道的章节顺序就对不上了。
    out.sort(key=lambda t: (-len(t[2]), order.get(t[0], 99)))
    return out


def photo_buckets(ctx: "Context", sid: str) -> tuple[list[dict], dict[str, list[dict]], list[dict]]:
    """一个厂家的照片分三处：名片、各条亮点产品、其余进画廊。

    混在一起时报告读起来只是照片堆叠，看不出哪张对应哪个亮点。
    """
    cards: list[dict] = []
    gallery: list[dict] = []
    by_hl: dict[str, list[dict]] = {}
    for p in ctx.photos_by_supplier.get(sid) or []:
        if p.get("type") == "namecard":
            cards.append(p)
        elif p.get("highlightId"):
            by_hl.setdefault(str(p["highlightId"]), []).append(p)
        else:
            gallery.append(p)
    return cards, by_hl, gallery


def top_picks(ctx: "Context") -> list[dict]:
    rated = [s for s in ctx.suppliers if s["_rankable"] and s["_score"] is not None]
    rated.sort(key=lambda s: (-s["_score"], -(s.get("score", {}).get("compliance") or 0), s["_company"]))
    return rated[: ctx.top_n]


def recommendation_text(s: dict) -> str:
    """Templated first draft — factual only, derived from recorded scores."""
    bits = [f"Weighted score {s['_score']}/100 ({s['_tier']})."]
    dims = {d[0]: d[2] for d in SCORE_DIMS}
    sc = s.get("score") or {}
    strong = [dims[k] for k, v in sc.items() if isinstance(v, (int, float)) and v >= 4]
    weak = [dims[k] for k, v in sc.items() if isinstance(v, (int, float)) and v <= 2]
    if strong:
        bits.append("Strong on " + ", ".join(strong) + ".")
    if weak:
        bits.append("Weak on " + ", ".join(weak) + ".")
    if s["_blockers"]:
        bits.append(
            "Key compliance item(s) recorded as not available: " + ", ".join(s["_blockers"]) +
            " — shortlist only conditionally, subject to documentary verification."
        )
    else:
        bits.append("No compliance item was marked unavailable; certificates still to be collected and verified.")
    return " ".join(bits)


def highlights(s: dict) -> list[dict]:
    """亮点产品：每条一个标题 + 一段说明 + 若干照片（照片靠 highlightId 反查）。"""
    out = []
    for it in (s.get("highlights") or []):
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        note = str(it.get("note") or "").strip()
        if not title and not note:
            continue
        out.append({"id": str(it.get("id") or ""), "title": title, "note": note})
    return out


def namecard_rows(s: dict) -> list[tuple[str, str]]:
    """名片信息：只返回真正填了的字段。"""
    nc = s.get("namecard") or {}
    return [(en, str(nc.get(code) or "").strip())
            for code, en in NAMECARD_FIELDS if str(nc.get(code) or "").strip()]


def score_comments(s: dict) -> dict[str, str]:
    """每项评分后面的 Comments。"""
    sn = s.get("scoreNotes") or {}
    return {d[0]: str(sn.get(d[0]) or "").strip() for d in SCORE_DIMS}


def summary_paras(text: Any) -> list[str]:
    """观展总结按空行切段——报告最后一项就是原样输出这些段落。"""
    return [p.strip() for p in re.split(r"\n\s*\n", str(text or "").replace("\r", "")) if p.strip()]


def e(text: Any) -> str:
    return html.escape(str(text if text is not None else ""), quote=True)

"""FairRecorder — one command from phone exports to HQ-ready deliverables.

Usage:
  <venv>/Scripts/python.exe scripts/build_report.py \
      --inbox  C:/Users/Leo/WorkBuddy/FairRecorder/inbox \
      --output C:/Users/Leo/WorkBuddy/FairRecorder/output --top 5
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fairlib as F  # noqa: E402

from openpyxl import Workbook  # noqa: E402
from openpyxl.drawing.image import Image as XLImage  # noqa: E402
from openpyxl.styles import Alignment, Font, PatternFill  # noqa: E402
from openpyxl.utils import get_column_letter  # noqa: E402

HDR_FILL = PatternFill("solid", fgColor="123A5E")
HDR_FONT = Font(color="FFFFFF", bold=True, size=10)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _sanitize_sheet(name: str) -> str:
    n = F.XLSX_SHEET_BAD.sub("-", name)
    return (n[:28] + "…") if len(n) > 31 else (n or "Sheet")


def _style_header(ws, widths: list[int], freeze: str = "A2"):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    for c in ws[1]:
        c.fill = HDR_FILL
        c.font = HDR_FONT
        c.alignment = Alignment(vertical="center", wrap_text=True)
    ws.freeze_panes = freeze
    if ws.max_row > 1:
        ws.auto_filter.ref = f"A1:{get_column_letter(ws.max_column)}{ws.max_row}"


def _b64_image(path_str: str, max_side: int = 640) -> str:
    try:
        from PIL import Image, ImageOps
        with Image.open(path_str) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((max_side, max_side))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=80, optimize=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:  # noqa: BLE001
        return ""


def _photo_pick(ctx: F.Context, sid: str, n: int = 2) -> list[dict]:
    """n <= 0 表示不限张数（报告里照片不再截断）。"""
    lst = ctx.photos_by_supplier.get(sid) or []
    return lst if n <= 0 else lst[:n]


# --------------------------------------------------------------------------- #
# Supplier_Master.xlsx
# --------------------------------------------------------------------------- #
def write_master_xlsx(ctx: F.Context, path: Path) -> None:
    wb = Workbook()

    # --- Suppliers -------------------------------------------------------- #
    ws = wb.active
    ws.title = "Suppliers"
    cols = [
        ("Company (EN / ZH)", 34), ("Company ZH", 26), ("Booth", 14), ("Hall / Area", 16),
        ("Source", 12), ("Contact", 14), ("Title", 14), ("Phone", 16), ("WeChat", 16),
        ("Email", 24), ("Website", 22), ("Categories", 26), ("Product / highlights", 34),
        ("Models", 16), ("MOQ", 16), ("Price", 22), ("Incoterm", 10), ("Lead time (d)", 12),
        ("Capacity", 18), ("Export markets", 24), ("EU / DE experience", 16),
        ("Total score", 11), ("Tier", 13), ("fit", 6), ("compliance", 11), ("quality", 8),
        ("price", 6), ("capacity", 9), ("communication", 13), ("State", 10),
        ("Missing", 24), ("Compliance gaps", 22), ("Follow-up", 13), ("Next action", 26),
        ("Due", 12), ("Notes", 40), ("Photos", 8), ("Last updated", 19),
    ]
    ws.append([c[0] for c in cols])
    for s in ctx.suppliers:
        sc = s.get("score") or {}
        ws.append([
            s["_company"], s.get("companyNameZh", ""), s.get("boothNo", ""),
            " / ".join(x for x in (s.get("hall"), s.get("area")) if x),
            F.source_en(s),
            s.get("contactName", ""), s.get("contactTitle", ""), s.get("phone", ""),
            s.get("wechat", ""), s.get("email", ""), s.get("website", ""),
            ", ".join(F.categories_en(s)), s.get("productDetails", ""), s.get("models", ""),
            F.moq_text(s), F.price_text(s), s.get("incoterm", ""), s.get("leadTimeDays"),
            F.capacity_text(s), ", ".join(F.markets_en(s)), s.get("euGermanyExperience", ""),
            s["_score"] if s["_rankable"] else "not ranked", s["_tier"], sc.get("fit"), sc.get("compliance"), sc.get("quality"),
            sc.get("price"), sc.get("capacity"), sc.get("communication"),
            s["_state"], ", ".join(s["_missing"]), ", ".join(s["_blockers"]) or "none recorded",
            F.followup_en(s), s.get("nextAction", ""), s.get("nextActionDate", ""),
            s.get("notes", ""), s["_photoCount"], s.get("updatedAt", ""),
        ])
    _style_header(ws, [c[1] for c in cols], "C2")
    for r in range(2, ws.max_row + 1):
        ws.row_dimensions[r].height = 20

    # --- Compliance ------------------------------------------------------- #
    ws2 = wb.create_sheet("Compliance")
    head = ["Company"] + [c[2] for c in F.COMPLIANCE_ITEMS] + ["Certificate numbers", "Open gaps"]
    ws2.append(head)
    for s in ctx.suppliers:
        certs = "; ".join(
            f"{c[2]}: {F.cert_no(s, c[0])}" for c in F.COMPLIANCE_ITEMS if F.cert_no(s, c[0])
        )
        ws2.append([s["_company"]] + [F.compliance_state_en(s, c[0]) for c in F.COMPLIANCE_ITEMS]
                   + [certs, ", ".join(s["_blockers"]) or "none"])
    _style_header(ws2, [34] + [16] * len(F.COMPLIANCE_ITEMS) + [40, 26])

    # --- Photos ------------------------------------------------------------ #
    ws3 = wb.create_sheet("Photos")
    ws3.append(["Photo file", "Company", "Type", "Size (KB)", "SHA-256 (12)", "Report image", "Excel thumb"])
    for s in ctx.suppliers:
        for p in ctx.photos_by_supplier.get(s["id"], []):
            size_kb = ""
            try:
                size_kb = round(Path(p["file"]).stat().st_size / 1024, 1)
            except OSError:
                pass
            ws3.append([Path(p["file"]).name, s["_company"],
                        F.PHOTO_TYPES.get(p.get("type"), ("other", "Other"))[1], size_kb,
                        p.get("id", "")[:12], p.get("report", ""), p.get("excel", "")])
    _style_header(ws3, [30, 34, 14, 10, 16, 46, 46])

    # --- Unvisited plans ---------------------------------------------------- #
    ws4 = wb.create_sheet("Unvisited_Plans")
    ws4.append(["Company", "Booth", "Goal", "Priority", "Status", "Note"])
    for p in ctx.plans:
        if p.get("status") == "visited":
            continue
        ws4.append([p.get("companyName", ""), p.get("boothNo", ""), p.get("goal", ""),
                    p.get("priority", ""), p.get("status", ""), p.get("note", "")])
    if ws4.max_row == 1:
        ws4.append(["(none)", "", "", "", "", ""])
    _style_header(ws4, [34, 14, 34, 10, 12, 34])

    # --- Data quality ------------------------------------------------------- #
    ws5 = wb.create_sheet("Data_Quality")
    ws5.append(["Company", "State", "Missing fields", "Photos", "Score", "Last updated", "Device note"])
    for s in ctx.suppliers:
        ws5.append([s["_company"], s["_state"], ", ".join(s["_missing"]) or "-",
                    s["_photoCount"], s["_score"] if s["_score"] is not None else "not rated",
                    s.get("updatedAt", ""),
                    "draft — complete before sharing" if s["_state"] == "draft" else ""])
    _style_header(ws5, [34, 12, 34, 8, 10, 20, 30])

    # --- Photos preview (thumbnails embedded) ------------------------------- #
    ws6 = wb.create_sheet("Photo_Preview")
    ws6.append(["Company", "Booth", "Photo", "Type"])
    row = 2
    for s in ctx.suppliers:
        phs = ctx.photos_by_supplier.get(s["id"]) or []
        if not phs:
            ws6.cell(row=row, column=1, value=s["_company"])
            ws6.cell(row=row, column=2, value=s.get("boothNo", ""))
            ws6.cell(row=row, column=4, value="no photo")
            row += 1
            continue
        for p in phs:
            ws6.cell(row=row, column=1, value=s["_company"])
            ws6.cell(row=row, column=2, value=s.get("boothNo", ""))
            ws6.cell(row=row, column=4, value=F.PHOTO_TYPES.get(p.get("type"), ("other", "Other"))[1])
            thumb = p.get("excel")
            if thumb and Path(thumb).exists():
                try:
                    img = XLImage(thumb)
                    img.width, img.height = 120, 90
                    ws6.add_image(img, f"C{row}")
                except Exception:  # noqa: BLE001
                    ws6.cell(row=row, column=3, value="(preview failed)")
            ws6.row_dimensions[row].height = 70
            row += 1
    _style_header(ws6, [34, 14, 18, 14])

    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)


# --------------------------------------------------------------------------- #
# Category_Comparison.xlsx
# --------------------------------------------------------------------------- #
def write_comparison_xlsx(ctx: F.Context, path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Overview"
    ws.append(["Category", "Suppliers", "Rated", "Avg score", "Top supplier", "Top score", "Price comparability"])
    for code, name, items in F.grouped_by_category(ctx):
        rated = [s for s in items if s["_rankable"]]
        avg = round(sum(s["_score"] for s in rated) / len(rated), 1) if rated else ""
        keys = {F.price_key(s) for s in items if F.price_text(s) != "n/a"}
        comp = "Comparable" if len(keys) <= 1 else "Not directly comparable (mixed currency / Incoterm / unit)"
        top = items[0] if items else None
        ws.append([name, len(items), len(rated), avg,
                   top["_company"] if top else "", top["_score"] if top else "", comp])
    _style_header(ws, [34, 12, 10, 12, 34, 12, 52])

    dim_cols = [d[2] for d in F.SCORE_DIMS]
    for code, name, items in F.grouped_by_category(ctx):
        sh = wb.create_sheet(_sanitize_sheet(name))
        head = (["Company", "Booth", "Contact", "MOQ", "Price", "Lead time (d)", "Capacity",
                 "EU / DE exp"] + [c[2] for c in F.COMPLIANCE_ITEMS] + dim_cols +
                ["Total", "Tier", "Follow-up", "Next action"])
        sh.append(head)
        for s in items:
            sc = s.get("score") or {}
            row = [s["_company"], s.get("boothNo", ""), s.get("contactName", ""),
                   F.moq_text(s), F.price_text(s), s.get("leadTimeDays"), F.capacity_text(s),
                   s.get("euGermanyExperience", "")]
            row += [F.compliance_state_en(s, c[0]) for c in F.COMPLIANCE_ITEMS]
            row += [sc.get(d[0]) for d in F.SCORE_DIMS]
            row += [s["_score"] if s["_score"] is not None else "not rated", s["_tier"],
                    F.followup_en(s), s.get("nextAction", "")]
            sh.append(row)
        _style_header(sh, [32, 12, 14, 14, 20, 12, 16, 12] + [15] * len(F.COMPLIANCE_ITEMS)
                      + [11] * len(dim_cols) + [10, 13, 13, 28])
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)


# --------------------------------------------------------------------------- #
# HTML report
# --------------------------------------------------------------------------- #
# Schulte 品牌配色：深蓝 #1F1FAF + 白 + 浅蓝灰底纹（与 app/report.js 保持一致）
CSS = """
:root{--bg:#F5F6FA;--card:#FFFFFF;--line:#D5DAEC;--txt:#101529;--mut:#5C6480;--acc:#1F1FAF;
 --soft:#EEF0FC;--soft2:#F5F6FA}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
 font:16px/1.6 -apple-system,"Segoe UI",Helvetica,Arial,"PingFang SC",sans-serif;
 -webkit-text-size-adjust:100%}
.wrap{max-width:1000px;margin:0 auto;padding:32px 24px 80px}
h1{font-size:28px;margin:0 0 6px;color:var(--acc);letter-spacing:-.3px}
h2{font-size:21px;margin:38px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--acc)}
h3{font-size:17px;margin:22px 0 8px}
.sub{color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:14px;margin:10px 0}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:var(--acc);color:#fff;font-weight:600}
tbody tr:nth-child(even) td{background:var(--soft2)}
.kv{display:flex;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv .k{color:var(--mut);min-width:170px;flex:0 0 auto}
.grid{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.grid img{width:240px;height:180px;object-fit:cover;border-radius:10px;border:1px solid var(--line);
 cursor:zoom-in;background:var(--soft2)}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;margin-right:6px}
.b-short{background:#E6F6EE;color:#0F6B45}.b-follow{background:var(--soft);color:var(--acc)}
.b-res{background:#FFF7E6;color:#8A5300}.b-low{background:#FDECEC;color:#B3261E}
.b-draft{background:#FDECEC;color:#B3261E}
.warn{background:#FFF7E6;border:1px solid #F2D194;color:#8A5300;border-radius:12px;padding:12px 14px;margin:10px 0;font-size:14px}
.mut{color:var(--mut)}.small{font-size:13px}
#lb{position:fixed;inset:0;z-index:300;background:rgba(10,14,30,.94);display:none;
 align-items:center;justify-content:center;touch-action:none}
#lb.on{display:flex}
#lb .stage{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;overflow:hidden}
#lbImg{max-width:100%;max-height:100%;object-fit:contain;transition:transform .18s ease-out;will-change:transform}
#lb.zoomed #lbImg{transform:scale(2.2)}
.lbbtn{position:absolute;z-index:2;background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.35);
 border-radius:999px;width:46px;height:46px;font-size:24px;display:flex;align-items:center;justify-content:center}
.lbclose{top:calc(12px + env(safe-area-inset-top,0px));right:14px}
.lbprev{left:14px;top:50%;margin-top:-23px}
.lbnext{right:14px;top:50%;margin-top:-23px}
.lbcount{position:absolute;bottom:calc(24px + env(safe-area-inset-bottom,0px));left:0;right:0;text-align:center;
 color:#fff;font-size:14px;font-weight:600}
.lbhint{position:absolute;bottom:calc(6px + env(safe-area-inset-bottom,0px));left:0;right:0;text-align:center;
 color:rgba(255,255,255,.6);font-size:12px}
@media (max-width:420px){.grid img{width:160px;height:120px}.lbbtn{width:42px;height:42px;font-size:22px}}
@media print{body{background:#fff;color:#000}.card{border-color:#bbb}th{background:#E8EAF7;color:#000}
 #lb{display:none}}
"""

# 照片点开看大图：双击放大、左右滑动切换、点空白处关闭（与 app/report.js 同一份逻辑）
LIGHTBOX_JS = """
(function(){
  var imgs=[].slice.call(document.querySelectorAll('.grid img'));
  if(!imgs.length) return;
  var idx=0, lastTap=0, sx=0, sy=0, moved=false, swiping=false;
  var lb=document.createElement('div'); lb.id='lb';
  lb.innerHTML="<div class='stage' id='lbStage'><img id='lbImg' alt=''>"+
    "<button class='lbbtn lbprev' aria-label='Previous'>\\u2039</button>"+
    "<button class='lbbtn lbnext' aria-label='Next'>\\u203a</button>"+
    "<button class='lbbtn lbclose' aria-label='Close'>\\u2715</button>"+
    "<div class='lbcount'></div><div class='lbhint'>Tap to close · double-tap to zoom · swipe for next</div></div>";
  document.body.appendChild(lb);
  var im=document.getElementById('lbImg'), cnt=lb.querySelector('.lbcount'),
      stage=document.getElementById('lbStage');
  function show(i){
    idx=(i+imgs.length)%imgs.length;
    im.src=imgs[idx].getAttribute('src');
    lb.classList.remove('zoomed');
    cnt.textContent=(idx+1)+' / '+imgs.length;
  }
  function open(i){ show(i); lb.classList.add('on'); }
  function close(){ lb.classList.remove('on'); lb.classList.remove('zoomed'); }
  imgs.forEach(function(el,k){ el.addEventListener('click',function(){ open(k); }); });
  lb.querySelector('.lbclose').addEventListener('click',function(e){ e.stopPropagation(); close(); });
  lb.querySelector('.lbprev').addEventListener('click',function(e){ e.stopPropagation(); show(idx-1); });
  lb.querySelector('.lbnext').addEventListener('click',function(e){ e.stopPropagation(); show(idx+1); });
  lb.addEventListener('click',function(e){ if(e.target===lb||e.target===stage){ close(); } });
  document.addEventListener('keydown',function(e){
    if(!lb.classList.contains('on')) return;
    if(e.key==='Escape') close();
    else if(e.key==='ArrowLeft') show(idx-1);
    else if(e.key==='ArrowRight') show(idx+1);
  });
  lb.addEventListener('pointerdown',function(e){ sx=e.clientX; sy=e.clientY; moved=false; swiping=true; });
  lb.addEventListener('pointermove',function(e){
    if(!swiping) return;
    if(Math.abs(e.clientX-sx)>10||Math.abs(e.clientY-sy)>10) moved=true;
  });
  lb.addEventListener('pointerup',function(e){
    swiping=false;
    if(!moved){
      var now=Date.now();
      if(now-lastTap<320){ lb.classList.toggle('zoomed'); lastTap=0; }
      else { lastTap=now; if(e.target===lb||e.target===stage) close(); }
      return;
    }
    var dx=e.clientX-sx, dy=e.clientY-sy;
    if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)) show(idx+(dx<0?1:-1));
  });
})();
"""


def write_html(ctx: F.Context, path: Path) -> None:
    ev = ctx.event
    total = len(ctx.suppliers)
    rated = [s for s in ctx.suppliers if s["_rankable"]]
    drafts = [s for s in ctx.suppliers if s["_state"] == "draft"]
    planned = [s for s in ctx.suppliers if s.get("source") == "planned"]
    walkin = [s for s in ctx.suppliers if s.get("source") == "walk_in"]
    manual = [s for s in ctx.suppliers if s.get("source") == "manual"]
    picks = F.top_picks(ctx)
    unvisited = [p for p in ctx.plans if p.get("status") != "visited"]

    h = [f"<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>",
         f"<title>Supplier Report — {F.e(ev['name'])}</title><style>{CSS}</style></head><body><div class='wrap'>"]

    # Cover
    h.append(f"<h1>Supplier Report — {F.e(ev['name'])}</h1>")
    h.append(f"<div class='sub'>{F.e(ev['phase'])} · {F.e(ev['dates'])} · {F.e(ev['venue'])}</div>")
    h.append(f"<div class='sub' style='margin-top:8px'>Prepared for: {F.e(ev['prepared_for'])} · "
             f"Generated {F.e(ctx.generated_at)}</div>")

    # Executive summary
    h.append("<h2>1. Executive Summary</h2>")
    h.append(f"<div class='card'>"
             f"<div class='kv'><span class='k'>Suppliers recorded</span><span>{total}</span></div>"
             f"<div class='kv'><span class='k'>Fully rated</span><span>{len(rated)}</span></div></div>")
    # 列出所有厂家（不止 Top N）：已评分的在前，未评分的排最后
    ranking = sorted(ctx.suppliers,
                     key=lambda s: (-(s["_score"] if s["_score"] is not None else -1), s["_company"]))
    if ranking:
        h.append("<h3>Top recommendations — all suppliers</h3><table><tr><th>#</th><th>Supplier</th><th>Booth</th>"
                 "<th>Categories</th><th>Score</th><th>Tier</th></tr>")
        for i, s in enumerate(ranking, 1):
            score = s["_score"] if s["_score"] is not None else "not ranked"
            h.append(f"<tr><td>{i}</td><td>{F.e(s['_company'])}</td><td>{F.e(s.get('boothNo',''))}</td>"
                     f"<td>{F.e(', '.join(F.categories_en(s)))}</td><td>{F.e(score)}</td><td>{F.e(s['_tier'])}</td></tr>")
        h.append("</table>")
    risks = [s for s in ctx.suppliers if s["_blockers"]]
    if risks:
        h.append(f"<div class='warn'><b>{len(risks)} supplier(s)</b> recorded a key compliance item as "
                 f"not available. They can only be shortlisted conditionally, subject to documentary verification.</div>")

    # Methodology
    h.append("<h2>2. Scope &amp; Methodology</h2><div class='card'>")
    h.append("<h3>Scoring weights</h3><table><tr><th>Dimension</th><th>Weight</th><th>Meaning of 1 / 5</th></tr>")
    meaning = {
        "fit": "Clearly off-target / Strong match with the sourcing programme",
        "compliance": "No evidence / Key documents complete and verifiable",
        "quality": "High process risk / Mature QA, traceability and inspection",
        "price": "Clearly overpriced / Clear advantage on a like-for-like basis",
        "capacity": "Cannot meet demand / Comfortable capacity and lead-time headroom",
        "communication": "Poor responsiveness / Strong technical dialogue and cooperation",
    }
    for code, zh, en in F.SCORE_DIMS:
        h.append(f"<tr><td>{F.e(en)}</td><td>{F.e(ctx.weights.get(code,0))}%</td><td>{F.e(meaning.get(code,''))}</td></tr>")
    h.append("</table>")
    h.append("</div>")

    # Catalogue
    h.append("<h2>3. Supplier Catalogue</h2>")
    for code, name, items in F.grouped_by_category(ctx):
        h.append(f"<h3>{F.e(name)} — {len(items)} supplier(s)</h3>")
        for s in items:
            cls = "b-short" if s["_tier"] == "Shortlist" else "b-follow" if s["_tier"] == "Follow-up" \
                else "b-res" if s["_tier"] == "Reserve" else "b-low" if s["_tier"] == "Low priority" else "b-draft"
            h.append("<div class='card'>")
            h.append(f"<div style='font-size:18px;font-weight:700'>{F.e(s['_company'])} "
                     f"<span class='badge {cls}'>{F.e(s['_tier'])}"
                     f"{(' · ' + str(s['_score'])) if s['_score'] is not None else ''}</span>"
                     f"<span class='badge b-follow'>{F.e(F.source_en(s))}</span></div>")
            h.append(f"<div class='kv'><span class='k'>Booth</span><span>{F.e(' / '.join(x for x in (s.get('hall'), s.get('area'), s.get('boothNo')) if x)) or '—'}</span></div>")
            h.append(f"<div class='kv'><span class='k'>Contact</span><span>"
                     f"{F.e(' / '.join(x for x in (s.get('contactName'), s.get('contactTitle')) if x)) or '—'}"
                     f"{(' · ' + F.e(' · '.join(x for x in (s.get('phone'), s.get('wechat'), s.get('email')) if x))) if any((s.get('phone'), s.get('wechat'), s.get('email'))) else ''}</span></div>")
            h.append(f"<div class='kv'><span class='k'>Products</span><span>{F.e(s.get('productDetails') or '—')}</span></div>")
            h.append(f"<div class='kv'><span class='k'>Capacity / Markets</span><span>"
                     f"{F.e(F.capacity_text(s))} · {F.e(', '.join(F.markets_en(s)) or '—')} · "
                     f"EU/DE experience: {F.e(s.get('euGermanyExperience') or 'Unknown')}</span></div>")
            if s.get("notes"):
                h.append(f"<div class='kv'><span class='k'>Notes</span><span>{F.e(s['notes'])}</span></div>")
            if s.get("nextAction"):
                h.append(f"<div class='kv'><span class='k'>Next action</span><span>{F.e(s['nextAction'])}"
                         f"{(' · due ' + F.e(s['nextActionDate'])) if s.get('nextActionDate') else ''}</span></div>")
            if s["_state"] == "draft":
                h.append(f"<div class='warn small'>Draft record — missing: {F.e(', '.join(s['_missing']))}</div>")
            imgs = ctx.photos_by_supplier.get(s["id"]) or []
            if imgs:
                h.append("<div class='grid'>" + "".join(
                    f"<img src='{_b64_image(p['file'])}' alt='{F.e(p.get('type'))}'>" for p in imgs) + "</div>")
            h.append("</div>")

    h.append("<p class='small mut' style='margin-top:40px'>Generated by FairRecorder from on-site mobile "
             "records. Scores reflect field observations recorded at the fair and are not a substitute for "
             "factory audit or certificate verification.</p>")
    h.append("</div><script>" + LIGHTBOX_JS + "</script></body></html>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(h), encoding="utf-8")


# --------------------------------------------------------------------------- #
# DOCX report
# --------------------------------------------------------------------------- #
def write_docx(ctx: F.Context, path: Path) -> None:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Cm, Pt, RGBColor

    ev = ctx.event
    doc = Document()
    st = doc.styles["Normal"]
    st.font.name = "Calibri"
    st.font.size = Pt(10.5)

    def h1(t):
        doc.add_heading(t, level=1)
    def h2(t):
        doc.add_heading(t, level=2)
    def para(t, size=10.5, italic=False, bold=False):
        p = doc.add_paragraph()
        r = p.add_run(str(t))
        r.font.size = Pt(size); r.italic = italic; r.bold = bold
        return p
    def table(headers, rows, widths=None):
        t = doc.add_table(rows=1, cols=len(headers))
        t.style = "Table Grid"
        for i, hh in enumerate(headers):
            c = t.rows[0].cells[i]
            c.text = str(hh)
            for p in c.paragraphs:
                for r in p.runs:
                    r.bold = True; r.font.size = Pt(9); r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
            from docx.oxml.ns import qn
            from docx.oxml import OxmlElement
            sh = OxmlElement("w:shd"); sh.set(qn("w:fill"), "123A5E"); c._tc.get_or_add_tcPr().append(sh)
        for row in rows:
            cells = t.add_row().cells
            for i, v in enumerate(row):
                cells[i].text = "" if v is None else str(v)
                for p in cells[i].paragraphs:
                    for r in p.runs:
                        r.font.size = Pt(9)
        if widths:
            for r in t.rows:
                for i, w in enumerate(widths):
                    r.cells[i].width = Cm(w)
        return t

    # Cover
    t = doc.add_heading("Supplier Report", level=0)
    t.alignment = WD_ALIGN_PARAGRAPH.LEFT
    para(ev["name"], size=14, bold=True)
    para(f"{ev['phase']} · {ev['dates']}", size=11)
    para(ev["venue"], size=11)
    para(f"Prepared for: {ev['prepared_for']}", size=11)
    para(f"Generated: {ctx.generated_at}", size=9, italic=True)
    doc.add_paragraph()

    total = len(ctx.suppliers)
    rated = [s for s in ctx.suppliers if s["_rankable"]]
    drafts = [s for s in ctx.suppliers if s["_state"] == "draft"]
    planned = [s for s in ctx.suppliers if s.get("source") == "planned"]
    manual = [s for s in ctx.suppliers if s.get("source") == "manual"]
    unvisited = [p for p in ctx.plans if p.get("status") != "visited"]
    picks = F.top_picks(ctx)
    planned_txt = f"{len(planned)} / {total - len(planned) - len(manual)} / {len(manual)}"

    h1("1. Executive Summary")
    table(["Metric", "Value"], [
        ["Suppliers recorded", total],
        ["Fully rated (all six dimensions)", len(rated)],
    ], widths=[8.0, 8.0])
    # 列出所有厂家（不止 Top N）：已评分的在前，未评分的排最后
    ranking = sorted(ctx.suppliers,
                     key=lambda s: (-(s["_score"] if s["_score"] is not None else -1), s["_company"]))
    if ranking:
        para("Top recommendations — all suppliers", size=11, bold=True)
        table(["#", "Supplier", "Booth", "Categories", "Score", "Tier"],
              [[i, s["_company"], s.get("boothNo", ""), ", ".join(F.categories_en(s)),
                s["_score"] if s["_score"] is not None else "not ranked", s["_tier"]]
               for i, s in enumerate(ranking, 1)],
              widths=[0.8, 5.6, 1.9, 4.0, 1.5, 2.2])
    risks = [s for s in ctx.suppliers if s["_blockers"]]
    if risks:
        para(f"Risk note: {len(risks)} supplier(s) recorded a key compliance item as not available. "
             f"They can only be shortlisted conditionally, subject to documentary verification.", size=10)

    doc.add_page_break()
    h1("2. Scope & Methodology")
    h2("2.1 Scoring weights")
    meaning = {
        "fit": "Clearly off-target / Strong match with the sourcing programme",
        "compliance": "No evidence / Key documents complete and verifiable",
        "quality": "High process risk / Mature QA, traceability and inspection",
        "price": "Clearly overpriced / Clear advantage on a like-for-like basis",
        "capacity": "Cannot meet demand / Comfortable capacity and lead-time headroom",
        "communication": "Poor responsiveness / Strong technical dialogue and cooperation",
    }
    table(["Dimension", "Weight", "1 / 5 means"],
          [[en, f"{ctx.weights.get(code, 0)}%", meaning.get(code, "")] for code, _, en in F.SCORE_DIMS],
          widths=[5.0, 1.6, 9.4])
    doc.add_page_break()
    h1("3. Supplier Catalogue")
    for code, name, items in F.grouped_by_category(ctx):
        h2(f"{name} — {len(items)} supplier(s)")
        for s in items:
            doc.add_heading(f"{s['_company']}  ·  {s['_tier']}"
                            + (f" ({s['_score']}/100)" if s["_rankable"] else " — draft, not ranked"),
                            level=3)
            rows = [
                ["Booth", " / ".join(x for x in (s.get("hall"), s.get("area"), s.get("boothNo")) if x) or "—"],
                ["Contact", " / ".join(x for x in (s.get("contactName"), s.get("contactTitle")) if x) or "—"],
                ["Channels", " / ".join(x for x in (s.get("phone"), s.get("wechat"), s.get("email")) if x) or "—"],
                ["Categories", ", ".join(F.categories_en(s))],
                ["Products", s.get("productDetails") or "—"],
                ["Capacity", F.capacity_text(s)],
                ["Export markets", ", ".join(F.markets_en(s)) or "—"],
                ["EU / DE experience", s.get("euGermanyExperience") or "Unknown"],
                ["Notes", s.get("notes") or "—"],
                ["Next action", (s.get("nextAction") or "—")
                 + (f" (due {s.get('nextActionDate')})" if s.get("nextActionDate") else "")],
                ["Record state", s["_state"] + (f" — missing {', '.join(s['_missing'])}" if s["_missing"] else "")],
            ]
            table(["Field", "Value"], rows, widths=[3.4, 12.6])
            if s["_blockers"]:
                para("Key compliance item(s) marked not available: " + ", ".join(s["_blockers"])
                     + " — conditional only, pending documentary verification.", size=10, bold=True)
            for p in (ctx.photos_by_supplier.get(s["id"]) or []):
                try:
                    doc.add_picture(p["report"], width=Cm(7.0))
                except Exception:  # noqa: BLE001
                    pass
            doc.add_paragraph()

    para("Generated by FairRecorder from on-site mobile records. Scores reflect field observations recorded at "
         "the fair and are not a substitute for a factory audit or certificate verification.", size=9, italic=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def main(argv=None) -> int:
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="FairRecorder — merge phone exports into HQ deliverables")
    ap.add_argument("--inbox", default=str(root / "inbox"), help="folder holding exported ZIP files")
    ap.add_argument("--output", default=str(root / "output"), help="output folder")
    ap.add_argument("--top", type=int, default=5, help="how many suppliers to feature as recommendations")
    ap.add_argument("--config", default=str(root / "config.json"),
                    help="optional local config.json (event title, recipient) — never committed")
    ap.add_argument("--fair", default=None,
                    help="只出某一届展会：可填展会 id、slug 或输出目录名（默认全部）")
    ap.add_argument("--list-fairs", action="store_true", help="列出 inbox 里的展会后退出")
    args = ap.parse_args(argv)

    inbox, out = Path(args.inbox), Path(args.output)
    out.mkdir(parents=True, exist_ok=True)

    event_override = {}
    cfg = Path(args.config)
    if cfg.exists():
        try:
            loaded = json.loads(cfg.read_text(encoding="utf-8"))
            if isinstance(loaded.get("event"), dict):
                event_override = loaded["event"]
        except (json.JSONDecodeError, OSError) as ex:
            print(f"warning: could not read {cfg} ({ex})")

    if args.list_fairs:
        ctxs, _ = F.build_all_contexts(inbox, out, top_n=args.top, event_override=event_override)
        if not ctxs:
            print("no fairs found in", inbox)
            return 0
        for c in ctxs:
            f = c.fair or {}
            print(f"  {c.fair_dir:<44} id={c.fair_id}  "
                  f"{len(c.suppliers)} suppliers  {f.get('name') or f.get('nameEn') or ''}")
        return 0

    contexts, global_issues = F.build_all_contexts(
        inbox, out, top_n=args.top, event_override=event_override, only_fair=args.fair)

    index: list[dict] = []
    for ctx in contexts:
        sub = out / ctx.fair_dir
        master = sub / "Supplier_Master.xlsx"
        comp = sub / "Category_Comparison.xlsx"
        html_path = sub / "Supplier_Report_EN.html"
        docx_path = sub / "Supplier_Report_EN.docx"

        write_master_xlsx(ctx, master)
        write_comparison_xlsx(ctx, comp)
        write_html(ctx, html_path)
        write_docx(ctx, docx_path)

        merged = sub / "data" / "suppliers_merged.json"
        merged.write_text(json.dumps({
            "generatedAt": ctx.generated_at,
            "fair": ctx.fair,
            "event": ctx.event,
            "weights": ctx.weights,
            "suppliers": ctx.suppliers,
            "visitPlans": ctx.plans,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        (sub / "validation.json").write_text(json.dumps({
            "generatedAt": ctx.generated_at,
            "python": sys.version.split()[0],
            "fair": ctx.fair,
            "exports": ctx.exports,
            "counts": {
                "suppliers": len(ctx.suppliers),
                "rated": len([s for s in ctx.suppliers if s["_rankable"]]),
                "drafts": len([s for s in ctx.suppliers if s["_state"] == "draft"]),
                "photos": len(ctx.photo_index),
                "visitPlans": len(ctx.plans),
                "tombstones": getattr(ctx, "tombstones", 0),
            },
            "duplicateCandidates": getattr(ctx, "duplicate_candidates", []),
            "issues": ctx.issues,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

        picks = F.top_picks(ctx)
        index.append({
            "fairId": ctx.fair_id,
            "dir": ctx.fair_dir,
            "name": (ctx.fair or {}).get("name") or ctx.event.get("name"),
            "nameEn": (ctx.fair or {}).get("nameEn") or "",
            "phase": (ctx.fair or {}).get("phase") or ctx.event.get("phase"),
            "dates": ctx.event.get("dates"),
            "venue": ctx.event.get("venue"),
            "suppliers": len(ctx.suppliers),
            "rated": len([s for s in ctx.suppliers if s["_rankable"]]),
            "photos": len(ctx.photo_index),
            "top": [{"company": s["_company"], "score": s["_score"], "tier": s["_tier"]}
                    for s in picks],
            "report": f"{ctx.fair_dir}/Supplier_Report_EN.docx",
        })

        print(f"[{ctx.fair_dir}]")
        print(f"  Suppliers : {len(ctx.suppliers)}  "
              f"(rated {len([s for s in ctx.suppliers if s['_rankable']])}, "
              f"draft {len([s for s in ctx.suppliers if s['_state'] == 'draft'])})")
        print(f"  Photos    : {len(ctx.photo_index)}")
        if ctx.issues:
            print(f"  Issues    : {len(ctx.issues)}")
            for i in ctx.issues[:10]:
                print("     - " + i)

    (out / "index.json").write_text(json.dumps({
        "generatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "inbox": str(inbox),
        "globalIssues": global_issues,
        "fairs": index,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print(f"Fairs     : {len(contexts)}")
    for row in index:
        print(f"   {row['dir']:<44} {row['suppliers']} suppliers → {row['report']}")
    print(f"Index     : {out / 'index.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

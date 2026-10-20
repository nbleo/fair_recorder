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
    cols = ([
        ("Company (EN / ZH)", 34), ("Company ZH", 26), ("Booth", 14), ("Hall / Area", 16),
        ("Source", 12), ("Contact", 14), ("Title", 14), ("Phone", 16), ("WeChat", 16),
        ("Email", 24), ("Website", 22), ("Categories", 26), ("Product / highlights", 34),
        ("Models", 16), ("MOQ", 16), ("Price", 22), ("Incoterm", 10), ("Lead time (d)", 12),
        ("Capacity", 18), ("Export markets", 24), ("EU / DE experience", 16),
        ("Total score", 11), ("Tier", 13),
    ] + [(d[2], 8) for d in F.SCORE_DIMS] \
      + [(f"{d[2]} comments", 34) for d in F.SCORE_DIMS] \
      + [(f"Card {en}", 16) for _c, en in F.NAMECARD_FIELDS] \
      + [("Highlight products", 40), ("State", 10), ("Missing", 24), ("Follow-up", 13),
         ("Next action", 26), ("Due", 12), ("Notes", 40), ("Photos", 8), ("Last updated", 19)])
    ws.append([c[0] for c in cols])
    for s in ctx.suppliers:
        sc = s.get("score") or {}
        sn = F.score_comments(s)
        card = s.get("namecard") or {}
        hl = " | ".join(" — ".join(x for x in (it["title"] or "", it["note"]) if x)
                        for it in F.highlights(s))
        row = [s["_company"], s.get("companyNameZh", ""), s.get("boothNo", ""),
               " / ".join(x for x in (s.get("hall"), s.get("area")) if x),
               F.source_en(s),
               s.get("contactName", ""), s.get("contactTitle", ""), s.get("phone", ""),
               s.get("wechat", ""), s.get("email", ""), s.get("website", ""),
               ", ".join(F.categories_en(s)), s.get("productDetails", ""), s.get("models", ""),
               F.moq_text(s), F.price_text(s), s.get("incoterm", ""), s.get("leadTimeDays"),
               F.capacity_text(s), ", ".join(F.markets_en(s)), s.get("euGermanyExperience", ""),
               s["_score"] if s["_rankable"] else "not ranked", s["_tier"]]
        row += [sc.get(d[0]) if isinstance(sc.get(d[0]), (int, float)) else "" for d in F.SCORE_DIMS]
        row += [sn.get(d[0]) or "" for d in F.SCORE_DIMS]
        row += [str(card.get(c) or "") for c, _en in F.NAMECARD_FIELDS]
        row += [hl, s["_state"], ", ".join(s["_missing"]),
                F.followup_en(s), s.get("nextAction", ""), s.get("nextActionDate", ""),
                s.get("notes", ""), s["_photoCount"], s.get("updatedAt", "")]
        ws.append(row)
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
/* 第 1 章的清单表有 6 列，手机窄屏挤成一团，包一层横向滚动 */
.scrollx{overflow-x:auto;-webkit-overflow-scrolling:touch}
table.list{min-width:660px}
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
/* 名片 / 亮点产品：与基础信息用虚线隔开，否则一堆 kv 行糊成一片 */
.blk{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)}
.blkt{font-size:13px;font-weight:700;color:var(--acc);letter-spacing:.3px;margin-bottom:8px}
.hl{border-left:3px solid var(--acc);padding:2px 0 8px 12px;margin:12px 0}
.hlt{font-size:15px;font-weight:700;margin-bottom:4px}
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


def supplier_card_html(ctx: F.Context, s: dict) -> str:
    cards, by_hl, gallery = F.photo_buckets(ctx, s["id"])
    notes = F.score_comments(s)
    sc = s.get("score") or {}
    cls = ("b-short" if s["_tier"] == "Shortlist" else "b-follow" if s["_tier"] == "Follow-up"
           else "b-res" if s["_tier"] == "Reserve" else "b-low" if s["_tier"] == "Low priority" else "b-draft")
    h = ["<div class='card'>"]
    h.append(f"<div style='font-size:18px;font-weight:700'>{F.e(s['_company'])} "
             f"<span class='badge {cls}'>{F.e(s['_tier'])}"
             f"{(' · ' + str(s['_score'])) if s['_score'] is not None else ''}</span>"
             f"<span class='badge b-follow'>{F.e(F.source_en(s))}</span></div>")
    h.append(f"<div class='kv'><span class='k'>Booth</span><span>{F.e(' / '.join(x for x in (s.get('hall'), s.get('area'), s.get('boothNo')) if x)) or '—'}</span></div>")
    contact = F.e(" / ".join(x for x in (s.get("contactName"), s.get("contactTitle")) if x)) or "—"
    ways = " · ".join(x for x in (s.get("phone"), s.get("wechat"), s.get("email")) if x)
    h.append(f"<div class='kv'><span class='k'>Contact</span><span>{contact}"
             f"{(' · ' + F.e(ways)) if ways else ''}</span></div>")
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

    # 评分 + 每项评语
    if any(isinstance(sc.get(d[0]), (int, float)) for d in F.SCORE_DIMS):
        h.append("<table><tr><th>Dimension</th><th>Weight</th><th>Rating</th><th>Comments</th></tr>")
        for code, _zh, en in F.SCORE_DIMS:
            v = sc.get(code)
            rated = isinstance(v, (int, float))
            stars = ("★" * int(v) + "☆" * (5 - int(v))) if rated else "—"
            rate = f"{stars} {v}/5" if rated else "—"
            h.append(f"<tr><td>{F.e(en)}</td><td>{F.e(ctx.weights.get(code, 0))}%</td>"
                     f"<td>{F.e(rate)}</td><td>{F.e(notes.get(code) or '—')}</td></tr>")
        h.append("</table>")

    # 名片
    rows = F.namecard_rows(s)
    if rows or cards:
        h.append("<div class='blk'><div class='blkt'>Name card</div>")
        h.append("".join(f"<div class='kv'><span class='k'>{F.e(k)}</span><span>{F.e(v)}</span></div>"
                         for k, v in rows))
        if cards:
            h.append("<div class='grid'>" + "".join(
                f"<img src='{_b64_image(p['file'])}' alt='name card'>" for p in cards) + "</div>")
        h.append("</div>")

    # 亮点产品
    items = F.highlights(s)
    if items:
        h.append("<div class='blk'><div class='blkt'>Highlight products</div>")
        for it in items:
            h.append("<div class='hl'>")
            h.append(f"<div class='hlt'>{F.e(it['title'] or '(untitled)')}</div>")
            if it["note"]:
                h.append(f"<div style='white-space:pre-wrap;font-size:14px;margin-bottom:8px'>{F.e(it['note'])}</div>")
            ph = by_hl.get(it["id"]) or []
            if ph:
                h.append("<div class='grid'>" + "".join(
                    f"<img src='{_b64_image(p['file'])}' alt='highlight'>" for p in ph) + "</div>")
            h.append("</div>")
        h.append("</div>")

    # 其余照片：单独成 Booth Photos 一栏，排在亮点产品之后。
    # 之前直接挂在卡片末尾，读的人分不清这些图属于哪个板块。
    if gallery:
        h.append("<div class='blk'><div class='blkt'>Booth Photos</div>")
        h.append("<div class='grid'>" + "".join(
            f"<img src='{_b64_image(p['file'])}' alt='{F.e(p.get('type'))}'>" for p in gallery) + "</div>")
        h.append("</div>")
    h.append("</div>")
    return "".join(h)


# ---- 第 1 章 Supplier List ------------------------------------------------ #
# 以前这一章只有一行「Suppliers recorded: N」，不翻到第 2 章根本不知道见了谁。
# 现在每家列一行：公司名、展位、品类、联系人、评级（顺序与 Catalogue 一致，高分在前）。
LIST_COLS = ["#", "Company", "Booth / Hall", "Categories", "Contact", "Rating"]
LIST_WIDTHS_CM = [0.9, 4.3, 2.1, 2.8, 3.6, 3.3]        # 合计 17.0 cm = A4 版心


def list_rows(ctx: F.Context) -> list[list[str]]:
    """每行一条记录；单元格内的换行由 HTML 转 <br>、由 python-docx 转软换行。"""
    rows = []
    for i, s in enumerate(ctx.suppliers, 1):
        who = " / ".join(x for x in (s.get("contactName"), s.get("contactTitle")) if x)
        ways = " · ".join(x for x in (s.get("phone"), s.get("wechat"), s.get("email")) if x)
        contact = "\n".join(x for x in (who, ways) if x) or "—"
        # 90.0 这种尾巴看着像精度缺失，能取整就取整
        sc = s["_score"] if s["_rankable"] and s["_score"] is not None else None
        sc_txt = "—" if sc is None else f"{sc:.0f}" if float(sc).is_integer() else f"{sc:.1f}"
        rating = "\n".join(x for x in (sc_txt, s["_tier"] or "") if x) or "—"
        rows.append([
            str(i), s["_company"],
            " / ".join(x for x in (s.get("hall"), s.get("area"), s.get("boothNo")) if x) or "—",
            ", ".join(F.categories_en(s)) or "—", contact, rating,
        ])
    return rows


def write_html(ctx: F.Context, path: Path) -> None:
    ev = ctx.event
    total = len(ctx.suppliers)

    h = [f"<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>",
         f"<title>Supplier Report — {F.e(ev['name'])}</title><style>{CSS}</style></head><body><div class='wrap'>"]

    h.append(f"<h1>Supplier Report — {F.e(ev['name'])}</h1>")
    h.append(f"<div class='sub'>{F.e(ev['phase'])} · {F.e(ev['dates'])} · {F.e(ev['venue'])}</div>")
    h.append(f"<div class='sub' style='margin-top:8px'>Prepared for: {F.e(ev['prepared_for'])} · "
             f"Generated {F.e(ctx.generated_at)}</div>")

    # 1. Supplier List —— 总数 + 每家一行关键信息
    h.append("<h2>1. Supplier List</h2><div class='card'>")
    h.append(f"<div class='kv'><span class='k'>Suppliers recorded</span><span>{total}</span></div>")
    if total:
        h.append("<div class='scrollx'><table class='list'><tr>"
                 + "".join(f"<th>{F.e(c)}</th>" for c in LIST_COLS) + "</tr>")
        for row in list_rows(ctx):
            cells = "".join(f"<td>{F.e(v).replace(chr(10), '<br>')}</td>" for v in row)
            h.append(f"<tr>{cells}</tr>")
        h.append("</table></div>")
    else:
        h.append("<p class='small mut'>No supplier recorded yet.</p>")
    h.append("</div>")

    # 2. Supplier Catalogue
    h.append("<h2>2. Supplier Catalogue</h2>")
    if not ctx.suppliers:
        h.append("<p class='small mut'>No supplier recorded yet.</p>")
    for _code, name, items in F.grouped_by_category(ctx):
        h.append(f"<h3>{F.e(name)} — {len(items)} supplier(s)</h3>")
        for s in items:
            h.append(supplier_card_html(ctx, s))

    # 3. Fair Summary —— 报告最后一项
    h.append("<h2>3. Fair Summary</h2><div class='card'>")
    paras = F.summary_paras(ctx.summary)
    if paras:
        h.append("".join(f"<p style='margin:0 0 12px;white-space:pre-wrap'>{F.e(p)}</p>" for p in paras))
    else:
        h.append("<p class='small mut'>No fair summary recorded.</p>")
    h.append("</div>")

    h.append("<p class='small mut' style='margin-top:40px'>Generated by FairRecorder from on-site mobile "
             "records. Scores reflect field observations recorded at the fair and are not a substitute for "
             "factory audit or certificate verification.</p>")
    h.append("</div><script>" + LIGHTBOX_JS + "</script></body></html>")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(h), encoding="utf-8")


def _image_ratio(path) -> float | None:
    """读图片宽高比 w/h，读不出来返回 None。

    不引 PIL / 任何第三方：报告里的照片就是 JPEG 和 PNG 两种，
    各自从文件头里取尺寸就够，省得导出链在别人机器上多了个依赖。
    """
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            w = int.from_bytes(head[16:20], "big")
            h = int.from_bytes(head[20:24], "big")
            return (w / h) if h else None
        if head[:2] == b"\xff\xd8":                       # JPEG：找 SOF 段
            i = 2
            while i + 9 < len(head):
                if head[i] != 0xFF:
                    i += 1
                    continue
                marker = head[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                              0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    h = int.from_bytes(head[i + 5:i + 7], "big")
                    w = int.from_bytes(head[i + 7:i + 9], "big")
                    return (w / h) if h else None
                if marker == 0xD8 or 0xD0 <= marker <= 0xD9:
                    i += 2
                    continue
                seg = int.from_bytes(head[i + 2:i + 4], "big")
                i += 2 + seg
    except Exception:  # noqa: BLE001
        return None
    return None


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

    def pictures(photos):
        """一组照片横向排成隐形表格：1 张单列、2 张两列、3 张及以上三列。

        以前是一张图一个段落（固定 7cm），要么占掉大半页、要么留一堆空白，
        同一批图的实际宽度还会因为高度挤压而不一致。现在统一按列宽算尺寸，
        每格同样左右留白、顶端对齐、居中，看起来才像排版过的资料。
        """
        from docx.oxml.ns import qn
        from docx.oxml import OxmlElement

        items = [p for p in (photos or []) if p.get("report")]
        if not items:
            return
        cols = 1 if len(items) == 1 else 2 if len(items) == 2 else 3
        total = 12.0 if cols == 1 else 17.0          # A4 减左右边距约 17cm
        colw, pad = total / cols, 0.16
        imgw = colw - pad * 2
        rows_n = -(-len(items) // cols)

        tbl = doc.add_table(rows=rows_n, cols=cols)
        tbl.autofit = False
        borders = OxmlElement("w:tblBorders")
        for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
            el = OxmlElement(f"w:{edge}")
            el.set(qn("w:val"), "none"); el.set(qn("w:sz"), "0")
            borders.append(el)
        tbl._tbl.tblPr.append(borders)
        layout = OxmlElement("w:tblLayout")
        layout.set(qn("w:type"), "fixed")
        tbl._tbl.tblPr.append(layout)

        for i, p in enumerate(items):
            r, c = divmod(i, cols)
            cell = tbl.rows[r].cells[c]
            # 竖图按列宽算出来会很高，统一压到 9cm 以内再回推宽度
            ratio = _image_ratio(p["report"])
            w_cm = imgw
            if ratio and imgw / ratio > 9.0:
                w_cm = 9.0 * ratio
            try:
                cell.paragraphs[0].add_run().add_picture(p["report"], width=Cm(w_cm))
            except Exception:  # noqa: BLE001
                pass

        for row in tbl.rows:
            for cell in row.cells:
                cell.width = Cm(colw)
                for pp in cell.paragraphs:
                    pp.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    pp.paragraph_format.space_before = Pt(2)
                    pp.paragraph_format.space_after = Pt(2)
                    pp.paragraph_format.line_spacing = 1.0

    # ---- Cover ----
    t = doc.add_heading("Supplier Report", level=0)
    t.alignment = WD_ALIGN_PARAGRAPH.LEFT
    para(ev["name"], size=14, bold=True)
    para(f"{ev['phase']} · {ev['dates']}", size=11)
    para(ev["venue"], size=11)
    para(f"Prepared for: {ev['prepared_for']}", size=11)
    para(f"Generated: {ctx.generated_at}", size=9, italic=True)
    doc.add_paragraph()

    # ---- 1. Supplier List ----
    # 不插分页：这一章通常只有一行统计，硬分一页等于白留大半页空白。
    h1("1. Supplier List")
    para(f"Suppliers recorded: {len(ctx.suppliers)}", size=11, bold=True)
    if ctx.suppliers:
        table(LIST_COLS, [list(r) for r in list_rows(ctx)], widths=LIST_WIDTHS_CM)
    else:
        para("No supplier recorded yet.", size=10, italic=True)

    # ---- 2. Supplier Catalogue ----
    h1("2. Supplier Catalogue")
    if not ctx.suppliers:
        para("No supplier recorded yet.", size=10, italic=True)
    for _code, name, items in F.grouped_by_category(ctx):
        h2(f"{name} — {len(items)} supplier(s)")
        for s in items:
            cards, by_hl, gallery = F.photo_buckets(ctx, s["id"])
            notes = F.score_comments(s)
            sc = s.get("score") or {}
            doc.add_heading(f"{s['_company']}  ·  {s['_tier']}"
                            + (f" ({s['_score']}/100)" if s["_rankable"] else " — draft, not ranked"),
                            level=3)
            contact = " / ".join(x for x in (s.get("contactName"), s.get("contactTitle")) if x) or "—"
            ways = " / ".join(x for x in (s.get("phone"), s.get("wechat"), s.get("email")) if x) or "—"
            table(["Field", "Value"], [
                ["Booth", " / ".join(x for x in (s.get("hall"), s.get("area"), s.get("boothNo")) if x) or "—"],
                ["Contact", contact],
                ["Channels", ways],
                ["Categories", ", ".join(F.categories_en(s)) or "—"],
                ["Products", s.get("productDetails") or "—"],
                ["Capacity", F.capacity_text(s)],
                ["Export markets", ", ".join(F.markets_en(s)) or "—"],
                ["EU / DE experience", s.get("euGermanyExperience") or "Unknown"],
                ["Source", F.source_en(s)],
                ["Notes", s.get("notes") or "—"],
                ["Next action", (s.get("nextAction") or "—")
                 + (f" (due {s.get('nextActionDate')})" if s.get("nextActionDate") else "")],
                ["Record state", s["_state"] + (f" — missing {', '.join(s['_missing'])}" if s["_missing"] else "")],
            ], widths=[3.4, 12.6])

            if any(isinstance(sc.get(d[0]), (int, float)) for d in F.SCORE_DIMS):
                table(["Dimension", "Weight", "Rating", "Comments"],
                      [[en, f"{ctx.weights.get(code, 0)}%",
                        f"{sc[code]}/5" if isinstance(sc.get(code), (int, float)) else "—",
                        notes.get(code) or "—"] for code, _zh, en in F.SCORE_DIMS],
                      widths=[2.6, 1.6, 2.0, 9.8])

            card_rows_docx = F.namecard_rows(s)
            if card_rows_docx or cards:
                para("Name card", size=11, bold=True)
                if card_rows_docx:
                    table(["Field", "Value"], [list(r) for r in card_rows_docx], widths=[3.4, 12.6])
                pictures(cards)

            hl_items = F.highlights(s)
            if hl_items:
                para("Highlight products", size=11, bold=True)
                for it in hl_items:
                    para(it["title"] or "(untitled)", size=10.5, bold=True)
                    if it["note"]:
                        for ln in str(it["note"]).split("\n"):
                            para(ln, size=10.5)
                    pictures(by_hl.get(it["id"]) or [])

            # 亮点产品之外的其余照片，单独成一栏，不与上面混排
            if gallery:
                para("Booth Photos", size=11, bold=True)
                pictures(gallery)
            doc.add_paragraph()

    # ---- 3. Fair Summary（最后一项，同样接在上一章后面，不强制分页） ----
    h1("3. Fair Summary")
    paras = F.summary_paras(ctx.summary)
    if paras:
        for blk in paras:
            for ln in str(blk).split("\n"):
                para(ln, size=10.5)
    else:
        para("No fair summary recorded.", size=10, italic=True)

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

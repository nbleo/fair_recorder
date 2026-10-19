/* FairRecorder — on-device English report generator.
   Mirrors scripts/build_report.py so the phone and the desktop pipeline agree:
   same weights, same tiers, same compliance-evidence wording, same section order.
   Depends on window.FR (data bridge) and window.JSZip (for .xlsx). */
"use strict";
(function () {
  const FR = () => window.FR;
  const C = () => FR().consts;
  const U = () => FR().util;
  const e = (s) => U().esc(s);

  /* ---------------------- English label helpers ---------------------- */
  function catEn(code) {
    for (const c of C().CATEGORIES) if (c[0] === code) return c[2];
    return code;
  }
  function catsEn(s) {
    return (s.categories || []).map(catEn);
  }
  function marketEn(m) {
    return U().labelOf(C().MARKETS, m) || m;
  }
  function marketsEn(s) {
    return (s.exportMarkets || []).map(marketEn);
  }
  function cstatEn(st) {
    return U().labelOf(C().CSTAT, st || "unknown") || "Unknown";
  }
  function complianceEn(s, code) {
    return cstatEn((s.compliance && s.compliance[code] || {}).status);
  }
  function sourceEn(s) {
    return s.source === "planned" ? "Planned" : s.source === "manual" ? "Manual entry" : "Walk-in";
  }
  function followupEn(s) {
    return U().labelOf(C().FOLLOWUPS, s.followUpStatus || "new") || "New";
  }
  function companyOf(s) {
    const en = (s.companyNameEn || "").trim(), zh = (s.companyNameZh || "").trim();
    if (en && zh) return en + " (" + zh + ")";
    return en || zh || "(unnamed)";
  }
  function priceText(s) {
    const lo = s.priceMin, hi = s.priceMax;
    if (lo == null && hi == null) return "n/a";
    const cur = (s.currency || "").trim();
    let amt = (hi == null || hi === lo) ? `${cur} ${lo}`.trim() : `${cur} ${lo}–${hi}`.trim();
    const tail = [s.priceUnit, (s.incoterm && s.incoterm !== "Unknown") ? s.incoterm : ""].filter(Boolean).join(" / ");
    return tail ? `${amt} per ${tail}` : amt;
  }
  function moqText(s) {
    return s.moqValue == null ? "n/a" : `${s.moqValue} ${s.moqUnit || ""}`.trim();
  }
  function capText(s) {
    return s.capacityValue == null ? "n/a" : `${s.capacityValue} ${s.capacityUnit || ""}`.trim();
  }
  function leadText(s) {
    return s.leadTimeDays ? s.leadTimeDays + " d" : "n/a";
  }
  function boothText(s) {
    return [s.hall, s.area, s.boothNo].filter(Boolean).join(" / ") || "—";
  }
  function tierClass(t) {
    return t === "Shortlist" ? "b-short" : t === "Follow-up" ? "b-follow"
      : t === "Reserve" ? "b-res" : t === "Low priority" ? "b-low" : "b-draft";
  }

  /* ---------------------- context assembly ---------------------- */
  /* Reads straight from IndexedDB via FR.all() so it works for any fair,
     not only the currently selected one. */
  async function buildContext(opts) {
    opts = opts || {};
    const topN = opts.topN || 5;
    const withPhotos = opts.withPhotos !== false;
    const photoSide = opts.photoSide || 900;

    const allSup = await FR().all("suppliers");
    const allPlans = await FR().all("visitPlans");
    const allPhotos = await FR().all("photos");
    const allFairs = await FR().all("fairs");
    const weights = FR().settings.weights;

    let fairIds = [];
    if (opts.fairId) fairIds = [opts.fairId];
    else if (opts.all) fairIds = allFairs.filter((f) => !f.deletedAt).map((f) => f.id);
    else if (FR().fair) fairIds = [FR().fair.id];

    const fairMap = {};
    for (const f of allFairs) fairMap[f.id] = f;
    const idSet = new Set(fairIds);

    const suppliers = allSup.filter((s) => !s.deletedAt && idSet.has(s.fairId))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    const plans = allPlans.filter((p) => !p.deletedAt && idSet.has(p.fairId));
    /* 老数据（导入的 ZIP、早期版本）可能没写 fairId，用所属供应商兜底反查，
       否则这些照片在任何报告里都会凭空消失。 */
    const fairOfSup = {};
    for (const s of suppliers) fairOfSup[s.id] = s.fairId;
    const photoPool = allPhotos.filter((p) => idSet.has(p.fairId)
      || (p.supplierId && idSet.has(fairOfSup[p.supplierId])));

    /* decorate, same field names as the Python Context */
    for (const s of suppliers) {
      s._company = companyOf(s);
      s._state = U().stateOf(s);
      s._missing = U().missing(s);
      s._score = U().weightedScore(s, weights);
      s._rankable = s._score != null;
      s._tier = s._score != null ? U().tierOf(s._score) : (s._state === "draft" ? "Draft" : "Not rated");
      s._blockers = U().complianceBlockers(s);
    }
    const rated = suppliers.filter((s) => s._rankable);
    rated.sort((a, b) => (b._score - a._score)
      || ((b.score && b.score.compliance || 0) - (a.score && a.score.compliance || 0))
      || (a._company < b._company ? -1 : 1));
    const picks = rated.slice(0, topN);

    /* photos: only for suppliers in scope — no cap, every photo is embedded */
    const photoIndex = {};
    if (withPhotos) {
      /* 照片可能缺 supplierId（老数据、导入的 ZIP）。用厂家自己记录的 photoIds 反查归属，
         否则 App 里显示的照片数会大于报告里出现的照片数。 */
      const ownerOf = {};
      for (const s of suppliers) {
        for (const pid of (s.photoIds || [])) ownerOf[pid] = s.id;
      }
      const bySup = {};
      for (const p of photoPool) {
        const sid = p.supplierId || ownerOf[p.id];
        if (!sid || !fairOfSup[sid]) continue;
        (bySup[sid] = bySup[sid] || []).push(p);
      }
      for (const s of suppliers) {
        const list = (bySup[s.id] || []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        if (!list.length) continue;
        const out = [];
        for (const p of list) {
          try {
            const small = await FR().compress(p.blob, photoSide, 0.78);
            out.push({ type: p.type, url: await blobToDataURL(small) });
          } catch (err) { /* skip unreadable photo, never break the report */ }
        }
        if (out.length) photoIndex[s.id] = out;
      }
    }

    const fairs = fairIds.map((id) => fairMap[id]).filter(Boolean);
    const primary = fairs[0] || FR().fair || {};
    const dateTxt = [primary.startDate, (primary.endDate && primary.endDate !== primary.startDate) ? primary.endDate : ""]
      .filter(Boolean).join(" – ") || "";

    return {
      suppliers, plans, picks, photoIndex, weights, topN,
      fairs, fair: primary,
      event: {
        name: primary.nameEn || primary.name || "Supplier Visit",
        phase: primary.phase || "",
        dates: dateTxt,
        venue: [primary.city, primary.venue].filter(Boolean).join(" · "),
        prepared_for: (opts.preparedFor || "").trim(),
      },
      generated_at: new Date().toISOString().replace("T", " ").slice(0, 16) + " (device local)",
      issues: opts.issues || [],
    };
  }

  function blobToDataURL(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error || new Error("read failed"));
      r.readAsDataURL(blob);
    });
  }

  function grouped(ctx) {
    const order = C().CATEGORIES.map((c) => c[0]);
    const buckets = {};
    for (const s of ctx.suppliers) {
      const cs = (s.categories && s.categories.length) ? s.categories : ["other"];
      for (const c of cs) (buckets[c] = buckets[c] || []).push(s);
    }
    const keys = Object.keys(buckets).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map((k) => [k, catEn(k), buckets[k].sort((a, b) => (b._score || -1) - (a._score || -1))]);
  }

  /* ---------------------- recommendation text (factual only) ---------------------- */
  function recommendationText(s) {
    const dims = {};
    for (const d of C().SCORE_DIMS) dims[d[0]] = d[2];
    const bits = [`Weighted score ${s._score}/100 (${s._tier}).`];
    const sc = s.score || {};
    const strong = [], weak = [];
    for (const k in sc) if (typeof sc[k] === "number" && dims[k]) {
      if (sc[k] >= 4) strong.push(dims[k]);
      else if (sc[k] <= 2) weak.push(dims[k]);
    }
    if (strong.length) bits.push("Strong on " + strong.join(", ") + ".");
    if (weak.length) bits.push("Weak on " + weak.join(", ") + ".");
    if (s._blockers.length) {
      bits.push("Key compliance item(s) recorded as not available: " + s._blockers.join(", ")
        + " — shortlist only conditionally, subject to documentary verification.");
    } else {
      bits.push("No compliance item was marked unavailable; certificates still to be collected and verified.");
    }
    return bits.join(" ");
  }

  /* ---------------------- HTML report ---------------------- */
  /* Schulte 品牌配色：深蓝 #1F1FAF + 白 + 浅蓝灰底纹 */
  const CSS = `
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
#btnPrint{position:fixed;right:14px;bottom:14px;z-index:99;background:var(--acc);color:#fff;
 border:none;border-radius:999px;padding:12px 18px;font:600 15px/1 -apple-system,sans-serif;
 box-shadow:0 6px 16px rgba(31,31,175,.3)}
/* ---- 照片点开看大图 ---- */
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
@media print{body{background:#fff;color:#000}.card{border-color:#bbb;background:#fff}
 th{background:#E8EAF7;color:#000}#btnPrint,#lb{display:none}.warn{border-color:#999;color:#000;background:#fff}}
`;

  /* 照片点开看大图：双击放大、左右滑动切换、点空白处关闭。
     报告是单个 HTML 文件（会分享出去 / 存 PDF），所以脚本内联、零依赖。 */
  const LIGHTBOX_JS = `
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
  imgs.forEach(function(el,k){
    var guard=false;
    function go(){ if(guard) return; guard=true; setTimeout(function(){guard=false;},500); open(k); }
    el.addEventListener('click',go);
    /* 部分安卓浏览器 / 微信内嵌浏览器点图不会合成 click，用 touchend 兜底 */
    el.addEventListener('touchend',function(e){ e.preventDefault(); go(); });
  });
  lb.querySelector('.lbclose').addEventListener('click',function(e){ e.stopPropagation(); close(); });
  lb.querySelector('.lbprev').addEventListener('click',function(e){ e.stopPropagation(); show(idx-1); });
  lb.querySelector('.lbnext').addEventListener('click',function(e){ e.stopPropagation(); show(idx+1); });
  lb.addEventListener('click',function(e){
    if(e.target===lb||e.target===stage){ close(); }
  });
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
  var closeTimer=null;
  lb.addEventListener('pointerup',function(e){
    swiping=false;
    if(!moved){
      var now=Date.now();
      if(now-lastTap<320){                       /* 第二下：放大 / 还原 */
        if(closeTimer){ clearTimeout(closeTimer); closeTimer=null; }
        lb.classList.toggle('zoomed'); lastTap=0; return;
      }
      /* 第一下先不关：留 300ms 给第二下，否则双击放大永远触发不到 */
      lastTap=now;
      var tgt=e.target;
      if(closeTimer) clearTimeout(closeTimer);
      closeTimer=setTimeout(function(){ closeTimer=null;
        if(tgt===lb||tgt===stage) close(); }, 300);
      return;
    }
    if(closeTimer){ clearTimeout(closeTimer); closeTimer=null; }
    var dx=e.clientX-sx, dy=e.clientY-sy;
    if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)) show(idx+(dx<0?1:-1));
  });
})();
`;

  const MEANING = {
    fit: "Clearly off-target / Strong match with the sourcing programme",
    compliance: "No evidence / Key documents complete and verifiable",
    quality: "High process risk / Mature QA, traceability and inspection",
    price: "Clearly overpriced / Clear advantage on a like-for-like basis",
    capacity: "Cannot meet demand / Comfortable capacity and lead-time headroom",
    communication: "Poor responsiveness / Strong technical dialogue and cooperation",
  };

  function renderHTML(ctx) {
    const ev = ctx.event;
    const total = ctx.suppliers.length;
    const rated = ctx.suppliers.filter((s) => s._rankable);

    const h = [];
    h.push("<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>");
    h.push("<meta name='viewport' content='width=device-width,initial-scale=1'>");
    h.push(`<title>Supplier Report — ${e(ev.name)}</title><style>${CSS}</style></head><body><div class='wrap'>`);
    h.push("<button id='btnPrint' onclick='window.print()'>🖨 Print / Save as PDF</button>");

    h.push(`<h1>Supplier Report — ${e(ev.name)}</h1>`);
    h.push(`<div class='sub'>${[e(ev.phase), e(ev.dates), e(ev.venue)].filter(Boolean).join(" · ")}</div>`);
    h.push(`<div class='sub' style='margin-top:8px'>${ev.prepared_for ? "Prepared for: " + e(ev.prepared_for) + " · " : ""}Generated ${e(ctx.generated_at)}</div>`);

    /* 1 */
    h.push("<h2>1. Executive Summary</h2><div class='card'>");
    h.push(`<div class='kv'><span class='k'>Suppliers recorded</span><span>${total}</span></div>`);
    h.push(`<div class='kv'><span class='k'>Fully rated</span><span>${rated.length}</span></div></div>`);
    /* 列出所有厂家（不止 Top N），已评分的在前，未评分的排最后 */
    const ranking = ctx.suppliers.slice().sort((a, b) => {
      const av = a._score == null ? -1 : a._score, bv = b._score == null ? -1 : b._score;
      return (bv - av) || (a._company < b._company ? -1 : 1);
    });
    if (ranking.length) {
      h.push("<h3>Top recommendations — all suppliers</h3>"
        + "<table><tr><th>#</th><th>Supplier</th><th>Booth</th><th>Categories</th><th>Score</th><th>Tier</th></tr>");
      ranking.forEach((s, i) => {
        h.push(`<tr><td>${i + 1}</td><td>${e(s._company)}</td><td>${e(s.boothNo || "—")}</td>`
          + `<td>${e(catsEn(s).join(", "))}</td><td>${s._score == null ? "not ranked" : s._score}</td>`
          + `<td>${e(s._tier)}</td></tr>`);
      });
      h.push("</table>");
    }
    const risks = ctx.suppliers.filter((s) => s._blockers.length);
    if (risks.length) {
      h.push(`<div class='warn'><b>${risks.length} supplier(s)</b> recorded a key compliance item as not available. `
        + "They can only be shortlisted conditionally, subject to documentary verification.</div>");
    }

    /* 2 */
    h.push("<h2>2. Scope &amp; Methodology</h2><div class='card'>");
    h.push("<h3>Scoring weights</h3><table><tr><th>Dimension</th><th>Weight</th><th>Meaning of 1 / 5</th></tr>");
    for (const d of C().SCORE_DIMS) {
      h.push(`<tr><td>${e(d[2])}</td><td>${ctx.weights[d[0]] || 0}%</td><td>${e(MEANING[d[0]] || "")}</td></tr>`);
    }
    h.push("</table></div>");

    /* 3 */
    h.push("<h2>3. Supplier Catalogue</h2>");
    const groups = grouped(ctx);
    if (!groups.length) h.push("<p class='small mut'>No supplier recorded yet.</p>");
    for (const [, name, items] of groups) {
      h.push(`<h3>${e(name)} — ${items.length} supplier(s)</h3>`);
      for (const s of items) {
        h.push("<div class='card'>");
        h.push(`<div style='font-size:18px;font-weight:700'>${e(s._company)} `
          + `<span class='badge ${tierClass(s._tier)}'>${e(s._tier)}${s._score != null ? " · " + s._score : ""}</span>`
          + `<span class='badge b-follow'>${e(sourceEn(s))}</span></div>`);
        h.push(`<div class='kv'><span class='k'>Booth</span><span>${e(boothText(s))}</span></div>`);
        const contact = [s.contactName, s.contactTitle].filter(Boolean).join(" / ") || "—";
        const ways = [s.phone, s.wechat, s.email].filter(Boolean).join(" · ");
        h.push(`<div class='kv'><span class='k'>Contact</span><span>${e(contact)}${ways ? " · " + e(ways) : ""}</span></div>`);
        h.push(`<div class='kv'><span class='k'>Products</span><span>${e(s.productDetails || "—")}</span></div>`);
        h.push(`<div class='kv'><span class='k'>Capacity / Markets</span><span>${e(capText(s))} · `
          + `${e(marketsEn(s).join(", ") || "—")} · EU/DE experience: ${e(s.euGermanyExperience || "Unknown")}</span></div>`);
        if (s.notes) h.push(`<div class='kv'><span class='k'>Notes</span><span>${e(s.notes)}</span></div>`);
        if (s.nextAction) {
          h.push(`<div class='kv'><span class='k'>Next action</span><span>${e(s.nextAction)}${s.nextActionDate ? " · due " + e(s.nextActionDate) : ""}</span></div>`);
        }
        if (s._state === "draft") {
          h.push(`<div class='warn small'>Draft record — missing: ${e(s._missing.join(", "))}</div>`);
        }
        const imgs = ctx.photoIndex[s.id];
        if (imgs && imgs.length) {
          h.push("<div class='grid'>" + imgs.map((p) => `<img src='${p.url}' alt='${e(p.type || "photo")}'>`).join("") + "</div>");
        }
        h.push("</div>");
      }
    }

    h.push("<p class='small mut' style='margin-top:40px'>Generated by FairRecorder from on-site mobile records. "
      + "Scores reflect field observations recorded at the fair and are not a substitute for factory audit or certificate verification.</p>");
    h.push("</div><script>" + LIGHTBOX_JS + "</script></body></html>");
    return h.join("");
  }

  /* ---------------------- CSV (Excel-friendly, UTF-8 BOM) ---------------------- */
  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function csvRow(cells) { return cells.map(csvCell).join(","); }

  function masterRows(ctx) {
    const head = ["Supplier", "Chinese name", "Booth", "Hall/Area", "Categories", "Contact", "Title",
      "Phone", "WeChat", "Email", "Website", "Products", "MOQ", "Price", "Incoterm", "Lead time (d)",
      "Capacity", "Export markets", "EU/DE experience", "Source", "State", "Score", "Tier",
      "Follow-up", "Next action", "Due", "Notes"];
    const rows = [head];
    for (const s of ctx.suppliers) {
      rows.push([s.companyNameEn || "", s.companyNameZh || "", s.boothNo || "",
        [s.hall, s.area].filter(Boolean).join(" / "), catsEn(s).join("; "),
        s.contactName || "", s.contactTitle || "", s.phone || "", s.wechat || "", s.email || "", s.website || "",
        s.productDetails || "", moqText(s), priceText(s), s.incoterm || "", s.leadTimeDays || "",
        capText(s), marketsEn(s).join("; "), s.euGermanyExperience || "", sourceEn(s), s._state,
        s._rankable ? s._score : "not ranked", s._tier, followupEn(s), s.nextAction || "", s.nextActionDate || "",
        s.notes || ""]);
    }
    return rows;
  }
  function compareRows(ctx) {
    const head = ["Category", "Supplier", "Booth", "MOQ", "Price", "Lead time (d)", "EU/DE",
      "CE", "EN 14428", "EN 12150", "KTW", "Score", "Tier"];
    const rows = [head];
    for (const [, name, items] of grouped(ctx)) {
      for (const s of items) {
        rows.push([name, s._company, s.boothNo || "", moqText(s), priceText(s), s.leadTimeDays || "",
          s.euGermanyExperience || "", complianceEn(s, "CE"), complianceEn(s, "EN14428"),
          complianceEn(s, "EN12150"), complianceEn(s, "KTW"),
          s._rankable ? s._score : "not ranked", s._tier]);
      }
    }
    return rows;
  }
  function toCSV(ctx, kind) {
    const rows = kind === "compare" ? compareRows(ctx) : masterRows(ctx);
    return "\ufeff" + rows.map(csvRow).join("\r\n");
  }

  /* ---------------------- XLSX (SpreadsheetML, no external lib beyond JSZip) ---------------------- */
  function xmlEsc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  }
  function colName(i) {
    let n = i + 1, s = "";
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function sheetXml(rows, widths) {
    const cols = (widths || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("");
    const body = rows.map((r, ri) => {
      const cells = r.map((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      }).join("");
      const style = ri === 0 ? ' s="1"' : "";
      return `<row r="${ri + 1}"${style}>${cells}</row>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
  }
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF123A5E"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="1" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`;

  async function toXLSX(ctx) {
    if (typeof JSZip === "undefined") throw new Error("JSZip 未加载");
    const sheets = [
      { name: "Supplier Master", rows: masterRows(ctx), widths: [28, 22, 12, 14, 26, 14, 14, 16, 14, 24, 22, 40, 14, 18, 10, 10, 16, 24, 10, 12, 10, 8, 12, 12, 34, 12, 40] },
      { name: "Category Comparison", rows: compareRows(ctx), widths: [22, 28, 12, 14, 18, 10, 10, 14, 14, 14, 14, 8, 12] },
    ];
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>
${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}
</sheets></workbook>`);
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
    zip.file("xl/styles.xml", STYLES);
    sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths)));
    return await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  }

  /* ---------------------- delivery ---------------------- */
  const SHARE_TIMEOUT_MS = 45000;
  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  function fileName(ctx, ext) {
    const base = U().slugify(ctx.event.name || "fair") || "fair";
    return `Supplier_Report_${base}-${stamp()}.${ext}`;
  }
  async function share(blob, name, mime) {
    const file = new File([blob], name, { type: mime || blob.type || "application/octet-stream" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        /* 分享面板可能一直开着（用户去切微信、或桌面端根本没有可用面板），
         * 不能让它把导出流程吊死：超时后退回普通下载。 */
        await Promise.race([
          navigator.share({ files: [file], title: name }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("share timeout")), SHARE_TIMEOUT_MS)),
        ]);
        return true;
      } catch (err) { /* 用户取消或超时：退化成下载，不算失败 */ }
    }
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 60000);
    return false;
  }

  window.FRReport = {
    buildContext, renderHTML, toCSV, toXLSX, fileName, share, grouped,
    /* 预览：新窗口打开可打印的 HTML（含「Print / Save as PDF」按钮） */
    openPreview(html) {
      const blob = new Blob([html], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const w = window.open(url, "_blank");
      if (!w) {
        /* 弹窗被拦截时退回内嵌 iframe，由调用方渲染 */
        return url;
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      return w;
    },
  };
})();

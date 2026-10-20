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
          /* 宽高留给 DOCX 算图幅；拿不到就退回 4:3 */
          let w = 4, h = 3;
          try {
            const bmp = await createImageBitmap(small);
            w = bmp.width || 4; h = bmp.height || 3;
            if (bmp.close) bmp.close();
          } catch (err) { /* keep 4:3 */ }
          out.push({ id: p.id, type: p.type, highlightId: p.highlightId || null,
            w, h, url: await blobToDataURL(small) });
        } catch (err) { /* skip unreadable photo, never break the report */ }
      }
      if (out.length) photoIndex[s.id] = out;
      }
    }

    const fairs = fairIds.map((id) => fairMap[id]).filter(Boolean);
    const primary = fairs[0] || FR().fair || {};
    const dateTxt = [primary.startDate, (primary.endDate && primary.endDate !== primary.startDate) ? primary.endDate : ""]
      .filter(Boolean).join(" – ") || "";
    /* 观展总结（报告最后一项）：展会编辑页的多段文本框 */
    const summaryTxt = opts.summary != null ? String(opts.summary) : String(primary.summary || "");

    return {
      suppliers, plans, picks, photoIndex, weights, topN,
      fairs, fair: primary, summary: summaryTxt,
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
/* 名片 / 亮点产品：与基础信息用虚线隔开，否则一堆 kv 行糊成一片 */
.blk{margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)}
.blkt{font-size:13px;font-weight:700;color:var(--acc);letter-spacing:.3px;margin-bottom:8px}
.hl{border-left:3px solid var(--acc);padding:2px 0 8px 12px;margin:12px 0}
.hlt{font-size:15px;font-weight:700;margin-bottom:4px}
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
    design: "Looks off-brief, dated styling / Strong visual design that fits the range",
    quality: "Visible process shortcuts, uneven finish / Solid build, consistent finish",
    details: "Rough edges, poor sealing or hardware / Careful joints, edges and small parts",
  };

  /* ---------------------- 排版小工具 ----------------------
     同一个厂家的照片要分三处展示：名片单独一个网格、亮点产品的照片跟着各自那条
     亮点走、剩下的（展位 / 产品 / 证书 / 其它）统一进画廊。
     全混在一起时，报告读起来只是照片堆叠，而不是一份选型依据。 */
  function photoBuckets(ctx, s) {
    const cards = [], hl = {}, gal = [];
    for (const p of (ctx.photoIndex[s.id] || [])) {
      if (p.type === "namecard") cards.push(p);
      else if (p.highlightId) (hl[p.highlightId] = hl[p.highlightId] || []).push(p);
      else gal.push(p);
    }
    return { cards, hl, gal };
  }
  function gridHTML(list) {
    if (!list.length) return "";
    return "<div class='grid'>"
      + list.map((p) => `<img src='${p.url}' alt='${e(p.type || "photo")}'>`).join("") + "</div>";
  }
  function starsTxt(n) { return "★".repeat(n || 0) + "☆".repeat(5 - (n || 0)); }
  const CARD_FIELDS = [["name", "Name"], ["title", "Title"], ["phone", "Tel"], ["mobile", "Mobile"],
    ["email", "Email"], ["website", "Web"], ["address", "Address"], ["note", "Other"]];
  function cardRows(s) {
    const nc = s.namecard || {};
    return CARD_FIELDS.filter((f) => String(nc[f[0]] || "").trim())
      .map((f) => [f[1], String(nc[f[0]]).trim()]);
  }
  function summaryParas(ctx) {
    return String(ctx.summary || "").replace(/\r/g, "")
      .split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  }

  function supplierCard(ctx, s) {
    const b = photoBuckets(ctx, s);
    const notes = s.scoreNotes || {};
    const sc = s.score || {};
    const h = ["<div class='card'>"];
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
    /* 评分 + 每项评语：哪怕只填了一项也要输出，方便回头补 */
    if (C().SCORE_DIMS.some((d) => typeof sc[d[0]] === "number")) {
      h.push("<table><tr><th>Dimension</th><th>Weight</th><th>Rating</th><th>Comments</th></tr>");
      for (const d of C().SCORE_DIMS) {
        const v = sc[d[0]];
        h.push(`<tr><td>${e(d[2])}</td><td>${ctx.weights[d[0]] || 0}%</td>`
          + `<td>${typeof v === "number" ? starsTxt(v) + " " + v + "/5" : "—"}</td>`
          + `<td>${e(String(notes[d[0]] || "").trim() || "—")}</td></tr>`);
      }
      h.push("</table>");
    }
    /* 名片：照片 + 照抄下来的字段 */
    const rows = cardRows(s);
    if (rows.length || b.cards.length) {
      h.push("<div class='blk'><div class='blkt'>Name card</div>");
      h.push(rows.map((r) => `<div class='kv'><span class='k'>${e(r[0])}</span><span>${e(r[1])}</span></div>`).join(""));
      h.push(gridHTML(b.cards));
      h.push("</div>");
    }
    /* 亮点产品：一条一段，各自带照片和说明 */
    if ((s.highlights || []).length) {
      h.push("<div class='blk'><div class='blkt'>Highlight products</div>");
      for (const it of s.highlights) {
        h.push("<div class='hl'>");
        h.push(`<div class='hlt'>${e(it.title || "(untitled)")}</div>`);
        if (String(it.note || "").trim()) {
          h.push(`<div style='white-space:pre-wrap;font-size:14px;margin-bottom:8px'>${e(it.note)}</div>`);
        }
        h.push(gridHTML(b.hl[it.id] || []));
        h.push("</div>");
      }
      h.push("</div>");
    }
    /* 其余照片（展位 / 产品 / 证书 / 其它）单独成一栏，排在亮点产品之后。
       之前是直接挂在卡片末尾，读的人分不清这些图属于哪个板块，
       而且很容易被当成「亮点产品的续图」。 */
    if (b.gal.length) {
      h.push("<div class='blk'><div class='blkt'>Booth Photos</div>");
      h.push(gridHTML(b.gal));
      h.push("</div>");
    }
    h.push("</div>");
    return h.join("");
  }

  function renderHTML(ctx) {
    const ev = ctx.event;
    const total = ctx.suppliers.length;

    const h = [];
    h.push("<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>");
    h.push("<meta name='viewport' content='width=device-width,initial-scale=1'>");
    h.push(`<title>Supplier Report — ${e(ev.name)}</title><style>${CSS}</style></head><body><div class='wrap'>`);
    h.push("<button id='btnPrint' onclick='window.print()'>🖨 Print / Save as PDF</button>");

    h.push(`<h1>Supplier Report — ${e(ev.name)}</h1>`);
    h.push(`<div class='sub'>${[e(ev.phase), e(ev.dates), e(ev.venue)].filter(Boolean).join(" · ")}</div>`);
    h.push(`<div class='sub' style='margin-top:8px'>${ev.prepared_for ? "Prepared for: " + e(ev.prepared_for) + " · " : ""}Generated ${e(ctx.generated_at)}</div>`);

    /* 1 —— 只留总数统计，Executive Summary 其余内容全部删除 */
    h.push("<h2>1. Supplier List</h2><div class='card'>");
    h.push(`<div class='kv'><span class='k'>Suppliers recorded</span><span>${total}</span></div>`);
    h.push("</div>");

    /* 2 */
    h.push("<h2>2. Supplier Catalogue</h2>");
    const groups = grouped(ctx);
    if (!groups.length) h.push("<p class='small mut'>No supplier recorded yet.</p>");
    for (const [, name, items] of groups) {
      h.push(`<h3>${e(name)} — ${items.length} supplier(s)</h3>`);
      for (const s of items) h.push(supplierCard(ctx, s));
    }

    /* 3 —— 最后一项：观展总结，段落原样排版 */
    h.push("<h2>3. Fair Summary</h2><div class='card'>");
    const paras = summaryParas(ctx);
    if (paras.length) {
      h.push(paras.map((p) => `<p style='margin:0 0 12px;white-space:pre-wrap'>${e(p)}</p>`).join(""));
    } else {
      h.push("<p class='small mut'>No fair summary recorded.</p>");
    }
    h.push("</div>");

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
    const dims = C().SCORE_DIMS;
    const head = ["Supplier", "Chinese name", "Booth", "Hall/Area", "Categories", "Contact", "Title",
      "Phone", "WeChat", "Email", "Website", "Products", "MOQ", "Price", "Incoterm", "Lead time (d)",
      "Capacity", "Export markets", "EU/DE experience", "Source", "State", "Score", "Tier"];
    /* v1.7：三项评分先出数值再出各自的评语，方便按栏排序后还能看懂为什么 */
    for (const d of dims) head.push(d[2]);
    for (const d of dims) head.push(d[2] + " comments");
    for (const f of CARD_FIELDS) head.push("Card " + f[1].toLowerCase());
    head.push("Highlight products", "Follow-up", "Next action", "Due", "Notes");
    const rows = [head];
    for (const s of ctx.suppliers) {
      const sc = s.score || {}, sn = s.scoreNotes || {}, card = s.namecard || {};
      rows.push([s.companyNameEn || "", s.companyNameZh || "", s.boothNo || "",
        [s.hall, s.area].filter(Boolean).join(" / "), catsEn(s).join("; "),
        s.contactName || "", s.contactTitle || "", s.phone || "", s.wechat || "", s.email || "", s.website || "",
        s.productDetails || "", moqText(s), priceText(s), s.incoterm || "", s.leadTimeDays || "",
        capText(s), marketsEn(s).join("; "), s.euGermanyExperience || "", sourceEn(s), s._state,
        s._rankable ? s._score : "not ranked", s._tier]);
      for (const d of dims) rows[rows.length - 1].push(sc[d[0]] == null ? "" : sc[d[0]]);
      for (const d of dims) rows[rows.length - 1].push(String(sn[d[0]] || "").trim());
      for (const f of CARD_FIELDS) rows[rows.length - 1].push(String(card[f[0]] || "").trim());
      rows[rows.length - 1].push(hlText(s), followupEn(s), s.nextAction || "", s.nextActionDate || "",
        s.notes || "");
    }
    return rows;
  }
  /* 亮点产品压成一行文本：Excel 里一行厂家只占一行 */
  function hlText(s) {
    const list = s.highlights || [];
    if (!list.length) return "";
    return list.map((it) => {
      const bits = [];
      const t = String(it.title || "").trim();
      const n = String(it.note || "").trim().replace(/\s+/g, " ");
      if (t) bits.push(t);
      if (n) bits.push(n);
      return bits.join(" — ");
    }).filter(Boolean).join(" | ");
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
      { name: "Supplier Master", rows: masterRows(ctx),
        widths: [28, 22, 12, 14, 26, 14, 14, 16, 14, 24, 22, 40, 14, 18, 10, 10, 16, 24, 10, 12, 10, 8, 12,
                 8, 8, 8, 34, 34, 34,
                 16, 16, 14, 14, 22, 22, 26, 16,
                 40, 12, 34, 12, 40] },
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

  /* ---------------------- DOCX (WordprocessingML, 只依赖 JSZip) ----------------------
     和 HTML 报告同源：同一份 ctx、同样的三章结构、同样的照片。
     Python 那条链路仍在（scripts/build_report.py），两边口径刻意保持一致，
     手机临时出一份和回电脑重跑一份应当看不出差别。 */
  const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
  const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
  const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const E_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
  const EMU = 360000;                       // 1 cm，EMU 是 Word 里唯一的长度单位
  const BRAND = "1F1FAF";

  function wPara(text, opt) {
    opt = opt || {};
    const pr = [], rp = [];
    if (opt.style) pr.push(`<w:pStyle w:val="${opt.style}"/>`);
    if (opt.jc) pr.push(`<w:jc w:val="${opt.jc}"/>`);
    if (opt.before != null || opt.after != null) {
      pr.push(`<w:spacing ${opt.before != null ? `w:before="${opt.before}" ` : ""}`
        + `${opt.after != null ? `w:after="${opt.after}" ` : ""}/>`);
    }
    /* CT_RPr 里 (b, i, color, sz) 必须按这个顺序，Word 才不会挑刺 */
    if (opt.bold) rp.push("<w:b/>");
    if (opt.italic) rp.push("<w:i/>");
    if (opt.color) rp.push(`<w:color w:val="${opt.color}"/>`);
    if (opt.size) rp.push(`<w:sz w:val="${Math.round(opt.size * 2)}"/><w:szCs w:val="${Math.round(opt.size * 2)}"/>`);
    return String(text == null ? "" : text).split("\n").map((ln) =>
      `<w:p>${pr.length ? `<w:pPr>${pr.join("")}</w:pPr>` : ""}`
      + `<w:r>${rp.length ? `<w:rPr>${rp.join("")}</w:rPr>` : ""}`
      + `<w:t xml:space="preserve">${xmlEsc(ln)}</w:t></w:r></w:p>`).join("");
  }
  function wPageBreak() {
    return `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }
  function wTable(headers, rows, widths) {
    let x = `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>`
      + `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
        .map((t) => `<w:${t} w:val="single" w:sz="4" w:space="0" w:color="BFC6E0"/>`).join("")}</w:tblBorders>`
      + `<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>`
      + `<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr>`
      + `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>`;
    if (headers) {
      x += `<w:tr><w:trPr><w:tblHeader/></w:trPr>` + headers.map((h, i) =>
        `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/>`
        + `<w:shd w:val="clear" w:color="auto" w:fill="${BRAND}"/></w:tcPr>`
        + wPara(h, { bold: true, size: 9, color: "FFFFFF" }) + `</w:tc>`).join("") + `</w:tr>`;
    }
    for (const row of rows) {
      x += `<w:tr>` + row.map((v, i) => `<w:tc><w:tcPr><w:tcW w:w="${widths[i]}" w:type="dxa"/></w:tcPr>`
        + String(v == null ? "" : v).split("\n").map((ln) => wPara(ln, { size: 9 })).join("")
        + `</w:tc>`).join("") + `</w:tr>`;
    }
    return x + `</w:tbl>` + wPara("", { size: 4, after: 0 });
  }
  function picDrawing(rid, pid, name, cx, cy) {
    const nm = xmlEsc(name || "photo");
    return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">`
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
      + `<wp:docPr id="${pid}" name="${nm}"/>`
      + `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
      + `<a:graphic><a:graphicData uri="${PIC_NS}">`
      + `<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${nm}"/>`
      + `<pic:cNvPicPr><a:picLocks noChangeAspect="1" noChangeArrowheads="1"/></pic:cNvPicPr></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${rid}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr bwMode="auto"><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
      + `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></pic:spPr>`
      + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  }
  function wPicture(rid, pid, name, cx, cy) {
    return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r>`
      + picDrawing(rid, pid, name, cx, cy) + `</w:r></w:p>`;
  }
  /* dataURL → 字节：报告里照片本来就以 base64 存着，不必再单独记一份二进制 */
  function dataUrlBytes(url) {
    const b64 = String(url || "").split(",")[1] || "";
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  /* ---------- 图片排布 ----------
     页面可用宽约 17cm（A4 减左右 2cm 页边距）= 9639 twips。以前一张图占一段、
     单图最大 9cm，两页就翻完了，同批图还忽大忽小（受 maxH 挤压的方向不一致）。
     现在统一放进隐形表格：列数按张数定，每格同宽、同左右留白、顶端对齐，
     尺寸由所在列宽统一推算，横向排得下的就横向排。 */
  const AVAIL_W = 9639;
  const CELL_PAD = 90;      // 每格左右留白
  const MAX_SINGLE_H = 5103; // 9cm：单张大图的最高限，免得一张竖图吃掉半页
  function fitImage(p, cellW) {
    let cx = Math.max(600, (cellW || AVAIL_W) - CELL_PAD * 2);
    let cy = Math.round(cx * (p.h || 3) / (p.w || 4));
    const cap = arguments.length > 2 ? arguments[2] : MAX_SINGLE_H;
    if (cy > cap) { cy = cap; cx = Math.round(cy * (p.w || 4) / (p.h || 3)); }
    return [cx, cy];
  }

  /* toDOCX 内部调用：把一组图排成 cols 列的隐形表格 */
  function picGrid(list, cols, embed, pidRef) {
    if (!list || !list.length) return "";
    /* 单张时不撑满版心（12cm 更耐看），多张时才用满左边到右边的 17cm */
    const totalW = cols === 1 ? Math.min(AVAIL_W, 6804) : AVAIL_W;
    const colW = Math.floor(totalW / cols);
    let x = `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>`
      + `<w:tblLayout w:type="fixed"/>`
      + `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
        .map((t) => `<w:${t} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`).join("")}</w:tblBorders>`
      + `<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="${CELL_PAD}" w:type="dxa"/>`
      + `<w:bottom w:w="0" w:type="dxa"/><w:right w:w="${CELL_PAD}" w:type="dxa"/></w:tblCellMar>`
      + `</w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join("")}</w:tblGrid>`;
    for (let r = 0; r < list.length; r += cols) {
      x += "<w:tr>";
      for (let c = 0; c < cols; c++) {
        const p = list[r + c];
        x += `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/><w:vAlign w:val="top"/></w:tcPr>`;
        if (p) {
          const i = embed(p);
          if (i) {
            const [cx, cy] = fitImage(p, colW);
            pidRef.n++;
            x += `<w:p><w:pPr><w:spacing w:before="40" w:after="40" w:line="240" w:lineRule="auto"/>`
              + `<w:jc w:val="center"/></w:pPr><w:r>`
              + picDrawing("rIdImg" + i, pidRef.n, p.type || "photo", cx, cy) + `</w:r></w:p>`;
          } else { x += wPara("", { size: 2, after: 0 }); }
        } else {
          x += wPara("", { size: 2, after: 0 });   // 末尾不满一行时占个空位，保证列宽不塌
        }
        x += "</w:tc>";
      }
      x += "</w:tr>";
    }
    return x + "</w:tbl>" + wPara("", { size: 4, after: 0 });
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
 <w:pPr><w:spacing w:after="80"/></w:pPr>
 <w:rPr><w:b/><w:color w:val="${BRAND}"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>
 <w:pPr><w:outlineLvl w:val="0"/><w:keepNext/><w:spacing w:before="320" w:after="140"/>
  <w:pBdr><w:bottom w:val="single" w:sz="8" w:space="3" w:color="${BRAND}"/></w:pBdr></w:pPr>
 <w:rPr><w:b/><w:color w:val="${BRAND}"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>
 <w:pPr><w:outlineLvl w:val="1"/><w:keepNext/><w:spacing w:before="260" w:after="100"/></w:pPr>
 <w:rPr><w:b/><w:color w:val="${BRAND}"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/>
 <w:pPr><w:outlineLvl w:val="2"/><w:keepNext/><w:spacing w:before="200" w:after="80"/></w:pPr>
 <w:rPr><w:b/><w:color w:val="22263A"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
</w:styles>`;

  async function toDOCX(ctx) {
    if (typeof JSZip === "undefined") throw new Error("JSZip 未加载");
    const zip = new JSZip();
    const media = [], rels = [];
    let pid = 0;
    const embed = (p, label) => {
      const bytes = dataUrlBytes(p.url);
      if (!bytes) return;
      const i = media.length + 1;
      media.push(bytes);
      rels.push({ id: "rIdImg" + i, type: E_NS, target: `media/img${i}.jpg` });
      return i;
    };
    /* 一组照片排成隐形表格：1 张单列、2 张两列、3 张及以上三列 */
    const pidRef = { n: pid };
    const pic = (list) => {
      const n = (list || []).length;
      if (!n) return "";
      return picGrid(list, n === 1 ? 1 : n === 2 ? 2 : 3, embed, pidRef);
    };

    const ev = ctx.event;
    let body = "";
    body += wPara("Supplier Report", { style: "Title" });
    body += wPara(ev.name, { bold: true, size: 13, after: 40 });
    body += wPara([ev.phase, ev.dates, ev.venue].filter(Boolean).join(" · "), { size: 10 });
    body += wPara("Prepared for: " + (ev.prepared_for || "—"), { size: 10 });
    body += wPara("Generated " + ctx.generated_at, { size: 8, italic: true, color: "5C6480" });

    /* 1 —— 只留总数统计 */
    body += wPageBreak();
    body += wPara("1. Supplier List", { style: "Heading1" });
    body += wTable(["Metric", "Value"], [["Suppliers recorded", ctx.suppliers.length]], [3600, 3600]);

    /* 2 —— 供应商档案：基础信息 + 评分评语 + 名片 + 亮点产品 + 展位照片
       这里不再插分页：第 1 章往往只有一行统计，硬分一页就白留了大半页空白，
       让 Word 自己顺着排，章节之间靠 Heading 的段前间距分隔。 */
    body += wPara("2. Supplier Catalogue", { style: "Heading1" });
    const groups = grouped(ctx);
    if (!groups.length) body += wPara("No supplier recorded yet.", { size: 10, italic: true });
    for (const [, name, items] of groups) {
      body += wPara(`${name} — ${items.length} supplier(s)`, { style: "Heading2" });
      for (const s of items) {
        const b = photoBuckets(ctx, s);
        const notes = s.scoreNotes || {}, sc = s.score || {};
        body += wPara(s._company + (s._score != null ? `  ·  ${s._score}/100 (${s._tier})` : `  ·  ${s._tier}`),
          { style: "Heading3" });
        const contact = [s.contactName, s.contactTitle].filter(Boolean).join(" / ") || "—";
        const ways = [s.phone, s.wechat, s.email].filter(Boolean).join(" · ");
        body += wTable(["Field", "Value"], [
          ["Booth", boothText(s)],
          ["Contact", contact + (ways ? " · " + ways : "")],
          ["Categories", catsEn(s).join(", ") || "—"],
          ["Products", s.productDetails || "—"],
          ["Capacity", capText(s)],
          ["Export markets", marketsEn(s).join(", ") || "—"],
          ["EU / DE experience", s.euGermanyExperience || "Unknown"],
          ["Source", sourceEn(s)],
          ["Notes", s.notes || "—"],
          ["Next action", s.nextAction
            ? s.nextAction + (s.nextActionDate ? " · due " + s.nextActionDate : "") : "—"],
          ["Record state", s._state + (s._missing.length ? " — missing " + s._missing.join(", ") : "")],
        ], [2400, 6600]);

        if (C().SCORE_DIMS.some((d) => typeof sc[d[0]] === "number")) {
          const dims = C().SCORE_DIMS;
          body += wTable(["Dimension", "Weight", "Rating", "Comments"],
            dims.map((d) => [d[2], (ctx.weights[d[0]] || 0) + "%",
              typeof sc[d[0]] === "number" ? `${sc[d[0]]}/5 ${starsTxt(sc[d[0]])}` : "—",
              String(notes[d[0]] || "").trim() || "—"]),
            [2000, 1100, 1600, 4300]);
        }

        const rows = cardRows(s);
        if (rows.length || b.cards.length) {
          body += wPara("Name card", { bold: true, size: 11, color: BRAND, before: 140, after: 60 });
          if (rows.length) body += wTable(["Field", "Value"], rows, [2400, 6600]);
          body += pic(b.cards);
        }

        if ((s.highlights || []).length) {
          body += wPara("Highlight products", { bold: true, size: 11, color: BRAND, before: 140, after: 60 });
          for (const it of s.highlights) {
            body += wPara(it.title || "(untitled)", { bold: true, size: 10 });
            if (String(it.note || "").trim()) {
              body += String(it.note).trim().split("\n").map((ln) => wPara(ln, { size: 10 })).join("");
            }
            body += pic(b.hl[it.id] || []);
          }
        }

        /* 亮点产品之外的其余照片单独成一栏，不与上面的板块混排 */
        if (b.gal.length) {
          body += wPara("Booth Photos", { bold: true, size: 11, color: BRAND, before: 140, after: 60 });
          body += pic(b.gal);
        }
      }
    }

    /* 3 —— 最后一项：观展总结（同样不强制分页，接在上一章后面） */
    body += wPara("3. Fair Summary", { style: "Heading1" });
    const paras = summaryParas(ctx);
    if (paras.length) {
      for (const p of paras) {
        body += String(p).split("\n").map((ln) => wPara(ln, { size: 10.5 })).join("");
      }
    } else {
      body += wPara("No fair summary recorded.", { size: 10, italic: true });
    }

    body += wPara("Generated by FairRecorder from on-site mobile records. Scores reflect field observations "
      + "recorded at the fair and are not a substitute for factory audit or certificate verification.",
      { size: 8, italic: true, color: "5C6480", before: 240 });

    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134"
 w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

    const iso = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${media.length ? '<Default Extension="jpg" ContentType="image/jpeg"/>' : ""}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("")}
</Relationships>`);
    zip.file("word/styles.xml", STYLES_XML);
    zip.file("word/document.xml", doc);
    media.forEach((bytes, i) => zip.file(`word/media/img${i + 1}.jpg`, bytes));
    zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEsc(ev.name)}</dc:title><dc:creator>FairRecorder</dc:creator>
<cp:lastModifiedBy>FairRecorder</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`);
    zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>FairRecorder</Application></Properties>`);

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
    buildContext, renderHTML, toCSV, toXLSX, toDOCX, fileName, share, grouped,
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

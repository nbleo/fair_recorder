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
      const bySup = {};
      for (const p of photoPool) {
        if (!p.supplierId) continue;
        (bySup[p.supplierId] = bySup[p.supplierId] || []).push(p);
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
  const CSS = `
:root{--bg:#0f1524;--card:#162034;--line:#26334d;--txt:#e8eef7;--mut:#93a3bc;--acc:#22d3a6}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
 font:16px/1.6 -apple-system,"Segoe UI",Helvetica,Arial,"PingFang SC",sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:32px 24px 80px}
h1{font-size:28px;margin:0 0 6px}
h2{font-size:21px;margin:38px 0 12px;padding-bottom:8px;border-bottom:2px solid var(--acc)}
h3{font-size:17px;margin:22px 0 8px}
.sub{color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:14px;margin:10px 0}
th,td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:#123a5e;color:#fff;font-weight:600}
.kv{display:flex;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);font-size:14px}
.kv .k{color:var(--mut);min-width:170px;flex:0 0 auto}
.grid{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
.grid img{width:180px;height:135px;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;margin-right:6px}
.b-short{background:#0f3328;color:#7ff2d0}.b-follow{background:#123a5e;color:#9ecdff}
.b-res{background:#332a0d;color:#ffd591}.b-low{background:#3a1620;color:#ffb3c0}
.b-draft{background:#3a1620;color:#ffb3c0}
.warn{background:#3a2a0d;border:1px solid #6b4d12;color:#ffd591;border-radius:12px;padding:12px 14px;margin:10px 0;font-size:14px}
.mut{color:var(--mut)}.small{font-size:13px}
#btnPrint{position:fixed;right:14px;bottom:14px;z-index:99;background:#22d3a6;color:#04231c;
 border:none;border-radius:999px;padding:12px 18px;font:600 15px/1 -apple-system,sans-serif}
@media print{body{background:#fff;color:#000}.card{border-color:#bbb;background:#fff}
 th{background:#dde6f2;color:#000}#btnPrint{display:none}.warn{border-color:#999;color:#000;background:#fff}}
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
    const drafts = ctx.suppliers.filter((s) => s._state === "draft");
    const planned = ctx.suppliers.filter((s) => s.source === "planned");
    const walkin = ctx.suppliers.filter((s) => s.source === "walk_in");
    const manual = ctx.suppliers.filter((s) => s.source === "manual");
    const unvisited = ctx.plans.filter((p) => p.status !== "visited");
    const photoCount = Object.values(ctx.photoIndex).reduce((n, a) => n + a.length, 0);

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
    h.push(`<div class='kv'><span class='k'>Fully rated</span><span>${rated.length}</span></div>`);
    h.push(`<div class='kv'><span class='k'>Still draft (incomplete)</span><span>${drafts.length}</span></div>`);
    h.push(`<div class='kv'><span class='k'>Planned / walk-in / manual entry</span><span>${planned.length} / ${walkin.length} / ${manual.length}</span></div>`);
    h.push(`<div class='kv'><span class='k'>Planned but not visited</span><span>${unvisited.length}</span></div>`);
    h.push(`<div class='kv'><span class='k'>Photos captured</span><span>${photoCount}</span></div></div>`);
    if (ctx.picks.length) {
      h.push("<h3>Top recommendations</h3><table><tr><th>#</th><th>Supplier</th><th>Booth</th><th>Categories</th><th>Score</th><th>Tier</th></tr>");
      ctx.picks.forEach((s, i) => {
        h.push(`<tr><td>${i + 1}</td><td>${e(s._company)}</td><td>${e(s.boothNo || "—")}</td>`
          + `<td>${e(catsEn(s).join(", "))}</td><td>${s._score}</td><td>${e(s._tier)}</td></tr>`);
      });
      h.push("</table>");
    }
    const risks = ctx.suppliers.filter((s) => s._blockers.length);
    if (risks.length) {
      h.push(`<div class='warn'><b>${risks.length} supplier(s)</b> recorded a key compliance item as not available. `
        + "They can only be shortlisted conditionally, subject to documentary verification.</div>");
    }
    if (drafts.length) {
      h.push(`<div class='warn'>${drafts.length} record(s) are still drafts and miss mandatory fields; `
        + "they are listed for completeness but should not drive a sourcing decision yet.</div>");
    }

    /* 2 */
    h.push("<h2>2. Scope &amp; Methodology</h2><div class='card'>");
    h.push("<p class='small'>Records were captured on site with an offline-first mobile app (<i>FairRecorder</i>). "
      + "This report was generated directly on the recording device from the local database.</p>");
    h.push("<h3>Scoring weights</h3><table><tr><th>Dimension</th><th>Weight</th><th>Meaning of 1 / 5</th></tr>");
    for (const d of C().SCORE_DIMS) {
      h.push(`<tr><td>${e(d[2])}</td><td>${ctx.weights[d[0]] || 0}%</td><td>${e(MEANING[d[0]] || "")}</td></tr>`);
    }
    h.push("</table>");
    h.push("<p class='small'>Total score is the weighted sum on a 0–100 scale. A supplier is ranked only when all six "
      + "dimensions are filled. Tiers: ≥80 Shortlist, 70–79 Follow-up, 60–69 Reserve, &lt;60 Low priority.</p>");
    h.push("<h3>Compliance evidence states</h3><p class='small'>"
      + C().CSTAT.map((c) => `<b>${e(c[2])}</b>`).join(", ")
      + ". Only <i>Copy received</i> and <i>Document seen</i> constitute evidence; "
      + "<i>Supplier claimed</i> is an unverified statement and is reported as such.</p>");
    h.push("<h3>Price comparability</h3><p class='small'>Prices are only compared where currency, Incoterm and unit match. "
      + "Mixed bases are marked <i>Not directly comparable</i> rather than being ranked.</p></div>");

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
        h.push(`<div class='kv'><span class='k'>MOQ / Price / Lead time</span><span>`
          + `${e(moqText(s))} · ${e(priceText(s))} · ${e(leadText(s))}</span></div>`);
        h.push(`<div class='kv'><span class='k'>Capacity / Markets</span><span>${e(capText(s))} · `
          + `${e(marketsEn(s).join(", ") || "—")} · EU/DE experience: ${e(s.euGermanyExperience || "Unknown")}</span></div>`);
        const compRows = C().COMPLIANCE
          .filter((c) => complianceEn(s, c[0]) !== "Unknown")
          .map((c) => `<span class='badge b-follow'>${e(c[0])}: ${e(complianceEn(s, c[0]))}</span>`).join("");
        h.push(`<div class='kv'><span class='k'>Compliance</span><span>${compRows || "<span class='mut'>Unknown — nothing recorded</span>"}</span></div>`);
        if (s._blockers.length) {
          h.push(`<div class='warn'>Key item(s) marked not available: ${e(s._blockers.join(", "))} — conditional only, pending documentary verification.</div>`);
        }
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

    /* 4 */
    h.push("<h2>4. Comparison Matrix</h2>");
    for (const [, name, items] of groups) {
      const keys = new Set(items.filter((s) => priceText(s) !== "n/a")
        .map((s) => [s.currency, s.incoterm, s.priceUnit].join("|")));
      h.push(`<h3>${e(name)}${keys.size > 1 ? " — prices not directly comparable" : ""}</h3>`);
      h.push("<table><tr><th>Supplier</th><th>Booth</th><th>MOQ</th><th>Price</th><th>Lead time</th>"
        + "<th>EU/DE</th><th>CE</th><th>EN 14428</th><th>EN 12150</th><th>Score</th><th>Tier</th></tr>");
      for (const s of items) {
        h.push(`<tr><td>${e(s._company)}</td><td>${e(s.boothNo || "—")}</td><td>${e(moqText(s))}</td>`
          + `<td>${e(priceText(s))}</td><td>${e(leadText(s))}</td><td>${e(s.euGermanyExperience || "—")}</td>`
          + `<td>${e(complianceEn(s, "CE"))}</td><td>${e(complianceEn(s, "EN14428"))}</td>`
          + `<td>${e(complianceEn(s, "EN12150"))}</td><td>${s._rankable ? s._score : "not ranked"}</td>`
          + `<td>${e(s._tier)}</td></tr>`);
      }
      h.push("</table>");
    }

    /* 5 */
    h.push("<h2>5. Key Recommendations</h2>");
    if (!ctx.picks.length) {
      h.push("<div class='warn'>No supplier has a complete six-dimension rating yet, so no ranking is possible.</div>");
    }
    ctx.picks.forEach((s, i) => {
      const verdict = s._blockers.length ? "Conditional shortlist" : "Shortlist";
      const todo = [];
      if (s._missing.length) todo.push("complete the record (" + s._missing.join(", ") + ")");
      todo.push("request copies of CE / EN 14428 / EN 12150 declarations");
      if (C().COMPLIANCE.some((c) => ["Unknown", "Supplier claimed"].includes(complianceEn(s, c[0])))) {
        todo.push("verify claimed certificates against original documents");
      }
      todo.push("request a quotation with stated MOQ, Incoterm and lead time");
      h.push("<div class='card'>");
      h.push(`<h3 style='margin-top:0'>${i + 1}. ${e(s._company)} — ${e(s._tier)} (${s._score}/100)</h3>`);
      h.push(`<p class='small'>${e(recommendationText(s))}</p>`);
      h.push(`<div class='kv'><span class='k'>Verdict</span><span><b>${verdict}</b></span></div>`);
      const ways = [s.phone, s.wechat, s.email].filter(Boolean).join(" / ");
      h.push(`<div class='kv'><span class='k'>Contact</span><span>${e(s.contactName || "—")}${ways ? " · " + e(ways) : ""}</span></div>`);
      h.push(`<div class='kv'><span class='k'>Immediate actions</span><span>${e(todo.join("; "))}</span></div>`);
      h.push("</div>");
    });

    /* 6 */
    h.push("<h2>6. Next Steps &amp; Follow-up</h2><div class='card'><table>"
      + "<tr><th>Supplier</th><th>Follow-up status</th><th>Next action</th><th>Due</th></tr>");
    for (const s of ctx.suppliers) {
      if (s.followUpStatus === "reject") continue;
      h.push(`<tr><td>${e(s._company)}</td><td>${e(followupEn(s))}</td>`
        + `<td>${e(s.nextAction || "Send introduction and request documentation")}</td>`
        + `<td>${e(s.nextActionDate || "—")}</td></tr>`);
    }
    h.push("</table></div>");

    /* 7 */
    h.push("<h2>7. Appendix</h2><h3>7.1 Complete supplier list</h3>");
    h.push("<table><tr><th>#</th><th>Supplier</th><th>Booth</th><th>Categories</th><th>State</th><th>Score</th></tr>");
    ctx.suppliers.forEach((s, i) => {
      h.push(`<tr><td>${i + 1}</td><td>${e(s._company)}</td><td>${e(s.boothNo || "—")}</td>`
        + `<td>${e(catsEn(s).join(", "))}</td><td>${e(s._state)}</td><td>${s._rankable ? s._score : "not ranked"}</td></tr>`);
    });
    h.push("</table>");
    h.push("<h3>7.2 Planned suppliers not visited</h3>");
    if (unvisited.length) {
      h.push("<table><tr><th>Company</th><th>Booth</th><th>Goal</th><th>Priority</th></tr>");
      for (const p of unvisited) {
        h.push(`<tr><td>${e(p.companyName || "")}</td><td>${e(p.boothNo || "")}</td><td>${e(p.goal || "")}</td><td>${e(p.priority || "")}</td></tr>`);
      }
      h.push("</table>");
    } else {
      h.push("<p class='small mut'>None.</p>");
    }
    h.push("<h3>7.3 Data provenance</h3><div class='card small'>");
    h.push(`<div class='kv'><span class='k'>Source</span><span>On-device database (IndexedDB) · device ${e(String(FR().settings.deviceId || "").slice(0, 8))}</span></div>`);
    h.push(`<div class='kv'><span class='k'>Fairs in scope</span><span>${e(ctx.fairs.map((f) => f.nameEn || f.name).join("; ") || "—")}</span></div>`);
    h.push(`<div class='kv'><span class='k'>Weights applied</span><span>${e(C().SCORE_DIMS.map((d) => d[2] + " " + (ctx.weights[d[0]] || 0) + "%").join(" · "))}</span></div>`);
    h.push("</div>");
    h.push("<p class='small mut' style='margin-top:40px'>Generated by FairRecorder from on-site mobile records. "
      + "Scores reflect field observations recorded at the fair and are not a substitute for factory audit or certificate verification.</p>");
    h.push("</div></body></html>");
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

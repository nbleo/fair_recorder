"""Create demo exports so the whole pipeline can be exercised end to end.

Produces ZIPs for **two different fairs** (to prove the report splits per fair)
plus a day-2 revision of the first fair:

    FairRecorder-canton140-2-full-*.zip   140th Canton Fair, Phase II — day 1
    FairRecorder-canton140-2-daily-*.zip  same fair — day 2 (+ one revision)
    FairRecorder-kbc2026-full-*.zip       Shanghai KBC — a second, unrelated fair

Drop them all into inbox/ and run build_report.py; each fair gets its own folder.

v2.0：界面与报告全英文，样本里的自由文本（观展总结 / notes / 评分评语 / 计划目标）
也一并改成英文，只有公司中文名保留——那是"中文名"字段本身的取值，报告里与英文名并列。
"""
from __future__ import annotations

import hashlib
import io
import json
import uuid
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "sample"
SCHEMA = 2
# v1.7：设计 / 质量 / 细节三项，权重合计 100
WEIGHTS = {"design": 30, "quality": 50, "details": 20}
DAY1 = "2026-10-23T18:00:00+08:00"
DAY2 = "2026-10-24T19:30:00+08:00"
KBCDAY = "2026-05-27T17:20:00+08:00"

FAIR_A = "fair-2026-canton-140-phase2"
FAIR_B = "fair-2026-kbc-shanghai"

# 观展总结：报告最后一项原样输出这些段落（空行分段）
FAIR_A_SUMMARY = (
    "Eight factories visited over phase II, concentrated in the bathroom equipment and "
    "building materials halls. Slim frames and low-iron glass are now the default; what "
    "actually separates the good from the average is profile finishing and hinge feel.\n\n"
    "Shower enclosures: mainstream profile wall thickness is 1.2–1.5 mm, and the leading "
    "suppliers have moved to 1.0 mm slim frames. Supply of matching 6 mm tempered glass "
    "varies a lot and has to be confirmed case by case.\n\n"
    "Next: Jinsha (JS-8800) and Oulu (OL-T700) are worth taking to sampling; Xuhui Glass "
    "could not show an EN 12150 certificate on site and is dropped for this round."
)

FAIR_A_META = {
    "id": FAIR_A, "name": "第140届广交会 第二期", "nameEn": "140th Canton Fair — Phase II",
    "phase": "Phase II · Bathroom Equipment / Building & Decorative Materials",
    "city": "Guangzhou", "venue": "Canton Fair Complex", "area": "Bathroom Equipment",
    "startDate": "2026-10-23", "endDate": "2026-10-25",
    "slug": "2026-140th-canton-fair-phase-ii",
    "summary": FAIR_A_SUMMARY,
}
FAIR_B_META = {
    "id": FAIR_B, "name": "2026 上海 KBC 厨卫展", "nameEn": "Kitchen & Bath China 2026",
    "phase": "Kitchen & Bath", "city": "Shanghai", "venue": "SNIEC",
    "area": "Kitchen / Bathroom", "startDate": "2026-05-26", "endDate": "2026-05-29",
    "slug": "2026-kitchen-bath-china",
    "summary": "KBC was mostly smart toilets and vanities; few shower enclosure makers showed up, "
               "and the two we saw are roughly on par with the Canton Fair batch.",
}


def font(size: int):
    for p in ("C:/Windows/Fonts/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def make_image(title: str, sub: str, hue: int) -> bytes:
    w, h = 900, 675
    im = Image.new("RGB", (w, h), (hue % 255, 40, 60))
    d = ImageDraw.Draw(im)
    for y in range(h):
        d.line([(0, y), (w, y)], fill=(18 + y * 60 // h, 40 + y * 90 // h, 60 + y * 120 // h))
    d.rectangle([40, 40, w - 40, h - 40], outline=(200, 230, 255), width=4)
    f1, f2 = font(44), font(26)
    d.text((70, h // 2 - 60), title[:26], fill=(235, 245, 255), font=f1)
    d.text((70, h // 2 + 10), sub[:40], fill=(150, 200, 235), font=f2)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85, optimize=True)
    return buf.getvalue()


def comp(**kw):
    base = {c: {"status": "unknown", "certNo": ""} for c in
            ["CE", "EN14428", "EN12150", "KTW", "DWD", "REACH", "RoHS", "ISO9001"]}
    base.update({k: {"status": v, "certNo": n} for k, (v, n) in kw.items()})
    return base


def sup(**kw):
    s = {
        "id": kw.pop("id", str(uuid.uuid4())),
        "fairId": FAIR_A,
        "source": "walk_in", "previsitId": None,
        "companyNameZh": "", "companyNameEn": "", "hall": "Hall A", "area": "Bathroom Equipment",
        "boothNo": "",
        "contactName": "", "contactTitle": "", "phone": "", "wechat": "", "email": "", "website": "",
        "categories": [], "productDetails": "", "models": "",
        "moqValue": None, "moqUnit": "sets", "moqNote": "",
        "priceMin": None, "priceMax": None, "currency": "USD", "priceUnit": "set",
        "incoterm": "FOB", "priceBasis": "", "leadTimeDays": None, "capacityValue": None,
        "capacityUnit": "sets/month", "exportMarkets": [], "euGermanyExperience": "Unknown",
        "compliance": comp(), "score": {}, "photoIds": [],
        "followUpStatus": "new", "nextAction": "", "nextActionDate": "",
        # v2.0：intent 记"这次谈到什么程度 / 想推进到哪"，notes 记现场看到的客观细节
        "intent": "", "notes": "",
        "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None,
    }
    s.update(kw)
    return s


# --------------------------------------------------------------------------- #
# v1.7 —— 三项评分 + 每项评语、名片信息、亮点产品
# --------------------------------------------------------------------------- #
DIM_COMMENTS = {
    "design": {
        5: "Proportions and finish match the series; can go straight into the range",
        4: "Looks right, a couple of lines are conservative; modest tooling cost",
        3: "Dated shape, needs a new mould or a new front",
        2: "Too far from our positioning, not a short-term option",
        1: "Design is completely off",
    },
    "quality": {
        5: "Samples are consistent, no visible weld or curing defects",
        4: "Solid overall, minor shade variation possible between batches",
        3: "Average; incoming inspection must be tightened",
        2: "Clear process risk, not recommended for volume",
        1: "Process capability insufficient",
    },
    "details": {
        5: "Edges, magnetic strips and hardware all feel right",
        4: "Good detailing, a few parts still have burrs",
        3: "Corners and sealing are the weak points, tooling needs an upgrade",
        2: "Several sealing and edge problems",
        1: "Rough detailing",
    },
}
HIGHLIGHTS = {
    "s-0001": [("Slimline 10 mm frame", "Frame down to 10 mm with 8 mm glass; still to confirm "
                                       "whether 6 mm can be supplied with it.")],
    "s-0002": [("Magnetic soft-close lock DL-M3", "Closing noise under 30 dB, sample feels good; "
                                                 "life-cycle test report requested.")],
    "s-0003": [("Low-iron glass 8 mm", "Lower iron content than peers, noticeably whiter; "
                                       "about USD 3/m² dearer.")],
    "s-0011": [("Floor-standing toilet JT-300", "Rimless washdown pan, 3/6 L dual flush; "
                                                "P-trap 180/250 mm, same body for both.")],
    "s-0101": [("LS-6600 slim-frame range", "Build quality is good; roughly 12% cheaper than "
                                            "the Canton Fair batch.")],
}


def upgrade_v17(suppliers):
    """把样本升级到 v1.7 口径：三项评分 + 评语、名片信息、亮点产品。

    样本里保留了老六维评分的写法，正好顺带验证"旧数据导入后自动折算"这条路。
    """
    legacy = {"design": "fit", "details": "compliance"}
    for s in suppliers:
        sc = s.get("score") or {}
        new = {"quality": sc.get("quality", 3)}
        for key, old in legacy.items():
            v = sc.get(key, sc.get(old))
            new[key] = v if isinstance(v, int) else 3
        s["score"] = new
        s["scoreNotes"] = {d: DIM_COMMENTS[d].get(new.get(d, 3), "") for d in ("design", "quality", "details")}
        s["namecard"] = {
            "name": s.get("contactName", ""), "title": s.get("contactTitle", ""),
            "phone": s.get("phone", ""), "mobile": s.get("phone", ""),
            "email": s.get("email", ""), "website": s.get("website", ""),
            "address": "", "note": "Card is printed in Chinese; English name as recorded in the app",
        }
        s.setdefault("intent", "")
        s["highlights"] = [
            {"id": f"{s['id']}-hl{i + 1}", "title": t, "note": n, "createdAt": s.get("updatedAt", DAY1)}
            for i, (t, n) in enumerate(HIGHLIGHTS.get(s["id"], []))
        ]
    return suppliers


# --------------------------------------------------------------------------- #
# suppliers — 9 records for fair A with deliberately mixed completeness
# --------------------------------------------------------------------------- #
S1 = sup(
    id="s-0001", source="planned", previsitId="p-0001",
    companyNameZh="佛山市南海区金莎卫浴有限公司",
    companyNameEn="Jinsha Sanitary Ware Co., Ltd.",
    hall="Hall A", area="Bathroom Equipment", boothNo="10.2B31",
    contactName="陈伟", contactTitle="Sales",
    phone="+86 138 0013 8000", wechat="jinsha_chenwei", email="chen.wei@jinsha-sanitary.com",
    website="www.jinsha-sanitary.com",
    categories=["shower_enclosure", "tempered_glass"],
    productDetails="Frameless and semi-framed shower enclosures, 8 mm tempered glass, "
                   "aluminium profiles, own tempering line; OEM for two German brands.",
    models="JS-8800 / JS-9200",
    moqValue=50, priceMin=180, priceMax=260, currency="USD", incoterm="FOB", priceUnit="set",
    leadTimeDays=35, capacityValue=8000, capacityUnit="sets/month",
    exportMarkets=["Germany", "EU (other)"], euGermanyExperience="Yes",
    compliance=comp(CE=("copy_received", "CE-2025-1188"), EN14428=("document_seen", ""),
                    EN12150=("copy_received", "EN12150-2024-337"),
                    KTW=("supplier_claimed", ""), REACH=("copy_received", ""),
                    RoHS=("copy_received", ""), ISO9001=("document_seen", "ISO-2023-0451")),
    score={"fit": 5, "compliance": 5, "quality": 4, "price": 4, "capacity": 4, "communication": 5},
    followUpStatus="docs",
    intent="Qualify as a second source for complete enclosures, as HQ asked",
    nextAction="Request CE / EN 14428 copies and two German customer references",
    nextActionDate="2026-11-05",
    notes="Booth samples are well built; hinges come from their own mould. Claimed KTW but "
          "showed no document on site — must be verified.",
)

S2 = sup(
    id="s-0002",
    companyNameZh="中山市德立卫浴科技有限公司",
    companyNameEn="Deli Bathroom Technology Co., Ltd.",
    hall="Hall B", area="Bathroom Equipment", boothNo="11.1C05",
    categories=["tempered_glass"],
    productDetails="Tempered glass panels, 6–10 mm, edge polishing and drilling.",
    moqValue=200, currency="CNY", priceMin=95, priceMax=140, priceUnit="m²", incoterm="EXW",
    leadTimeDays=20, capacityValue=30000, capacityUnit="m²/month",
    exportMarkets=["EU (other)"], euGermanyExperience="Unknown",
    compliance=comp(EN12150=("supplier_claimed", ""), CE=("supplier_claimed", "")),
    score={"fit": 3, "compliance": 2, "quality": 3, "price": 4, "capacity": 4, "communication": 3},
    intent="Glass-only backup for the enclosure lines",
    notes="Only sales staff on the booth, no certificate shown; no business card either, "
          "needs a follow-up call.",
)

S3 = sup(
    id="s-0003", source="planned", previsitId="p-0002",
    companyNameZh="江门市华艺卫浴实业有限公司",
    companyNameEn="Huayi Sanitary Ware Industry Co., Ltd.",
    hall="Hall A", area="Bathroom Equipment", boothNo="9.3D12",
    contactName="李敏", contactTitle="Manager",
    phone="+86 139 0022 4455", wechat="huayi_limin", email="limin@huayi-bath.cn",
    categories=["hardware", "roller_hinge"],
    productDetails="Rollers, hinges, handles and profiles for sliding shower doors; "
                   "stainless steel 304, salt-spray tested 96 h.",
    models="HY-R45 / HY-H80",
    moqValue=500, priceMin=3.2, priceMax=6.5, currency="USD", priceUnit="pcs", incoterm="FOB",
    leadTimeDays=28, capacityValue=120000, capacityUnit="pcs/month",
    exportMarkets=["Germany", "North America", "EU (other)"],
    euGermanyExperience="Yes",
    compliance=comp(CE=("copy_received", ""), REACH=("copy_received", ""),
                    RoHS=("copy_received", ""), ISO9001=("copy_received", "ISO-2022-7710"),
                    EN14428=("supplier_claimed", ""), KTW=("not_available", "")),
    score={"fit": 5, "compliance": 4, "quality": 4, "price": 5, "capacity": 5, "communication": 4},
    followUpStatus="quote",
    intent="Move the roller and hinge business from the current trader to the factory itself",
    nextAction="Ask for a 40HQ mixed-load quote and the salt-spray test report",
    nextActionDate="2026-11-08",
    notes="Hardware detailing is good, roller noise test was convincing. KTW clearly not available.",
)

S4 = sup(
    id="s-0004",
    companyNameZh="广州瑞德玻璃制品有限公司",
    companyNameEn="Ruide Glass Products Co., Ltd.",
    hall="Hall C", area="Glass & Crafts", boothNo="12.2A18",
    contactName="王强", contactTitle="Owner",
    phone="+86 137 1234 5678", email="wq@ruide-glass.com",
    categories=["tempered_glass"],
    productDetails="Tempered and laminated glass for shower enclosures and furniture.",
    moqValue=300, currency="USD", priceMin=12, priceMax=22, priceUnit="m²", incoterm="FOB",
    leadTimeDays=25, capacityValue=20000, capacityUnit="m²/month",
    exportMarkets=["Middle East", "Asia (other)"], euGermanyExperience="No",
    compliance=comp(EN12150=("copy_received", "EN12150-2025-0091"),
                    CE=("document_seen", ""), EN14428=("not_available", ""),
                    REACH=("supplier_claimed", ""), RoHS=("unknown", ""), ISO9001=("document_seen", "")),
    score={"fit": 4, "compliance": 3, "quality": 3, "price": 4, "capacity": 3, "communication": 4},
    followUpStatus="hold",
    intent="Possible glass source for the standard range",
    notes="Glass quality is fine but no EN 14428 and no EU customer experience — on hold.",
)

S5 = sup(
    id="s-0005", source="planned", previsitId="p-0003",
    companyNameZh="佛山市顺德区欧陆卫浴制造有限公司",
    companyNameEn="Oulu Bathroom Manufacturing Co., Ltd.",
    hall="Hall A", area="Bathroom Equipment", boothNo="10.2B07",
    contactName="赵磊", contactTitle="Engineer",
    phone="+86 135 6677 8899", wechat="oulu_zhaolei", email="zhaolei@oulu-bath.com",
    categories=["shower_enclosure", "tray"],
    productDetails="Complete shower enclosures plus acrylic and stone-resin trays; "
                   "in-house moulding, 6 mm + 8 mm glass options.",
    models="OL-T700 / OL-E55",
    moqValue=80, currency="EUR", priceMin=145, priceMax=210, priceUnit="set", incoterm="FOB",
    leadTimeDays=40, capacityValue=5000, capacityUnit="sets/month",
    exportMarkets=["Germany", "UK", "EU (other)"], euGermanyExperience="Yes",
    compliance=comp(CE=("copy_received", "CE-2024-6602"), EN14428=("copy_received", "EN14428-2024-1180"),
                    EN12150=("copy_received", ""), KTW=("document_seen", ""), DWD=("unknown", ""),
                    REACH=("copy_received", ""), RoHS=("copy_received", ""),
                    ISO9001=("copy_received", "ISO-2021-9033")),
    score={"fit": 4, "compliance": 5, "quality": 4, "price": 3, "capacity": 3, "communication": 4},
    followUpStatus="sample",
    intent="Sampling candidate for the complete enclosure plus tray package",
    nextAction="Send 8 mm glass + stone tray samples to the German HQ",
    nextActionDate="2026-11-12",
    notes="The only one that showed both EN 14428 and KTW documents on site; price is high but "
          "compliance is the most complete.",
)

S6 = sup(
    id="s-0006",
    companyNameZh="宁波华辉五金制品厂",
    companyNameEn="Huahui Hardware Products Factory",
    hall="Hall B", area="Building Materials", boothNo="13.1E22",
    contactName="孙建国", contactTitle="Sales",
    phone="+86 136 5555 2211", wechat="huahui_sjg",
    categories=["hardware"],
    productDetails="General bathroom hardware, zinc alloy and brass fittings.",
    moqValue=1000, currency="CNY", priceMin=18, priceMax=45, priceUnit="pcs", incoterm="EXW",
    leadTimeDays=45, capacityValue=40000, capacityUnit="pcs/month",
    exportMarkets=["North America"], euGermanyExperience="No",
    compliance=comp(REACH=("supplier_claimed", "")),
    score={"fit": 2, "compliance": 2, "quality": 2, "price": 4, "capacity": 3, "communication": 3},
    followUpStatus="reject",
    intent="Cheap hardware backup only",
    notes="Low product tier and no EU experience; no follow-up.",
)

S7 = sup(
    id="s-0007", source="manual",
    companyNameZh="台州市中宇卫浴有限公司",
    companyNameEn="Zhongyu Bathroom Co., Ltd.",
    hall="Hall A", area="Bathroom Equipment", boothNo="10.2C33",
    contactName="周涛", contactTitle="Manager",
    phone="+86 130 8899 7766", email="zhou.tao@zhongyu-bath.cn",
    categories=["faucet_shower"],
    productDetails="Thermostatic shower sets and brass faucets.",
    moqValue=200, currency="USD", priceMin=42, priceMax=88, priceUnit="set", incoterm="FOB",
    leadTimeDays=30, exportMarkets=["EU (other)"], euGermanyExperience="Unknown",
    compliance=comp(CE=("supplier_claimed", "")),
    score={"fit": 3, "compliance": 2, "quality": 3, "price": 3, "capacity": 3, "communication": 3},
    intent="Thermostatic shower sets for the entry range",
    notes="Forgot to take photos, remembered back at the hotel; product shots requested on WeChat.",
)

S8 = sup(
    id="s-0008",
    companyNameZh="深圳市雅兰密封件有限公司",
    companyNameEn="Yalan Sealing Products Co., Ltd.",
    hall="Hall D", area="Building Materials", boothNo="14.2F09",
    contactName="吴芳", contactTitle="Sales",
    phone="+86 133 2211 3344", wechat="yalan_wufang", email="wufang@yalan-seal.com",
    categories=["seal"],
    productDetails="Magnetic strips, PVC and silicone seals for shower doors.",
    moqValue=3000, currency="CNY", priceMin=2.4, priceMax=5.8, priceUnit="m", incoterm="EXW",
    leadTimeDays=15, capacityValue=200000, capacityUnit="m/month",
    exportMarkets=["Germany", "EU (other)"], euGermanyExperience="Yes",
    compliance=comp(REACH=("copy_received", ""), RoHS=("copy_received", ""),
                    ISO9001=("document_seen", ""), CE=("unknown", "")),
    score={"fit": 4, "compliance": 3, "quality": 3, "price": 5, "capacity": 5, "communication": 4},
    followUpStatus="quote",
    intent="Price benchmark for seals, probably a volume play",
    nextAction="Ask for magnetic strip and silicone seal quotes (EXW converted to FOB)",
    nextActionDate="2026-11-06",
    notes="Specialist seal maker with a price advantage; cooperative and willing to sample.",
)

# --- 新增：普通马桶（落地式陶瓷，区别于智能马桶） ---------------------------
S11 = sup(
    id="s-0011", source="walk_in",
    companyNameZh="佛山市南海区景陶卫浴有限公司",
    companyNameEn="Jingtao Ceramics & Sanitary Ware Co., Ltd.",
    hall="Hall D", area="Bathroom Equipment", boothNo="15.1B12",
    contactName="梁志强", contactTitle="Sales",
    phone="+86 138 2233 4455", wechat="jingtao_liang", email="liang@jingtao-ceramics.cn",
    categories=["floor_toilet"],
    productDetails="Floor-standing ceramic toilets, washdown and siphon, 3/6 L dual flush, "
                   "P-trap 180 / 250 mm, own kiln and glaze line; EN 997 testing in progress.",
    models="JT-300 / JT-320",
    moqValue=200, currency="USD", priceMin=48, priceMax=76, priceUnit="set", incoterm="FOB",
    leadTimeDays=32, capacityValue=25000, capacityUnit="sets/month",
    exportMarkets=["Germany", "UK", "Middle East"], euGermanyExperience="Unknown",
    compliance=comp(CE=("supplier_claimed", ""), ISO9001=("document_seen", ""),
                    REACH=("supplier_claimed", "")),
    score={"fit": 4, "compliance": 2, "quality": 3, "price": 4, "capacity": 4, "communication": 3},
    followUpStatus="docs",
    intent="New floor-standing toilet source to complement the smart toilet range",
    nextAction="Ask for the EN 997 test report and a glaze defect sample set",
    nextActionDate="2026-11-10",
    notes="Rimless pan looked clean, glaze even in the corners. Water consumption marked 3/6 L "
          "but no EN 997 report yet — compliance is the open question.",
)

# --- 第二场展会（上海 KBC）：证明多展会互不干扰 ---------------------------
S9 = sup(
    id="s-0101", fairId=FAIR_B, source="planned", previsitId="p-0101",
    companyNameZh="杭州朗斯卫浴有限公司",
    companyNameEn="Langsi Bathroom Co., Ltd.",
    hall="W3", area="Kitchen / Bathroom", boothNo="W3-C18",
    contactName="何静", contactTitle="Manager",
    phone="+86 139 0571 2233", wechat="langsi_hejing", email="hejing@langsi-bath.cn",
    categories=["shower_enclosure", "vanity"],
    productDetails="Mid-range shower enclosures and bathroom vanities, 6 mm glass, "
                   "aluminium frame, own assembly line.",
    models="LS-6600",
    moqValue=60, currency="USD", priceMin=150, priceMax=225, priceUnit="set", incoterm="FOB",
    leadTimeDays=38, capacityValue=6000, capacityUnit="sets/month",
    exportMarkets=["EU (other)"], euGermanyExperience="Unknown",
    compliance=comp(CE=("copy_received", "CE-2025-3301"), EN14428=("document_seen", ""),
                    EN12150=("copy_received", ""), REACH=("copy_received", ""),
                    ISO9001=("copy_received", "ISO-2022-1180")),
    score={"fit": 4, "compliance": 4, "quality": 3, "price": 4, "capacity": 3, "communication": 4},
    followUpStatus="quote",
    intent="Second enclosure source, and the first quote in EUR",
    nextAction="Ask for a EUR quote and an EN 14428 copy", nextActionDate="2026-06-10",
    notes="Build quality at KBC was good and the price is slightly below the Canton Fair batch — "
          "usable as a backup.",
)

S10 = sup(
    id="s-0102", fairId=FAIR_B,
    companyNameZh="温州精工密封科技有限公司",
    companyNameEn="Jinggong Sealing Technology Co., Ltd.",
    hall="W2", area="Kitchen / Bathroom", boothNo="W2-A07",
    contactName="林峰", contactTitle="Engineer",
    phone="+86 137 5777 6611", email="linfeng@jg-seal.cn",
    categories=["seal"],
    productDetails="Silicone and TPE seals for shower doors, co-extruded magnetic strips.",
    moqValue=5000, currency="CNY", priceMin=3.1, priceMax=6.9, priceUnit="m", incoterm="EXW",
    leadTimeDays=18, capacityValue=150000, capacityUnit="m/month",
    exportMarkets=["Germany"], euGermanyExperience="Yes",
    compliance=comp(REACH=("copy_received", ""), RoHS=("copy_received", ""),
                    KTW=("document_seen", ""), ISO9001=("document_seen", "")),
    score={"fit": 4, "compliance": 4, "quality": 4, "price": 4, "capacity": 4, "communication": 4},
    followUpStatus="sample",
    intent="Seal supplier with KTW evidence — worth sampling",
    nextAction="Send samples: 5 m each of magnetic strip and silicone seal",
    nextActionDate="2026-06-08",
    notes="The only seal maker at KBC that showed a KTW document on site; worth sampling.",
)

PLANS = [
    {"id": "p-0001", "fairId": FAIR_A, "companyName": "佛山市南海区金莎卫浴有限公司", "boothNo": "10.2B31",
     "goal": "Priority: main supplier for complete enclosures", "priority": "A",
     "note": "German HQ asked us to look at this one",
     "status": "visited", "supplierId": "s-0001", "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0002", "fairId": FAIR_A, "companyName": "江门市华艺卫浴实业有限公司", "boothNo": "9.3D12",
     "goal": "Rollers and hinges", "priority": "A", "note": "", "status": "visited",
     "supplierId": "s-0003", "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0003", "fairId": FAIR_A, "companyName": "佛山市顺德区欧陆卫浴制造有限公司", "boothNo": "10.2B07",
     "goal": "Enclosure plus tray", "priority": "B", "note": "Most complete compliance file",
     "status": "visited", "supplierId": "s-0005", "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0004", "fairId": FAIR_A, "companyName": "广州理想淋浴房制造有限公司", "boothNo": "11.2B41",
     "goal": "Backup complete enclosure supplier", "priority": "B", "note": "Booth not found",
     "status": "planned", "supplierId": None, "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0005", "fairId": FAIR_A, "companyName": "佛山市南海区冠星卫浴有限公司", "boothNo": "10.2A15",
     "goal": "Trays and stone bases", "priority": "C", "note": "Ran out of time, skipped",
     "status": "skipped", "supplierId": None, "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
]

PLANS_B = [
    {"id": "p-0101", "fairId": FAIR_B, "companyName": "杭州朗斯卫浴有限公司", "boothNo": "W3-C18",
     "goal": "Backup complete enclosure supplier", "priority": "A", "note": "New face at KBC",
     "status": "visited", "supplierId": "s-0101", "createdAt": KBCDAY, "updatedAt": KBCDAY, "deletedAt": None},
    {"id": "p-0102", "fairId": FAIR_B, "companyName": "苏州未来卫浴科技有限公司", "boothNo": "W4-B22",
     "goal": "Smart shower enclosures", "priority": "C", "note": "Booth not found",
     "status": "planned", "supplierId": None, "createdAt": KBCDAY, "updatedAt": KBCDAY, "deletedAt": None},
]

# photos: (factory_id, type, title, hue)
PHOTO_SPEC = [
    ("s-0001", "booth", "Booth 10.2B31", 30),
    ("s-0001", "product", "Frameless enclosure JS-8800", 200),
    ("s-0001", "certificate", "CE / EN 12150 folder", 120),
    ("s-0002", "product", "Tempered glass panels 8mm", 90),
    ("s-0003", "booth", "Booth 9.3D12", 45),
    ("s-0003", "product", "Rollers & hinges HY-R45", 160),
    ("s-0003", "namecard", "Li Min - Manager", 10),
    ("s-0004", "product", "Tempered glass Ruide", 210),
    ("s-0005", "booth", "Booth 10.2B07", 55),
    ("s-0005", "product", "Enclosure + stone tray OL-T700", 240),
    ("s-0005", "certificate", "EN 14428 declaration", 130),
    ("s-0006", "product", "Zinc alloy hardware", 70),
    ("s-0008", "booth", "Booth 14.2F09", 20),
    ("s-0008", "product", "Magnetic seals & PVC strips", 180),
    ("s-0011", "product", "Floor-standing toilet JT-300", 100),
    ("s-0101", "booth", "Booth W3-C18", 35),
    ("s-0101", "product", "Enclosure LS-6600", 220),
    ("s-0102", "product", "Silicone & magnetic seals", 150),
]


def build_photos(all_suppliers):
    """Returns {photo_id: (bytes, meta)} and wires photoIds onto suppliers."""
    out = {}
    fair_of = {s["id"]: s.get("fairId") for s in all_suppliers}
    wanted = set(fair_of)
    for sid, ptype, title, hue in PHOTO_SPEC:
        if sid not in wanted:
            continue
        data = make_image(title, f"{title} · demo image", hue)
        pid = "ph-" + hashlib.sha1(f"{sid}{ptype}{title}".encode()).hexdigest()[:12]
        out[pid] = (data, {
            "id": pid, "fairId": fair_of.get(sid), "supplierId": sid, "type": ptype,
            "path": f"photos/{sid}/{pid}.jpg",
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data), "createdAt": DAY1,
        })
        for s in all_suppliers:
            if s["id"] == sid:
                s["photoIds"].append(pid)
    return out


def write_zip(path: Path, suppliers, plans, photos, created_at, mode, fair_meta):
    metas = [m for _, m in (photos[pid] for pid in sorted(photos))]
    ids = {s["id"] for s in suppliers}
    metas = [m for m in metas if m["supplierId"] in ids]
    event = {
        "name": fair_meta["nameEn"], "phase": fair_meta["phase"],
        "dates": f"{fair_meta['startDate']}..{fair_meta['endDate']}",
        "venue": f"{fair_meta['venue']} · {fair_meta['city']}",
    }
    bundle = {
        "schemaVersion": SCHEMA,
        "export": {
            "id": str(uuid.uuid4()), "deviceId": "demo-device", "createdAt": created_at, "mode": mode,
            "appVersion": "2.0.0",
            "counts": {"suppliers": len(suppliers), "photos": len(metas), "plans": len(plans), "tombstones": 0},
            "weights": WEIGHTS, "event": event,
        },
        "fair": dict(fair_meta),
        "suppliers": suppliers,
        "visitPlans": plans,
        "photos": metas,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("suppliers.json", json.dumps(bundle, ensure_ascii=False), compress_type=zipfile.ZIP_DEFLATED)
        for meta in metas:
            data, _ = photos[meta["id"]]
            z.writestr(meta["path"], data, compress_type=zipfile.ZIP_STORED)
    return path


def main() -> None:
    import copy
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.zip"):
        old.unlink()

    # ---- 展会 A：广交会第二期，两天两次导出 ----
    day1 = upgrade_v17([copy.deepcopy(s) for s in (S1, S2, S3, S4, S6)])
    day2_src = upgrade_v17([copy.deepcopy(s) for s in (S5, S7, S8, S11)])
    photosA = build_photos(day1 + day2_src)

    # day 2 also revises S1 (booth corrected + note) — exercises "newest wins" upsert.
    # Copy from the day-1 record so the photo links travel with the revision.
    s1b = copy.deepcopy(next(s for s in day1 if s["id"] == "s-0001"))
    s1b["boothNo"] = "10.2B31A"
    s1b["updatedAt"] = DAY2
    s1b["notes"] += " Correction: the booth number is 10.2B31A."

    for s in day2_src:
        s["createdAt"] = DAY2
        s["updatedAt"] = DAY2

    p1 = write_zip(OUT / "FairRecorder-canton140-2-full-20261023-1800.zip",
                   day1, PLANS, photosA, DAY1, "full", FAIR_A_META)
    p2 = write_zip(OUT / "FairRecorder-canton140-2-daily-20261024-1930.zip",
                   day2_src + [s1b], PLANS, photosA, DAY2, "daily", FAIR_A_META)

    # ---- 展会 B：上海 KBC，完全独立的一份导出 ----
    fairB = upgrade_v17([copy.deepcopy(s) for s in (S9, S10)])
    for s in fairB:
        s["createdAt"] = KBCDAY
        s["updatedAt"] = KBCDAY
    photosB = build_photos(fairB)
    p3 = write_zip(OUT / "FairRecorder-kbc2026-full-20260527-1720.zip",
                   fairB, PLANS_B, photosB, KBCDAY, "full", FAIR_B_META)

    for p in (p1, p2, p3):
        print("wrote", p)
    print(f"fair A: 9 factories / {len(photosA)} photos (2 exports); "
          f"fair B: {len(fairB)} factories / {len(photosB)} photos (1 export)")
    print("S7 intentionally has NO photo -> will show up as draft (missing photo)")


if __name__ == "__main__":
    main()

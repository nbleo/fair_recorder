"""Create demo exports so the whole pipeline can be exercised end to end.

Produces ZIPs for **two different fairs** (to prove the report splits per fair)
plus a day-2 revision of the first fair:

    FairRecorder-canton140-2-full-*.zip   140th Canton Fair, Phase II — day 1
    FairRecorder-canton140-2-daily-*.zip  same fair — day 2 (+ one revision)
    FairRecorder-kbc2026-full-*.zip       Shanghai KBC — a second, unrelated fair

Drop them all into inbox/ and run build_report.py; each fair gets its own folder.
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
    "本次广交会二期共走访 8 家，集中在 A/B 区卫浴设备与建筑装饰材料两个展区。"
    "整体感受是窄边框与超白玻已经成为标配，真正拉开差距的是型材收口与五金手感。\n\n"
    "淋浴房整体：主流壁厚做到 1.2–1.5mm，几家头部厂开始推 1.0mm 超窄边框，"
    "但配套 6mm 钢化的供应能力参差，需要单独确认。\n\n"
    "待跟进：金莎（JS-8800）与德立（DL-S900）值得进入打样环节；"
    "旭晖玻璃的 EN 12150 现场确认无法提供，本轮不纳入。"
)

FAIR_A_META = {
    "id": FAIR_A, "name": "第140届广交会 第二期", "nameEn": "140th Canton Fair — Phase II",
    "phase": "Phase II · Bathroom Equipment / Building & Decorative Materials",
    "city": "广州", "venue": "广交会展馆", "area": "卫浴设备",
    "startDate": "2026-10-23", "endDate": "2026-10-25",
    "slug": "2026-140th-canton-fair-phase-ii",
    "summary": FAIR_A_SUMMARY,
}
FAIR_B_META = {
    "id": FAIR_B, "name": "2026 上海 KBC 厨卫展", "nameEn": "Kitchen & Bath China 2026",
    "phase": "Kitchen & Bath", "city": "上海", "venue": "上海新国际博览中心",
    "area": "厨房 / 卫浴", "startDate": "2026-05-26", "endDate": "2026-05-29",
    "slug": "2026-kitchen-bath-china",
    "summary": "上海 KBC 主要看智能马桶与浴室柜，淋浴房厂商参展不多，两家的样品水平与广交会基本持平。",
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
        "companyNameZh": "", "companyNameEn": "", "hall": "A区", "area": "卫浴设备", "boothNo": "",
        "contactName": "", "contactTitle": "", "phone": "", "wechat": "", "email": "", "website": "",
        "categories": [], "productDetails": "", "models": "",
        "moqValue": None, "moqUnit": "sets 套", "moqNote": "",
        "priceMin": None, "priceMax": None, "currency": "USD", "priceUnit": "set",
        "incoterm": "FOB", "priceBasis": "", "leadTimeDays": None, "capacityValue": None,
        "capacityUnit": "sets/month", "exportMarkets": [], "euGermanyExperience": "Unknown",
        "compliance": comp(), "score": {}, "photoIds": [],
        "followUpStatus": "new", "nextAction": "", "nextActionDate": "", "notes": "",
        "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None,
    }
    s.update(kw)
    return s


# --------------------------------------------------------------------------- #
# v1.7 —— 三项评分 + 每项评语、名片信息、亮点产品
# --------------------------------------------------------------------------- #
DIM_COMMENTS = {
    "design": {
        5: "造型与配色契合系列定位，可以直接进方案",
        4: "外观在线，个别线条偏保守，改模成本不高",
        3: "造型偏老，需要重新开模或换面",
        2: "设计与我们定位差距较大，短期不考虑",
        1: "设计完全不对路",
    },
    "quality": {
        5: "样品一致性好，焊缝与固化看不出瑕疵",
        4: "整体做工稳，批次之间可能有轻微色差",
        3: "做工一般，需要加严来料检验",
        2: "工艺风险明显，不建议直接进入量产",
        1: "工艺能力不足",
    },
    "details": {
        5: "收口、磁条与五金手感都到位",
        4: "细节处理不错，个别零件有毛刺",
        3: "边角与密封是短板，需要升级模具",
        2: "密封与收口问题较多",
        1: "细节处理粗糙",
    },
}
HIGHLIGHTS = {
    "s-0001": [("Slimline 10mm 超窄边框", "边框做到 10mm，配 8mm 钢化；需确认 6mm 能否配套供应。")],
    "s-0002": [("磁吸静音门锁 DL-M3", "关门噪音 30dB 以内，样机手感好，已索取寿命测试报告。")],
    "s-0003": [("超白玻 8mm", "含铁量低于同行，透光偏白；价格每平米高约 3 USD。")],
    "s-0101": [("LS-6600 简框系列", "整机做工不错，价格比广交会那批低约 12%。")],
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
            "address": "", "note": "名片为中文印刷；抬头英文名以录入为准",
        }
        s["highlights"] = [
            {"id": f"{s['id']}-hl{i + 1}", "title": t, "note": n, "createdAt": s.get("updatedAt", DAY1)}
            for i, (t, n) in enumerate(HIGHLIGHTS.get(s["id"], []))
        ]
    return suppliers


# --------------------------------------------------------------------------- #
# suppliers — 8 records with deliberately mixed completeness
# --------------------------------------------------------------------------- #
S1 = sup(
    id="s-0001", source="planned", previsitId="p-0001",
    companyNameZh="佛山市南海区金莎卫浴有限公司",
    companyNameEn="Jinsha Sanitary Ware Co., Ltd.",
    hall="A区", area="卫浴设备", boothNo="10.2B31",
    contactName="陈伟", contactTitle="Sales 销售",
    phone="+86 138 0013 8000", wechat="jinsha_chenwei", email="chen.wei@jinsha-sanitary.com",
    website="www.jinsha-sanitary.com",
    categories=["shower_enclosure", "tempered_glass"],
    productDetails="Frameless and semi-framed shower enclosures, 8 mm tempered glass, "
                   "aluminium profiles, own tempering line; OEM for two German brands.",
    models="JS-8800 / JS-9200",
    moqValue=50, priceMin=180, priceMax=260, currency="USD", incoterm="FOB", priceUnit="set",
    leadTimeDays=35, capacityValue=8000, capacityUnit="sets/month",
    exportMarkets=["Germany 德国", "EU (other) 欧盟其他"], euGermanyExperience="Yes",
    compliance=comp(CE=("copy_received", "CE-2025-1188"), EN14428=("document_seen", ""),
                    EN12150=("copy_received", "EN12150-2024-337"),
                    KTW=("supplier_claimed", ""), REACH=("copy_received", ""),
                    RoHS=("copy_received", ""), ISO9001=("document_seen", "ISO-2023-0451")),
    score={"fit": 5, "compliance": 5, "quality": 4, "price": 4, "capacity": 4, "communication": 5},
    followUpStatus="docs", nextAction="索取 CE / EN 14428 证书副本与德国客户参考",
    nextActionDate="2026-11-05",
    notes="展位样品做工扎实，铰链为自有模具。声称有 KTW 但现场未出示文件，必须核验。",
)

S2 = sup(
    id="s-0002",
    companyNameZh="中山市德立卫浴科技有限公司",
    companyNameEn="Deli Bathroom Technology Co., Ltd.",
    hall="B区", area="卫浴设备", boothNo="11.1C05",
    categories=["tempered_glass"],
    productDetails="Tempered glass panels, 6–10 mm, edge polishing and drilling.",
    moqValue=200, currency="CNY", priceMin=95, priceMax=140, priceUnit="m²", incoterm="EXW",
    leadTimeDays=20, capacityValue=30000, capacityUnit="m²/month",
    exportMarkets=["EU (other) 欧盟其他"], euGermanyExperience="Unknown",
    compliance=comp(EN12150=("supplier_claimed", ""), CE=("supplier_claimed", "")),
    score={"fit": 3, "compliance": 2, "quality": 3, "price": 4, "capacity": 4, "communication": 3},
    notes="现场只有销售，未提供任何证书；未拿到联系人名片，需回访补齐。",
)

S3 = sup(
    id="s-0003", source="planned", previsitId="p-0002",
    companyNameZh="江门市华艺卫浴实业有限公司",
    companyNameEn="Huayi Sanitary Ware Industry Co., Ltd.",
    hall="A区", area="卫浴设备", boothNo="9.3D12",
    contactName="李敏", contactTitle="Manager 经理",
    phone="+86 139 0022 4455", wechat="huayi_limin", email="limin@huayi-bath.cn",
    categories=["hardware", "roller_hinge"],
    productDetails="Rollers, hinges, handles and profiles for sliding shower doors; "
                   "stainless steel 304, salt-spray tested 96 h.",
    models="HY-R45 / HY-H80",
    moqValue=500, priceMin=3.2, priceMax=6.5, currency="USD", priceUnit="pcs", incoterm="FOB",
    leadTimeDays=28, capacityValue=120000, capacityUnit="pcs/month",
    exportMarkets=["Germany 德国", "North America 北美", "EU (other) 欧盟其他"],
    euGermanyExperience="Yes",
    compliance=comp(CE=("copy_received", ""), REACH=("copy_received", ""),
                    RoHS=("copy_received", ""), ISO9001=("copy_received", "ISO-2022-7710"),
                    EN14428=("supplier_claimed", ""), KTW=("not_available", "")),
    score={"fit": 5, "compliance": 4, "quality": 4, "price": 5, "capacity": 5, "communication": 4},
    followUpStatus="quote", nextAction="索要 40HQ 混装报价与盐雾测试报告",
    nextActionDate="2026-11-08",
    notes="五金件细节处理到位，滑轮静音测试表现好。KTW 明确表示没有。",
)

S4 = sup(
    id="s-0004",
    companyNameZh="广州瑞德玻璃制品有限公司",
    companyNameEn="Ruide Glass Products Co., Ltd.",
    hall="C区", area="玻璃工艺品", boothNo="12.2A18",
    contactName="王强", contactTitle="Owner 负责人",
    phone="+86 137 1234 5678", email="wq@ruide-glass.com",
    categories=["tempered_glass"],
    productDetails="Tempered and laminated glass for shower enclosures and furniture.",
    moqValue=300, currency="USD", priceMin=12, priceMax=22, priceUnit="m²", incoterm="FOB",
    leadTimeDays=25, capacityValue=20000, capacityUnit="m²/month",
    exportMarkets=["Middle East 中东", "Asia (other) 亚洲其他"], euGermanyExperience="No",
    compliance=comp(EN12150=("copy_received", "EN12150-2025-0091"),
                    CE=("document_seen", ""), EN14428=("not_available", ""),
                    REACH=("supplier_claimed", ""), RoHS=("unknown", ""), ISO9001=("document_seen", "")),
    score={"fit": 4, "compliance": 3, "quality": 3, "price": 4, "capacity": 3, "communication": 4},
    followUpStatus="hold",
    notes="玻璃质量不错但没有 EN 14428，且无欧盟客户经验，暂缓。",
)

S5 = sup(
    id="s-0005", source="planned", previsitId="p-0003",
    companyNameZh="佛山市顺德区欧陆卫浴制造有限公司",
    companyNameEn="Oulu Bathroom Manufacturing Co., Ltd.",
    hall="A区", area="卫浴设备", boothNo="10.2B07",
    contactName="赵磊", contactTitle="Engineer 工程师",
    phone="+86 135 6677 8899", wechat="oulu_zhaolei", email="zhaolei@oulu-bath.com",
    categories=["shower_enclosure", "tray"],
    productDetails="Complete shower enclosures plus acrylic and stone-resin trays; "
                   "in-house moulding, 6 mm + 8 mm glass options.",
    models="OL-T700 / OL-E55",
    moqValue=80, currency="EUR", priceMin=145, priceMax=210, priceUnit="set", incoterm="FOB",
    leadTimeDays=40, capacityValue=5000, capacityUnit="sets/month",
    exportMarkets=["Germany 德国", "UK 英国", "EU (other) 欧盟其他"], euGermanyExperience="Yes",
    compliance=comp(CE=("copy_received", "CE-2024-6602"), EN14428=("copy_received", "EN14428-2024-1180"),
                    EN12150=("copy_received", ""), KTW=("document_seen", ""), DWD=("unknown", ""),
                    REACH=("copy_received", ""), RoHS=("copy_received", ""),
                    ISO9001=("copy_received", "ISO-2021-9033")),
    score={"fit": 4, "compliance": 5, "quality": 4, "price": 3, "capacity": 3, "communication": 4},
    followUpStatus="sample", nextAction="安排 8 mm 玻璃 + 石基样品寄德国总部",
    nextActionDate="2026-11-12",
    notes="唯一同时提供 EN 14428 与 KTW 现场文件的厂家，价格偏高但合规完备度最好。",
)

S6 = sup(
    id="s-0006",
    companyNameZh="宁波华辉五金制品厂",
    companyNameEn="Huahui Hardware Products Factory",
    hall="B区", area="建筑装饰材料", boothNo="13.1E22",
    contactName="孙建国", contactTitle="Sales 销售",
    phone="+86 136 5555 2211", wechat="huahui_sjg",
    categories=["hardware"],
    productDetails="General bathroom hardware, zinc alloy and brass fittings.",
    moqValue=1000, currency="CNY", priceMin=18, priceMax=45, priceUnit="pcs", incoterm="EXW",
    leadTimeDays=45, capacityValue=40000, capacityUnit="pcs/month",
    exportMarkets=["North America 北美"], euGermanyExperience="No",
    compliance=comp(REACH=("supplier_claimed", "")),
    score={"fit": 2, "compliance": 2, "quality": 2, "price": 4, "capacity": 3, "communication": 3},
    followUpStatus="reject", notes="产品档次偏低，无欧盟经验，不做跟进。",
)

S7 = sup(
    id="s-0007", source="manual",
    companyNameZh="台州市中宇卫浴有限公司",
    companyNameEn="Zhongyu Bathroom Co., Ltd.",
    hall="A区", area="卫浴设备", boothNo="10.2C33",
    contactName="周涛", contactTitle="Manager 经理",
    phone="+86 130 8899 7766", email="zhou.tao@zhongyu-bath.cn",
    categories=["faucet_shower"],
    productDetails="Thermostatic shower sets and brass faucets.",
    moqValue=200, currency="USD", priceMin=42, priceMax=88, priceUnit="set", incoterm="FOB",
    leadTimeDays=30, exportMarkets=["EU (other) 欧盟其他"], euGermanyExperience="Unknown",
    compliance=comp(CE=("supplier_claimed", "")),
    score={"fit": 3, "compliance": 2, "quality": 3, "price": 3, "capacity": 3, "communication": 3},
    notes="忘记拍照，回酒店才想起来；需微信索取产品图。",
)

S8 = sup(
    id="s-0008",
    companyNameZh="深圳市雅兰密封件有限公司",
    companyNameEn="Yalan Sealing Products Co., Ltd.",
    hall="D区", area="建筑装饰材料", boothNo="14.2F09",
    contactName="吴芳", contactTitle="Sales 销售",
    phone="+86 133 2211 3344", wechat="yalan_wufang", email="wufang@yalan-seal.com",
    categories=["seal"],
    productDetails="Magnetic strips, PVC and silicone seals for shower doors.",
    moqValue=3000, currency="CNY", priceMin=2.4, priceMax=5.8, priceUnit="m", incoterm="EXW",
    leadTimeDays=15, capacityValue=200000, capacityUnit="m/month",
    exportMarkets=["Germany 德国", "EU (other) 欧盟其他"], euGermanyExperience="Yes",
    compliance=comp(REACH=("copy_received", ""), RoHS=("copy_received", ""),
                    ISO9001=("document_seen", ""), CE=("unknown", "")),
    score={"fit": 4, "compliance": 3, "quality": 3, "price": 5, "capacity": 5, "communication": 4},
    followUpStatus="quote", nextAction="索要磁条与硅胶密封条报价（EXW 转 FOB）",
    nextActionDate="2026-11-06",
    notes="密封条专业厂，价格有优势；配合度好，愿意打样。",
)

# --- 第二场展会（上海 KBC）：证明多展会互不干扰 ---------------------------
S9 = sup(
    id="s-0101", fairId=FAIR_B, source="planned", previsitId="p-0101",
    companyNameZh="杭州朗斯卫浴有限公司",
    companyNameEn="Langsi Bathroom Co., Ltd.",
    hall="W3", area="厨房 / 卫浴", boothNo="W3-C18",
    contactName="何静", contactTitle="Manager 经理",
    phone="+86 139 0571 2233", wechat="langsi_hejing", email="hejing@langsi-bath.cn",
    categories=["shower_enclosure", "vanity"],
    productDetails="Mid-range shower enclosures and bathroom vanities, 6 mm glass, "
                   "aluminium frame, own assembly line.",
    models="LS-6600",
    moqValue=60, currency="USD", priceMin=150, priceMax=225, priceUnit="set", incoterm="FOB",
    leadTimeDays=38, capacityValue=6000, capacityUnit="sets/month",
    exportMarkets=["EU (other) 欧盟其他"], euGermanyExperience="Unknown",
    compliance=comp(CE=("copy_received", "CE-2025-3301"), EN14428=("document_seen", ""),
                    EN12150=("copy_received", ""), REACH=("copy_received", ""),
                    ISO9001=("copy_received", "ISO-2022-1180")),
    score={"fit": 4, "compliance": 4, "quality": 3, "price": 4, "capacity": 3, "communication": 4},
    followUpStatus="quote", nextAction="索要 EUR 报价与 EN 14428 副本", nextActionDate="2026-06-10",
    notes="KBC 现场整机做工不错，价格比广交会那批略低，可作为备选。",
)

S10 = sup(
    id="s-0102", fairId=FAIR_B,
    companyNameZh="温州精工密封科技有限公司",
    companyNameEn="Jinggong Sealing Technology Co., Ltd.",
    hall="W2", area="厨房 / 卫浴", boothNo="W2-A07",
    contactName="林峰", contactTitle="Engineer 工程师",
    phone="+86 137 5777 6611", email="linfeng@jg-seal.cn",
    categories=["seal"],
    productDetails="Silicone and TPE seals for shower doors, co-extruded magnetic strips.",
    moqValue=5000, currency="CNY", priceMin=3.1, priceMax=6.9, priceUnit="m", incoterm="EXW",
    leadTimeDays=18, capacityValue=150000, capacityUnit="m/month",
    exportMarkets=["Germany 德国"], euGermanyExperience="Yes",
    compliance=comp(REACH=("copy_received", ""), RoHS=("copy_received", ""),
                    KTW=("document_seen", ""), ISO9001=("document_seen", "")),
    score={"fit": 4, "compliance": 4, "quality": 4, "price": 4, "capacity": 4, "communication": 4},
    followUpStatus="sample", nextAction="寄样：磁条 + 硅胶密封条各 5 米", nextActionDate="2026-06-08",
    notes="唯一现场出示 KTW 文件的密封件厂，值得送样。",
)

PLANS = [
    {"id": "p-0001", "fairId": FAIR_A, "companyName": "佛山市南海区金莎卫浴有限公司", "boothNo": "10.2B31",
     "goal": "重点：整体淋浴房主力供应商", "priority": "A", "note": "德国总部指定要看",
     "status": "visited", "supplierId": "s-0001", "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0002", "fairId": FAIR_A, "companyName": "江门市华艺卫浴实业有限公司", "boothNo": "9.3D12",
     "goal": "滑轮铰链配件", "priority": "A", "note": "", "status": "visited",
     "supplierId": "s-0003", "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0003", "fairId": FAIR_A, "companyName": "佛山市顺德区欧陆卫浴制造有限公司", "boothNo": "10.2B07",
     "goal": "淋浴房 + 石基", "priority": "B", "note": "合规文件最全", "status": "visited",
     "supplierId": "s-0005", "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0004", "fairId": FAIR_A, "companyName": "广州理想淋浴房制造有限公司", "boothNo": "11.2B41",
     "goal": "备选整体淋浴房", "priority": "B", "note": "未找到展位", "status": "planned",
     "supplierId": None, "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
    {"id": "p-0005", "fairId": FAIR_A, "companyName": "佛山市南海区冠星卫浴有限公司", "boothNo": "10.2A15",
     "goal": "底盆与石基", "priority": "C", "note": "时间不够，跳过", "status": "skipped",
     "supplierId": None, "createdAt": DAY1, "updatedAt": DAY1, "deletedAt": None},
]

PLANS_B = [
    {"id": "p-0101", "fairId": FAIR_B, "companyName": "杭州朗斯卫浴有限公司", "boothNo": "W3-C18",
     "goal": "整体淋浴房备选", "priority": "A", "note": "KBC 新面孔", "status": "visited",
     "supplierId": "s-0101", "createdAt": KBCDAY, "updatedAt": KBCDAY, "deletedAt": None},
    {"id": "p-0102", "fairId": FAIR_B, "companyName": "苏州未来卫浴科技有限公司", "boothNo": "W4-B22",
     "goal": "智能淋浴房", "priority": "C", "note": "展位没找到", "status": "planned",
     "supplierId": None, "createdAt": KBCDAY, "updatedAt": KBCDAY, "deletedAt": None},
]

# photos: (supplier_id, type, title, hue)
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
            "appVersion": "1.1.0",
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
    day2_src = upgrade_v17([copy.deepcopy(s) for s in (S5, S7, S8)])
    photosA = build_photos(day1 + day2_src)

    # day 2 also revises S1 (booth corrected + note) — exercises "newest wins" upsert.
    # Copy from the day-1 record so the photo links travel with the revision.
    s1b = copy.deepcopy(day1[0])
    s1b["boothNo"] = "10.2B31A"
    s1b["updatedAt"] = DAY2
    s1b["notes"] += " 更正：展位号应为 10.2B31A。"

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
    print(f"fair A: 8 suppliers / {len(photosA)} photos (2 exports); "
          f"fair B: {len(fairB)} suppliers / {len(photosB)} photos (1 export)")
    print("S7 intentionally has NO photo -> will show up as draft (missing photo)")


if __name__ == "__main__":
    main()

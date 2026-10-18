# FairRecorder — 展会供应商现场速记 + 观展后自动汇总

一部手机完成展会供应商记录：现场拍照秒存、事后补资料、每晚备份，观展结束一条命令生成英文供应商报告。

**三条设计底线**

| # | 原则 | 具体做法 |
|---|---|---|
| 1 | **不绑定某一届展会** | 开场前自选/新建展会；每届展会是独立数据空间（记录、照片、云端目录、报告各自隔离），互不干扰 |
| 2 | **本地优先，不实时同步** | 所有录入先写手机 IndexedDB；云端只是备份，只在**手动点备份**或**定时器到期**时上传，失败不影响录入 |
| 3 | **数据只在私有仓库** | 云端目录按展会隔离；上传前强制校验仓库为 **Private**，公开仓库拒绝写入；访问权只给被邀请的 GitHub 账号 |

> **关于公开仓库**
> 这套工具的代码放在**公开仓库**，因为免费版 GitHub Pages 只支持公开仓库（Pages 站点本身没有访问控制，
> 与仓库私有无关）。仓库里**没有任何供应商数据、没有 token、没有公司专属信息**：
> 收件方放在本地 `config.json`（已 gitignore），供应商数据只进**私有仓库**。

---

## 一、目录结构

```
FairRecorder/
├─ app/                       现场录入 PWA（原生 JS，无构建链）—— Pages 的发布目录
│  ├─ index.html              单页应用：主屏 / 展会 / 秒存 / 手动录入 / 补录 / 计划 / 导出 / 云备份
│  ├─ sync.js                 云备份：Syncer 抽象 + 分块增量 + 串行调度 + 私有校验 + 可选加密
│  ├─ manifest.webmanifest    安装到主屏的元数据
│  ├─ sw.js                   Service Worker：离线缓存
│  ├─ vendor/jszip.min.js     JSZip 3.10.1（本地内置，不依赖 CDN）
│  └─ icons/                  192 / 512 / apple-touch-icon
├─ .github/workflows/pages.yml  推送 main 即自动部署 Pages
├─ inbox/                     手机导出的 ZIP 放这里（gitignore，可混放多届展会）
├─ output/                    汇总产物（自动重建，gitignore）
│  ├─ index.json                 展会索引：每届的记录数 / Top 名单 / 报告路径
│  └─ <展会目录>/               每届展会一套，目录名如 2026-140th-canton-fair-phase-ii
│     ├─ Supplier_Master.xlsx        供应商总表（6 个工作表）
│     ├─ Category_Comparison.xlsx    按品类对比矩阵
│     ├─ Supplier_Report_EN.docx      英文正式报告（发总部）
│     ├─ Supplier_Report_EN.html      图文预览版（可浏览器打印成 PDF）
│     ├─ data/suppliers_merged.json   合并后的规范数据
│     ├─ photos/ thumbnails/         照片与缩略图
│     └─ validation.json              完整性校验与异常清单
├─ scripts/
│  ├─ build_report.py         汇总全流程（CLI 入口，按展会分组）
│  ├─ fairlib.py              数据模型、合并、去重、评分、展会拆分
│  ├─ push_via_api.py         走 REST API 推代码（git 协议被网络拦住时用）
│  ├─ setup_github.py         建两个仓库（公开代码 / 私有数据）+ 推代码 + 开 Pages
│  ├─ pull_cloud.py           从私有仓按人拉取展会数据 → inbox/（可直接出报告）
│  ├─ purge_cloud.py          从私有仓删除误同步的展会（先 dry run，再加 --yes）
│  ├─ make_sample.py          生成演示用样例导出（两届展会）
│  ├─ gen_mobile_sample.py    用样本数据在真浏览器里跑一遍手机端报告 → output/mobile-sample/
│  └─ make_icons.py           生成 PWA 图标
├─ tests/
│  ├─ test_build_report.py    22 项单元测试（含多展会隔离）
│  ├─ test_cloud_crypto.py    JS 加密 ↔ Python 解密 的跨语言互操作（真浏览器）
│  ├─ smoke_app.js            真机冒烟：新建展会→录入→切换→隔离→同步页→程序仓拦截
│  ├─ e2e_cloud.js            端到端联调：真浏览器写私有仓 + Python 拉回出报告
│  ├─ e2e_multidevice.js      多设备联调：两台"手机"互相同步展会/记录/照片/权重
│  └─ e2e_report.js           手机端报告联调：HTML / XLSX / CSV 内容与结构校验
├─ config.example.json        → 复制为 config.json 填收件方（gitignore）
└─ requirements.txt           openpyxl / Pillow / python-docx
```

---

## 二、把应用装到 iPhone（观展前必须完成）

1. Safari 打开 Pages 地址 `https://nbleo.github.io/fair_recorder/` → 分享 → **添加到主屏幕**
2. 打开主屏图标，**开飞行模式试一次**：拍照 → 存草稿 → 补资料（云备份此时应报网络失败，但本地全部可用）
3. 之后**固定用这个地址**。换域名或换浏览器 = 另一套本地数据库，会看不到已有数据

展期内不要改代码；改了要同步 bump `sw.js` 里的 `CACHE` 版本号。

---

## 三、观展前（T-3 ~ T-1）

- [ ] 装到主屏，飞行模式试录 3 条并重启 App 验证数据还在
- [ ] **先建好本场展会**：展会页 → 新建 → 填名称（中文 + English）、展期、城市/场馆、展区
- [ ] 拍一张名片、一张证书，确认清晰度够用
- [ ] 完整走一遍「云备份上传 → 导出 ZIP → 跑汇总脚本 → 出 DOCX/XLSX」
- [ ] 把已知的厂家补进「预拜访清单」（公司名、展位号、目的、优先级 A/B/C）
- [ ] 复制 `config.example.json` 为 `config.json`，填好收件方（`prepared_for`）
- [ ] 手机清出至少 2 GB 空间，带充电宝

---

## 四、现场怎么用

### 0）先选中本场展会（每次换展会都要做）

主屏顶部卡片显示当前展会与展期 → 点 **🎪 切换 / 新建展会** → 选一个或新建一个。
**所有录入都挂在选中的展会下**，换展会后列表会跟着变（不是筛掉了，是本来就在另一个空间里）。

新建展会时填：名称（中文）、名称 English（进英文报告抬头）、展期、城市/场馆、主要展区、默认展馆。
展会类型下拉（广交会一期/二期/三期、KBC、ISH…）只预填城市与展区，不限制品类——任何展会都能自建。

### 1）拍照秒存（约 5 秒）—— 首选

主屏最大的按钮 → 直接调起相机 → **第一张拍展位牌或名片**（防错配的关键）→ 立刻存成草稿。
拍完进详情页，现场只需补 **公司名** 和 **展位号**，然后走下一家。

### 2）手动输入厂家（先不拍照）

主屏第二个按钮 **✍️ 手动输入厂家** → 直接建一条空白记录进编辑页。
适用于：只有名片/样品册、对方不给拍照、观展前预录已知厂家。
照片可稍后在详情页底部 **＋** 从相册补——补上之前这条记录一直算**草稿**，不参与排名。

### 3）预拜访厂家

「预拜访清单」→ 点 **到访拍照** → 自动用公司名和展位号建好记录、标为已到访、然后开相机。
不重复录入；没去成的厂家会进报告附录。

### 4）状态是算出来的，不是手填的

| 状态 | 含义 |
|---|---|
| 🔴 草稿 | 缺公司名 / 联系人 / 联系方式 / 品类 / 照片 中的任意一项 |
| 🟢 完整 | 以上都齐了，但六项评分没填完 |
| 🔵 已评分 | 六项评分全填，**只有这种才会进入 Top 排名** |

### 5）合规资质选「证据等级」，不是打勾

每项（CE / EN 14428 / EN 12150 / KTW / DWD / REACH / RoHS / ISO 9001）分五级：
`未知` → `供应商声称` → `现场看到文件` → `已取得副本` → `无/不适用`

**只有后两种算证据。**「供应商声称」在英文报告里原样写成 *Supplier claimed*，不会被当成已认证；
关键项标「无」的厂家会被强制降级为 **Conditional**。

---

## 五、每晚必做：备份（二选一，建议都做）

### A. 云备份（自动进私有仓库，本地优先）

主屏 → **☁️ 云备份** → 填好 owner / repo / branch / 云端根目录 / token → **保存** → **🔌 测试连接** → **⬆️ 立即备份**。

点「保存」时会顺带校验一次：读 GitHub 用户名作为命名空间、确认仓库是私有（页面会显示
**私有 ✅ 可备份**）。所以填错仓库或 token 无效，当场就能看到，不必等到备份失败。
读不到身份时在「访问者命名空间」手填一个即可。

> 云端路径：`users/<GitHub 登录名>/fairs/<展会 id>/`。几个人共用一个私有仓时各写各的
> 前缀，不会互相覆盖。

- **多终端同步**：见下节——换设备用同一个 GitHub 账号即可看到同样的展会与记录
- **不做实时同步**：只在手动点击或定时器到期时上传。展馆弱网也不会拖慢录入
- **自动备份档位**：关闭 / 每 30 分钟 / 每 2 小时 / 每天（仅 App 打开时生效，默认只传元数据）
- **备份内容**：仅元数据（几十 KB，弱网稳）或 元数据 + 原图（回酒店有 Wi-Fi 再点）
- **增量**：记录切成 200 条一块，只上传有改动的块；已传过的照片直接跳过
- 首页卡片显示「N 条未上传」——这就是本地领先云端的改动数
- 上传失败只写日志、不弹错误打断录入；**本地永远是第一副本**
- **⬇️ 从云端恢复**用于换机或误删：只覆盖云端更新的版本，本地较新的不会被覆盖
- 同一时刻只允许一个同步在跑，避免对同一个 git ref 并发提交导致失败

### B. 导出 ZIP（离线兜底）

主屏 → **导出备份** → 分享面板选 **「存储到文件」**，再发一份到微信文件传输助手（两份副本）。

---

## 五之二、在手机上直接出英文报告

主屏 → **📄 生成英文报告**。不需要电脑，当场就能把报告发给总部。

报告在设备本地生成（不上传任何服务器），口径与电脑端 `build_report.py` **完全一致**：
同一套权重、同样的分层（≥80 Shortlist / 70–79 Follow-up / 60–69 Reserve / <60 Low priority）、
同样的合规证据措辞（只有 "Copy received"、"Document seen" 算证据，"Supplier claimed" 只是口头声称）。

| 按钮 | 产物 | 用途 |
|---|---|---|
| 👁 预览英文报告 | 新窗口打开可打印的 HTML | 检查内容；点报告里的 **Print / Save as PDF** 存成 PDF |
| 📄 导出 / 分享 HTML 报告 | `.html`（照片内嵌） | 微信 / 邮件 / 存「文件」，任何浏览器都能打开 |
| 📊 导出 Excel | `.xlsx`（两个工作表） | Supplier Master + Category Comparison，Excel/WPS 直接开 |
| 🗂 导出 CSV | `.csv`（带 UTF-8 BOM） | 最通用的表格交换格式 |

报告页可调：范围（当前展会 / 全部展会合并）、重点推荐条数（Top 3 / 5 / 10）、
是否内嵌照片（每家最多 3 张；关掉则体积小、速度快）。封面抬头 `Prepared for` 可自填，只存在本机。

报告结构：1 执行摘要 → 2 范围与方法（含权重表）→ 3 供应商目录（每家一页，含照片与合规）
→ 4 分类对比矩阵 → 5 重点推荐（含"立即要做的事"）→ 6 跟进计划 → 7 附录（完整清单 / 未拜访 / 数据出处）。

> 需要带公司抬头的 **DOCX** 时，仍走电脑端：把导出的 ZIP 放进 `inbox/` 跑 `build_report.py`。
> 想先看手机端成品长什么样：`python scripts/gen_mobile_sample.py`（用样本数据跑真浏览器，
> 产物在 `output/mobile-sample/`）。

---

## 六、观展后：一条命令出报告

1. 把手机上的 ZIP 拷进 `inbox/`（几份都放，脚本会自动合并）
2. 跑：

```bash
"C:/Users/Leo/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  "C:/Users/Leo/WorkBuddy/FairRecorder/scripts/build_report.py" \
  --inbox  "C:/Users/Leo/WorkBuddy/FairRecorder/inbox" \
  --output "C:/Users/Leo/WorkBuddy/FairRecorder/output" --top 5
```

只想先看效果：

```bash
python scripts/make_sample.py && cp sample/*.zip inbox/ && python scripts/build_report.py
```

多届展会混放在同一个 `inbox/` 也没关系——脚本按 `fairId` 拆分，每届单独出一套报告：

```bash
python scripts/build_report.py --list-fairs                 # 先看有哪些展会
python scripts/build_report.py --fair 2026-kitchen-bath-china   # 只出这一届
```

### 合并规则（可重复运行，结果幂等）

- **先按展会分组，再合并**：不同展会的记录不会互相干扰，也不会被误判为重复
- 同一条记录按 UUID 合并，**`updatedAt` 新的版本赢**
- 删除过的记录以「墓碑」形式带出，不会在合并时复活
- 公司名 + 展位号相同、且联系方式一致 → 自动合并；冲突 → 只写进 `validation.json` 候选清单，**绝不静默合并**
- 每个 ZIP 先验 CRC，每张照片核对 SHA-256 和字节数，异常全部记进 `validation.json`
- 币种 / Incoterm / 计价单位不一致时，价格**不做横向排序**，直接标 `Not directly comparable`

### 调整评分权重

主屏 → **⚙️ 设置** → 评分权重。六个维度可逐项改，**合计必须是 100%**（不是 100% 会被挡下并提示）。

- 快速套用：**均衡（默认）／合规优先／成本优先／交期产能优先**，套用后仍可微调
- 「恢复默认」回到 25/25/15/15/10/10
- 权重写进每次备份，其他设备同步后自动一致；报告里的 Scope & Methodology 会按实际权重生成

默认权重：产品契合 25 · 合规 25 · 质量 15 · 价格 15 · 产能 10 · 沟通 10。

### 报告结构（英文，供应商保留中文原名）

1. Executive Summary（数量、品类分布、Top N、风险）
2. Scope & Methodology（评分权重、证据等级定义、价格可比性规则）
3. Supplier Catalogue（按品类分组，每家一卡片 + 照片）
4. Comparison Matrix（品类内横向对比）
5. Key Recommendations（Top N、理由、缺口、Shortlist / Conditional 结论）
6. Next Steps & Follow-up
7. Appendix（完整清单、数据缺失项、未到访的预拜访厂家、处理日志）

---

## 七、GitHub 仓库与部署

**两个仓库，彻底分开。程序在公开仓，数据在私有仓，两者永不混用。**

| 仓库 | 可见性 | 职责 | 里面有什么 |
|---|---|---|---|
| `fair_recorder` | **公开** | 主程序 | 只有 `app/` 源码 + Pages 部署产物。装到手机用的就是这个 |
| `fairrecorder-data` | **私有** | 数据存储 | 按访问者分命名空间的供应商记录与照片 |

程序仓是公开的，因为免费账户只有公开仓能开 GitHub Pages；**Pages 站点本身就
没有访问控制**（与仓库私有无关），所以它只能放代码。公司名、供应商名单、照片、
token 一概不进这个仓——`config.json`、`output/`、`inbox/` 全在 gitignore 里，
`scripts/setup_github.py` 也会在两个仓同名时直接拒绝运行。

### 数据仓的目录布局（按访问者隔离）

```
users/<github-login>/fairs/<展会ID>/meta.json            统计、分块索引、加密参数（明文）
users/<github-login>/fairs/<展会ID>/suppliers-0.json     记录，每块 200 条
users/<github-login>/fairs/<展会ID>/suppliers-200.json
users/<github-login>/fairs/<展会ID>/assets/<照片ID>.jpg   产品图 / 名片
```

每个人只写自己的 `users/<login>/` 前缀，多人共用一个私有仓也不会互相覆盖。
登录名在「测试连接」时自动取；读不到 `/user` 权限时可在界面手填命名空间。

### 存储与同步逻辑（参考 glink25/Cent）

Cent 是"纯前端 PWA + GitHub 仓库即数据库"的开源记账应用，本项目的同步层
沿用了它的四个设计：

| Cent 的做法 | 本项目对应实现 |
|---|---|
| IndexedDB 是真相源，同步只是备份通道 | 记录先落本机；同步失败只写日志，绝不阻断录入 |
| `Syncer` 抽象（github / gitee / s3 / webdav 可替换） | `app/sync.js` 只依赖 `fetchStructure` / `fetchContent` / `uploadContent` / `getUserInfo` / `getCollaborators` 五个动作 |
| 分块 + 增量上传（`itemsPerChunk`） | 记录按 id 排序切块（200/块），按 `updatedAt` 算出脏块只传变化的部分；照片传过不再重传 |
| `Scheduler` 串行提交，避免 non-fast-forward | 同一时刻只允许一个同步在跑，后来的请求顶掉等待中的那个 |

与 Cent 的差异：Cent 是"一个账本 = 一个仓库"，这里是"一个私有仓 + 按人分命名空间"，
因为供应商数据要按人隔离，而不是拆成一堆仓库。另外额外提供了可选加密（见下）。

一次性建仓 + 推代码 + 开 Pages：

```bash
GITHUB_TOKEN=<pat> python scripts/setup_github.py
# 如需改名：
GITHUB_TOKEN=<pat> python scripts/setup_github.py \
    --owner nbleo --code-repo fair_recorder --data-repo fairrecorder-data
```

token 必须有**写**权限：`Contents: Read and write` + `Pages: Read and write`
（或用 classic token 勾 `repo` + `workflow`）。只读 token 会在第一步就被拦下并给出提示。
脚本只从环境变量读 token，不会写进磁盘或 `.git/config`。

> ⚠️ **fine-grained token 的 Repository access 请选「All repositories」**
> 如果选了「Only select repositories」，脚本建出来的新仓库**不在授权列表里**，
> 会表现为"创建成功（201）但随后 GET 返回 404"——私有数据仓就是这么卡住的。
> 已建好的仓库可以事后在 token 设置页加进列表。

**当前状态（2026-10-18）**

| 项 | 值 |
|---|---|
| 代码仓 | https://github.com/nbleo/fair_recorder （公开） |
| PWA 地址 | **https://nbleo.github.io/fair_recorder/** |
| 数据仓 | https://github.com/nbleo/fairrecorder-data （私有，待 token 授权后启用） |

> **为什么推送走 REST API 而不是 `git push`**
> 部分网络（含本机）的代理会拦掉 `github.com:443` 的 CONNECT，只放行 `api.github.com`。
> `scripts/push_via_api.py` 因此改用 Git Data API（blob → tree → commit → update-ref）推代码，
> 只上传 `git ls-files` 列出的文件，被 gitignore 的内容不会离开本机。
> 网络正常的机器上照常 `git push` 即可，两者结果一致。

之后每次 push 到 `main`，`.github/workflows/pages.yml` 会自动把 `app/` 部署到 Pages。
单独推一次：

```bash
GITHUB_TOKEN=<pat> python scripts/push_via_api.py --message "your commit message"
```

> ⚠️ Pages 站点是**公开可访问**的（GitHub 的规则，与仓库私有无关）。所以：
> 代码里不要放任何 token、公司名或供应商数据——它们分别在手机本地和私有仓库。

### 数据访问控制（只给自己，之后可加人）

| 层 | 做法 |
|---|---|
| 仓库可见性 | 必须是 **Private**。上传前调 API 校验，公开仓库直接拒绝写入并提示 |
| 程序仓拦截 | `nbleo/fair_recorder` 被写进黑名单，即使填了也会直接拒绝（冒烟测试有覆盖） |
| token 授权 | fine-grained token，**Repository access 设为 All repositories**，权限只给 `Contents: Read and write`（+ `Pages`） |
| 按人隔离 | 数据落在 `users/<login>/…`，多人共仓互不覆盖 |
| 加人 | 仓库 → **Settings → Collaborators → Add people**（应用内「管理可访问人员」按钮直达）；**不要**把仓库改 Public |
| 可选加密 | 云端再套一层 AES-GCM-256（PBKDF2-SHA256 十万轮），密钥不上传；只加密记录与照片，`meta.json` 明文 |

加密口令**只存在您输入它的那台设备上**，不上传云端——**忘记则云端数据无法恢复**
（本机数据不受影响）。开启前先想清楚要不要走这条路；私有仓 + Collaborator 本身
已经足够，加密是给"仓库万一被误设为公开"留的兜底。

### 换设备 / 多终端：同一账号看到同一份数据

手机、平板、电脑上各装一次 PWA，填**同一个 GitHub 账号的 token + 同一个私有仓**，
它们就指向同一个命名空间 `users/<登录名>/`，内容完全一致。

| 场景 | 操作 |
|---|---|
| **新设备第一次用** | 云备份页填好 token → 保存 → **📥 拉取云端全部展会**（自动建出所有展会、记录、照片） |
| **日常双向同步** | **🔄 双向同步** —— 先把云端较新的拉下来，再把本机改动推上去 |
| **只要本机 → 云端** | ⬆️ 立即备份（只推本机改动，不动云端已有的新数据） |
| **只要云端 → 本机** | ⬇️ 从云端恢复本展会 |
| **多展会一次性处理** | 📤 备份本机全部展会 / 📥 拉取云端全部展会 |

合并规则（与 Cent 同思路）：

- 一条记录的最终版本 = **最后修改时间**更晚的那份；只在一边改过的不会互相覆盖
- 删除会作为墓碑同步，A 设备删掉的不会在 B 设备"复活"
- **评分权重也随同步传播**，多设备打分口径自动一致
- 换设备时不必先建展会——「拉取云端全部展会」会把展会一起带过来

> 两台设备同时改同一条记录，保留时间更晚的那份。所以设备时间请保持准确。

### 从云端直接出报告

观展后不必再手动从手机导 ZIP，可以拉私有仓：

```bash
# 看看仓库里有哪些人、哪些展会
GITHUB_TOKEN=<pat> python scripts/pull_cloud.py --owner nbleo --repo fairrecorder-data --list

# 把 leo 名下所有展会拉成 ZIP 放进 inbox/
GITHUB_TOKEN=<pat> python scripts/pull_cloud.py --owner nbleo --user leo --all-fairs

# 若开了云端加密，加 --passphrase
python scripts/build_report.py --inbox inbox --output output --top 5
```

`pull_cloud.py` 同样拒绝读公开仓、拒绝读程序仓。拉下来的 ZIP 与手机导出完全一致，
照片与厂家的对应关系也一并带回来，直接进报告。

### 清掉误同步的展会

```bash
# 先看会删什么（默认 dry run）
GITHUB_TOKEN=<pat> python scripts/purge_cloud.py --user leo --starts-with "测试"

# 确认无误再真删
GITHUB_TOKEN=<pat> python scripts/purge_cloud.py --user leo --starts-with "测试" --yes

# 或者按展会 id 精确删一个
GITHUB_TOKEN=<pat> python scripts/purge_cloud.py --user leo --fair <fair-id> --yes
```

脚本只动 `<root>/<user>/fairs/` 下面的文件，公开仓一律拒绝。

---

## 八、已知风险与对策

| 风险 | 对策 |
|---|---|
| iOS 回收本地数据 | 每晚备份（云备份或导出 ZIP），两份副本 |
| 录进了错误的展会 | 主屏顶部常驻当前展会名；发现后到展会页切换即可，数据不会串 |
| 多届展会混淆 | 记录/照片/云端目录/报告全部按 fairId 隔离；老数据自动归入「迁移自旧版」 |
| 照片撑爆存储 | 客户端压缩（产品图长边 1600 / 名片证书 2000），设置页显示占用，>70% 预警 |
| 照片撑爆存储 | 客户端压缩（产品图长边 1600 / 名片证书 2000），设置页显示占用，>70% 预警 |
| 照片挂错厂家 | 每次新建先拍展位牌；详情页顶部常驻公司名与展位号 |
| 展位号记错 | 展位号自动大写去空格；首张照片建议拍展位牌 |
| 同名厂家 / 多展位 | UUID 为主键，公司名+展位为业务键，模糊冲突只报候选 |
| 电量 | 深色界面、无后台同步、无持续定位，带充电宝 |
| 云备份失败 / 超时 | 本地始终是第一副本；失败只记日志，定时器下次自动重试 |
| token 泄露 | 用 fine-grained token 只授权数据仓库；换手机后到 GitHub 吊销旧 token |
| 把"供应商声称"当成认证 | 五级证据状态 + Conditional 标签 + 必列待核验证书 |

---

## 九、环境

```bash
"C:/Users/Leo/.workbuddy/binaries/python/envs/default/Scripts/python.exe" -m pip install -r requirements.txt
```

依赖只有 `openpyxl==3.1.5`、`Pillow==12.3.0`、`python-docx==1.2.0`，不需要 pandas。

测试：

```bash
"C:/Users/Leo/.workbuddy/binaries/python/envs/default/Scripts/python.exe" tests/test_build_report.py
```

第三方组件：`app/vendor/jszip.min.js` 为 JSZip v3.10.1（MIT / GPLv3 双许可），
来自 `https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js`，
SHA-256 `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e`。

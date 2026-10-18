# FairRecorder — 展会供应商现场速记 + 观展后自动汇总

一部手机完成展会供应商记录：现场拍照秒存、事后补资料、每晚备份，观展结束一条命令生成英文供应商报告。

> **关于公开仓库**
> 这套工具的代码放在**公开仓库**，因为只有公开仓库才能用免费的 GitHub Pages 部署（Pages 站点本身
> 没有访问控制，私有仓库也一样）。仓库里**没有任何供应商数据、没有 token、没有公司专属信息**：
> 公司名与展会抬头放在本地 `config.json`（已 gitignore），供应商数据同步到**另一个私有仓库**。

---

## 一、目录结构

```
FairRecorder/
├─ app/                       现场录入 PWA（原生 JS，无构建链）—— Pages 的发布目录
│  ├─ index.html              单页应用：主屏 / 秒存 / 手动录入 / 补录 / 计划 / 导出 / 云同步
│  ├─ sync.js                 GitHub 云端备份（Git Data API）
│  ├─ manifest.webmanifest    安装到主屏的元数据
│  ├─ sw.js                   Service Worker：离线缓存
│  ├─ vendor/jszip.min.js     JSZip 3.10.1（本地内置，不依赖 CDN）
│  └─ icons/                  192 / 512 / apple-touch-icon
├─ .github/workflows/pages.yml  推送 main 即自动部署 Pages
├─ inbox/                     手机导出的 ZIP 放这里（gitignore）
├─ output/                    汇总产物（自动重建，gitignore）
│  ├─ Supplier_Master.xlsx        供应商总表（6 个工作表）
│  ├─ Category_Comparison.xlsx    按品类对比矩阵
│  ├─ Supplier_Report_EN.docx      英文正式报告（发总部）
│  ├─ Supplier_Report_EN.html      图文预览版（可浏览器打印成 PDF）
│  ├─ data/suppliers_merged.json   合并后的规范数据
│  └─ validation.json              完整性校验与异常清单
├─ scripts/
│  ├─ build_report.py         汇总全流程（CLI 入口）
│  ├─ fairlib.py              数据模型、合并、去重、评分
│  ├─ setup_github.py         建仓库 + 推代码 + 开 Pages（一次性）
│  ├─ make_sample.py          生成演示用样例导出
│  └─ make_icons.py           生成 PWA 图标
├─ tests/test_build_report.py 16 项单元测试
├─ config.example.json        → 复制为 config.json 填展会抬头（gitignore）
└─ requirements.txt           openpyxl / Pillow / python-docx
```

---

## 二、把应用装到 iPhone（观展前必须完成）

1. Safari 打开 Pages 地址 `https://<owner>.github.io/fairrecorder/` → 分享 → **添加到主屏幕**
2. 打开主屏图标，**开飞行模式试一次**：拍照 → 存草稿 → 补资料（云同步此时应报网络失败，但本地全部可用）
3. 之后**固定用这个地址**。换域名或换浏览器 = 另一套本地数据库，会看不到已有数据

展期内不要改代码；改了要同步 bump `sw.js` 里的 `CACHE` 版本号。

---

## 三、观展前（T-3 ~ T-1）

- [ ] 装到主屏，飞行模式试录 3 条并重启 App 验证数据还在
- [ ] 拍一张名片、一张证书，确认清晰度够用
- [ ] 完整走一遍「云同步上传 → 导出 ZIP → 跑汇总脚本 → 出 DOCX/XLSX」
- [ ] 把已知的厂家补进「预拜访清单」（公司名、展位号、目的、优先级 A/B/C）
- [ ] 复制 `config.example.json` 为 `config.json`，填好展会抬头与收件方
- [ ] 手机清出至少 2 GB 空间，带充电宝

---

## 四、现场怎么用

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

### A. 云同步（推荐，自动进私有仓库）

主屏 → **☁️ 云同步** → 填好 owner / repo / branch / path / token → **保存** → **🔌 测试连接** → **⬆️ 上传**。

- 同步范围可选 **仅元数据**（几秒，弱网也稳）或 **元数据 + 原图**（慢，但云端有图）
- 展馆信号差时上传会超时——**不要紧，本地数据没丢**，回酒店有 Wi-Fi 再点一次即可
- token 明文存在手机浏览器本地；建议用 fine-grained token，只对数据仓库授权
- **⬇️ 从 GitHub 恢复**用于换机或误删：只覆盖云端更新的版本，本地更新的不会被覆盖

### B. 导出 ZIP（离线兜底）

主屏 → **导出备份** → 分享面板选 **「存储到文件」**，再发一份到微信文件传输助手（两份副本）。

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

### 合并规则（可重复运行，结果幂等）

- 同一条记录按 UUID 合并，**`updatedAt` 新的版本赢**
- 删除过的记录以「墓碑」形式带出，不会在合并时复活
- 公司名 + 展位号相同、且联系方式一致 → 自动合并；冲突 → 只写进 `validation.json` 候选清单，**绝不静默合并**
- 每个 ZIP 先验 CRC，每张照片核对 SHA-256 和字节数，异常全部记进 `validation.json`
- 币种 / Incoterm / 计价单位不一致时，价格**不做横向排序**，直接标 `Not directly comparable`

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

两个仓库，各司其职：

| 仓库 | 可见性 | 内容 |
|---|---|---|
| `fair_recorder` | **公开** | PWA 代码，用 Pages 部署成 `https://nbleo.github.io/fair_recorder/` |
| `fairrecorder-data` | **私有** | 供应商记录（元数据 + 照片），只有您的账号能读 |

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

---

## 八、已知风险与对策

| 风险 | 对策 |
|---|---|
| iOS 回收本地数据 | 每晚备份（云同步或导出 ZIP），两份副本 |
| 照片撑爆存储 | 客户端压缩（产品图长边 1600 / 名片证书 2000），设置页显示占用，>70% 预警 |
| 照片挂错厂家 | 每次新建先拍展位牌；详情页顶部常驻公司名与展位号 |
| 展位号记错 | 展位号自动大写去空格；首张照片建议拍展位牌 |
| 同名厂家 / 多展位 | UUID 为主键，公司名+展位为业务键，模糊冲突只报候选 |
| 电量 | 深色界面、无后台同步、无持续定位，带充电宝 |
| 云同步失败 / 超时 | 本地始终是第一副本；同步失败不影响录入，换网络重试即可 |
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

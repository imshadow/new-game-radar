# New Game Radar

面向游戏 SEO 趋势站的自动化游戏关键词发现工具。它从游戏平台、Steam、RSS、榜单、Google Trends Rising 和竞争站 Sitemap 中发现候选，再通过需求、传播与竞争证据筛选真正值得检查的游戏词。

## 配套开源 Skill：Game Trend Site Builder

仓库现在同时提供 [`skills/game-trend-site-builder`](./skills/game-trend-site-builder/)：把已经选中的游戏词进一步变成一个**符合游戏自身视觉风格、可验证真实 iframe、Play-first、可部署的游戏网站**。

它不是固定换皮模板。执行顺序是：

```text
游戏词
  → 找到官方游戏
  → 确认 HTML5 / Browser Build
  → 找到真实运行 iframe
  → 第三方页面实测
  → 研究玩法与官方视觉
  → 针对该游戏重新设计 UI
  → Play + How to Play + Tips + FAQ + SEO
  → 响应式与最终 QA
```

完整说明见 [`SKILL.md`](./skills/game-trend-site-builder/SKILL.md)。

## 核心流程

```text
多来源发现游戏名
  → SEO 搜索意图与实体冲突验证
  → 快速热度验证
     · 24h / 48h 平台扩散
     · 榜单排名变化
     · Google 自动补全新增
     · SERP 新增页面
     · YouTube 视频 / 频道 / 播放量（可选）
  → 独立社媒外溢验证
     · 至少两个平台
     · 至少四个独立创作者
     · 至少一个平台在24小时内仍有新增
  → Google Trends 7天 / 30天 / 90天验证
  → SERP新旧与专站占位验证
  → 30%测试局（test-now）
  → 真实流量验证后再升级为独立站、站内页、观察或淘汰
```

只有通过快速热度层的少量候选才会进入 Google Trends，避免免费 Trends 接口被几百个低质量词占满。

## 自动数据源

浏览器在线游戏（`online` 渠道）：

- itch.io 最新网页游戏
- itch.io New & Popular
- itch.io New Feed / Featured Feed
- Newgrounds Daily Top Five / 最新通过作品
- CrazyGames、Poki、Y8、GamePix、Lagged 新游戏
- Armor Games 首页推荐
- GitHub `topic:html5-game` 新建仓库

下载型游戏（`wiki` 渠道）：

- Steam 热门新发行 / 最新独立游戏
- Steam 独立游戏热门新发行（`popularnew` + `tags=492`，把榜单收窄到独立游戏）
- Steam 即将推出的独立游戏（`comingsoon`，默认排序即当天解锁的作品；
  比 `popularcomingsoon` 更早——后者要求游戏已积累热度才会上榜）
- Steam 热门即将推出（`popularcomingsoon`，比 Top Wishlists 更早）
- Steam 官方 RSS：新发行、周销量榜
- Alpha Beta Gamer（专报刚开启测试的独立游戏）
- IndieGamesPlus（独立游戏媒体，feed 即近期新作报道）
- Hacker News Show HN 游戏帖

其他：

- Google Trends 相关上涨查询
- 可配置竞争站 Sitemap / Sitemap Index

每个来源在 `config/sources.json` 里用 `fetchKind` 指定解析器。加新源之前先用
`npm run probe:source` 试一次，确认解析器能读懂返回体，而不是等到线上才发现它是空的。

### 为什么这些源值得加

| 来源 | 为什么 |
|---|---|
| Steam 官方 RSS | 无需 HTML 抓取，结构最稳定；周销量榜直接给出排名 |
| Steam 热门即将推出 | 愿望单的前置指标，比正式榜单早 |
| Steam 即将推出的独立游戏 | `comingsoon` 不要求已有热度，是全部榜单里最早的一档 |
| Steam 独立游戏热门新发行 | 同一份 `popularnew`，`tags=492` 滤掉 3A，留下独立游戏 |
| Alpha Beta Gamer | 只报刚开启测试的独立游戏，天然是低竞争新词 |
| IndieGamesPlus | 独立游戏媒体，报道通常早于商店收录 |
| Hacker News Show HN | 开发者自发帖，通常比上架早数周 |
| GitHub `topic:html5-game` | 作者自述可在浏览器运行，早于任何门户收录 |
| Armor Games | 老牌浏览器游戏门户，补齐 online 渠道 |

新增的 3 个源没有引入新解析器：两个 Steam 榜单复用 `steam-listing`，
IndieGamesPlus 复用 `press-feed`。复用是有意的——解析器已经过验证，
新源的风险被限制在「URL 选得对不对」，而不是「解析器写得对不对」。

加源不能只看“能不能抓到”，还要看“是不是重复抓”。实测各榜单各取 50 条，
按 Steam app id 去重后的独有贡献：

| 榜单 | 独有条数 |
|---|---|
| `steam-latest-indie` | 50 / 50 |
| `steam-upcoming-indie`（`comingsoon`） | 48 / 50 |
| `steam-upcoming-wishlist`（`popularcomingsoon`） | 48 / 50 |
| `steam-popular-new` | 24 / 50 |
| `steam-popular-new-indie` | 24 / 50 |

两组容易误判的对照：`comingsoon` 与 `popularcomingsoon` **零重叠**（50 vs 50 全不重合），
`popularnew` 与 `popularnew+tags=492` 只重叠 26 条——Steam 是先按标签筛再排序，
所以加标签的那一份不是无标签版的子集，能捞出后者进不去的独立游戏。
如果当初只凭“名字很像”就判定重复，这两个源都会被误删。

### 解析器要点

这些源里有一半“看起来坏了、其实只是解析器读不懂”，所以每个新源都配了专门的
`fetchKind`：

- `steam-feed`：Steam 的 `newreleases.xml` 链接指向**新闻页**而不是游戏页，名字只能从标题里取；
  同时要丢掉 `Update Released`、补丁说明这类噪声。`weeklytopsellers.xml` 的标题形如
  `#1 - WARDOGS`，解析时会拆出排名。
- `press-feed`：独立游戏媒体的标题形如 `Game – Beta Demo`，后缀不是名字的一部分；
  同时过滤 press kit、访谈、盘点等非游戏文章。
- `hn-listing` / `github-listing`：返回 JSON，HTML/XML 解析器读不了。
  HN 的判定标准是“是否在描述一个**可玩**的东西”——引擎、SDK、Wiki、数据集都会提到 game，
  但都不是游戏。
- `armorgames-listing`：锚点的 `data-content` 属性里嵌了原始 HTML，
  用 `[^>]*` 扫描属性会在第一个 `>` 处截断，静默丢掉大半个页面。
- `steam-listing` 的 `sort_by` 参数是个陷阱：**未发售**作品的发行日大多是占位值，
  实测 `filter=comingsoon` 配 `sort_by=Released_DESC` 会捞出 2077 / 2999 / 9000 年
  这种垃圾条目；去掉 `sort_by` 用默认排序，拿到的才是当天解锁的作品。
  已发售榜单（`popularnew`、`Released_DESC` 的独立游戏榜）不受影响。

### 加新源时要改哪里：`lib/source-registry.mjs`

**只需要改这一个文件。** 它同时声明两件事：

1. **语义**——每个 tag（`kind` 或 `sourceId`）的 `channel`（`online` / `wiki` / `shared` / `pending`）
   和 `evidence`（这个源单独出现，是否足以断言渠道）。
   `shared` 表示两种渠道都可能有（上涨查询、竞争站 sitemap）；`pending` 表示只是一个名字，
   还不能判断。`evidence: false` 的典型是 `itch-new`——它是 `online` 渠道，
   但一个 itch 列表条目只是名字，不等于这个游戏能在浏览器里玩。
2. **策略**——`POLICY_SETS`，每个消费方用到的集合。`site-type`、`fast-signals`、
   `trend-queue`、`wiki-prelaunch` 以及 5 个脚本都从这里 `import`，不再各自维护一份。

以前同一个源要在 9 个文件里各写一遍，漏一处不会报错，只是被静默降权——
上一轮新增的 5 个源就是这样只接进了 2 处。现在漏掉会在测试里直接失败。

注意这些集合**彼此并不相同**，不要合并：`SEO_QUEUE_STRATEGIC` 故意不含几个大平台
（它分配稀缺的 SEO 名额，大平台已覆盖充分），而 `TREND_ONLINE_STRATEGIC` 含它们。

`tests/source-registry.test.mjs` 会检查：源是否登记了渠道、有没有文件在注册表之外
私自声明集合、每个启用源是否至少被一个消费方当作信号、新增源是否覆盖了所有该覆盖的集合。

## 机会评分与硬门槛

最终机会分采用统一、可解释的权重：

| 信号 | 权重 | 判断重点 |
|---|---:|---|
| 社媒传播速度 | 30% | 多平台、多独立创作者、24小时仍在扩散 |
| Steam／平台增长速度 | 25% | 愿望单名次的近期增速，或24–48小时平台扩散；不是累计总量 |
| 搜索需求形成 | 15% | Trends Rising/Breakout、新词历史与攻略型补全 |
| 内容可扩展性 | 15% | 是否存在至少3个真实攻略主题，能够继续扩成内容集群 |
| SERP空缺 | 10% | 是否确认为新词且没有同名专站／成熟Wiki |
| 名称安全 | 5% | 通用词、重名和非游戏实体冲突风险 |

低搜索结果数量只代表“供给少”，不代表“有人搜”。系统现在把“测试局”和“正式独立站”分成两层：

**`test-now`（30%测试局）**：增长、搜索形成、内容空间、SERP和名称安全达到门槛即可先测；社媒未配置、单平台传播或Provider报错不会把候选直接判死。测试局的目的不是证明它一定成功，而是用最低成本尽快拿到真实水花。

**`independent`（正式独立站）**：仍保留严格硬门槛，缺一项就不能升级：

- 社媒已在至少两个平台、多个独立账号形成外溢传播
- Steam榜单近期上升或刚进入高位榜，而不是只有累计愿望单高
- 搜索需求开始形成，且能规划至少3个真实攻略主题
- 90天历史显示是新词，SERP未被专门站点、同名域名或成熟Wiki占位
- 名称没有明显歧义或其他实体冲突

因此，“高愿望单 + 低结果数”不能直接得到正式独立站推荐；但强增长的新词可以先进入 `test-now`。单个强平台可以提高测试置信度，却仍不足以直接升级为 `independent`。

## 分层验证

### 1. SEO 意图层

检查：

- 主词结果中的游戏占比
- `游戏名 + game play online` 的游戏意图
- 新闻、歌曲、影视、产品等实体冲突
- 自动补全中的游戏长尾和非游戏长尾
- 名称通用度和歧义风险

### 2. 快速热度层

检查：

- 24小时与48小时新增独立来源数量
- 平台榜单当前排名、最佳排名和排名提升
- 自动补全新增游戏长尾数量
- SERP 新增相关页面数量
- 来源是否来自 Trends Rising、Featured、New & Popular 或热门新发行
- YouTube 近7天视频数、不同频道数和播放量（配置 Key 后启用）

快速层分为：

- `pass`：进入 Google Trends
- `watch`：继续观察，不消耗 Trends 请求
- `weak`：热度不足
- `reject`：搜索意图或实体冲突未通过

### 3. 独立传播层

通过 YouTube、Reddit、X、TikTok 的官方接口检查近7天传播。独立站推荐要求跨平台、跨创作者且24小时仍有新增；只有官方账号或单平台爆量不算外溢传播。

Steam/Wiki 候选和在线小游戏都会进入该层，避免 Steam 高愿望单候选绕过传播验证。

### 4. Google Trends 与市场层

同时比较：

- 游戏主词
- `游戏名 + game`
- 基准词 `itch io`
- 最近7天、30天和90天

用于判断：

- 7天或30天持续上涨
- Breakout
- 单日孤立尖峰
- 关键词是否早已存在
- 主词热度是否来自其他实体
- 90天前段是否接近无量，近期才开始上涨
- 是否已有同名域名、专门Wiki或多个攻略站占位

## GitHub Actions

`.github/workflows/radar.yml` 默认在每小时第17分和第47分运行。旧任务会在新任务开始时自动取消，只保留最新扫描。

工作流会：

1. 抓取全部自动数据源
2. 更新来源首次发现时间和榜单排名
3. 每轮最多验证50个SEO候选
4. 计算全部当前候选的快速热度
5. 只把快速层通过的候选送入 Google Trends
6. 提交 `data/state.json`、`data/candidates.json`、`data/dashboard.json` 和 `data/latest-report.json`

`npm test` 失败会让工作流失败。测试套件用固定时钟运行（见 `npm run test:frozen`），
避免出现“当时通过、过一段时间自己变红”的时间炸弹测试。

## 可选 YouTube 验证

YouTube 验证默认关闭，不影响其他功能。

需要启用时，在 GitHub 仓库中添加 Actions Secret：

```text
YOUTUBE_API_KEY
```

启用后，每轮最多验证3个高优先级候选，获取近7天：

- 视频数量
- 不同频道数量
- 总播放量
- 最近24小时视频数量

未设置 Secret 时，系统会自动跳过 YouTube，不会报错。

## 本地运行

```bash
npm ci            # 按 package-lock.json 安装，保证可复现
npm test          # 解析与评分测试
npm run test:frozen   # 用固定时钟跑测试，防止时间炸弹测试
npm run check     # 语法检查 + 测试
npm run verify:sources   # 逐个抓取 config/sources.json 里启用的源，报告解析结果
npm run scan
```

`npm run verify:sources` 用来在加源或改源之后做一次体检：某个源抓不到东西时它会
以非零退出码结束，而不是让线上扫描“看起来是绿的、实际什么都没发现”。
只想看某几个源时传入 id 片段即可，例如 `npm run verify:sources -- steam itch`。

试一个新源能不能用：

```bash
npm run probe:source -- https://example.com/new-games auto
npm run probe:source -- https://example.com/api/list hn-listing --show
```

`--show` 会打印响应开头，是判断“这个站该配哪个解析器”最快的方式。

前端本地预览：

```bash
npm install -g vercel
vercel dev
```

## 添加竞争站 Sitemap

在 `config/sources.json` 中加入：

```json
{
  "id": "competitor-example",
  "name": "Example Games Sitemap",
  "url": "https://example.com/game-sitemap.xml",
  "kind": "competitor-sitemap",
  "fetchKind": "sitemap",
  "enabled": true,
  "baselineOnly": true
}
```

首次运行只建立基线，第二次开始识别新增 URL。

`baselineOnly` 只影响**首次**扫描：为 `true` 时第一轮只记录快照、不导入存量，
适合“榜单常驻大厂游戏”“首页编辑精选老游戏”这类源——否则会把 CS2、Dota 2
和 2012 年的老游戏一次性灌进候选池。反过来，像 Alpha Beta Gamer、Show HN
这种“feed 本身就是最近几天新作”的源，应当设为 `false`，首轮就全量收录。

## Vercel 部署

1. 在 Vercel 导入 GitHub 仓库
2. Framework Preset 选择 `Other`
3. 不需要 Build Command
4. 部署

前端直接读取 GitHub 中的最新结果数据，因此自动扫描更新数据时不需要重新部署页面。

前端读取的地址由 `index.html` 里的 `radar-data-base` 决定。Fork 之后把它改成自己的仓库地址
（或同源的 `/data`），否则页面会继续展示上游作者的扫描结果。

## 数据文件

- `data/state.json`：来源快照、URL和榜单位置
- `data/candidates.json`：候选、SEO、快速热度、YouTube和Trends结果（内部完整状态，已压缩为单行 JSON）
- `data/dashboard.json`：前端专用的精简投影，只保留页面实际渲染的字段，并跳过从未验证过的候选
- `data/latest-report.json`：最近一次扫描统计

`data/candidates.json` 每个扫描周期都会被提交，所以它的大小直接决定仓库增长速度。
以下两类内容不会写入：

1. **可重算的派生结果**（`opportunity`、`marketFreshness`、`wikiPrelaunch`）只对可行动候选保留。
   它们是对 `sources`/`seo`/`trend` 的纯函数，`npm run classify` 在做任何决策前都会重算一遍，
   给从未验证过的候选保存这些字段只是在存占位符。
2. **前端不需要的字段**不会进入 `dashboard.json`（例如 `exactResultUrls`、`serpSnapshot`）。

候选数量上限由 `DASHBOARD_MAX_CANDIDATES`（默认 800）控制，被省略的数量会写在
`omittedCandidates` 字段里，页面会显示出来。

## 合规提醒

本工具只发现公开页面与名称。将第三方游戏 iframe 到独立站之前，应确认开发者授权、嵌入条款、素材使用权限和广告许可。

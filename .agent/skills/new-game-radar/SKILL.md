---
name: new-game-radar
description: |
  监控竞争站 Sitemap、itch.io HTML5 游戏列表与 RSS，识别新增游戏名，建立 Google Trends 和 SERP 验证队列。

  触发条件：
  - 用户要求发现新游戏名、监控游戏 Sitemap、寻找 HTML5 游戏 SEO 趋势词
  - 用户要求运行 New Game Radar 或解释候选评分
---

# New Game Radar

## 目标

比普通游戏站更早发现开始扩散的新游戏名称，并把它们送入：

1. Google Trends 最近 7 天验证
2. Google Trends 最近 30 天验证
3. Google SERP 竞争检查
4. 域名可注册性检查
5. 纯 HTML 建站队列

核心原则：搜索结果少是供给信号，不是需求信号。Steam累计愿望单、官方预告片播放量和低SERP结果数都不能单独触发建站。

## 来源优先级

1. 多个竞争站 Sitemap 同时新增同一游戏
2. itch.io New & Popular
3. itch.io Featured
4. itch.io 最新 HTML5 / New Feed
5. 其他 RSS、Jam 或开发者源

## 操作流程

### 1. 配置来源

编辑 `config/sources.json`。竞争站 Sitemap 应设置：

```json
{
  "kind": "competitor-sitemap",
  "fetchKind": "sitemap",
  "baselineOnly": true
}
```

### 2. 扫描

```bash
npm run scan
```

扫描结果写入：

- `data/state.json`：每个来源的 URL 快照
- `data/candidates.json`：候选游戏名
- `data/latest-report.json`：最近扫描状态

### 3. 候选验证

优先验证分数 >= 12 的名称：

- Trends US / 7 天：是否持续上升，而非单个尖峰
- Trends US / 30 天：是否有基础热度或扩散轨迹
- 精确游戏名 SERP：第一页是否缺少可直接玩的独立页面
- `game name play online`：是否已被大型游戏站覆盖
- 域名：精确名称或可识别变体是否为正常注册价

### 4. 处理结果

- `selected`：准备注册域名并建站
- `done`：站点已上线
- `ignored`：无趋势、竞争过强、名称歧义或无法授权嵌入

## 最终机会模型

按以下权重计算可解释机会分：

- 社媒传播速度 30%
- Steam／平台增长速度 25%
- 搜索需求形成 15%
- 内容可扩展性 15%
- SERP空缺 10%
- 名称安全 5%

独立站推荐还必须同时满足：

1. 至少两个社媒平台、至少四个独立创作者形成传播，且24小时仍有新增
2. Steam名次近期上升或刚进入高位榜；累计愿望单高但近期不增长只能观察
3. Trends或游戏型自动补全表明搜索需求正在形成
4. 至少3个真实Wiki/攻略主题，避免只能写发行日、配置和Steam介绍
5. 90天历史为新词，且没有同名专站、专门Wiki或多个攻略站占位
6. 名称风险通过，不与歌曲、影视、产品或通用实体冲突

单个平台、单个官方频道或单条高播放视频不能证明外溢传播。多来源交叉出现比单一平台信号更重要。评分只负责排序，硬门槛决定能否进入独立站队列。

## 安全要求

- 不扫描 localhost、私网 IP 或带账号密码的 URL
- 限制 Sitemap 子文件数量和响应大小
- 不抓取登录后内容
- 不绕过 Robots、付费墙或访问控制
- 不未经许可重新托管或嵌入第三方游戏

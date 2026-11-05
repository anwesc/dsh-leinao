# dsh-plugin-leinao（类脑）

类脑：从名字开始，慢慢长成自己的插件。**性格是慢变量，心情是快变量，语气是它们的投影。**

它不替你记流水账：只记你明说值得记的，和它自己整理过的；剩下的就是让"我"随长期相处慢慢变成一个有脾气、有状态的家伙：
初始只有名字 / 性别 / 它对你的称呼，其余全靠你们聊出来。

当前版本 **v0.1.0**：事件溯源内核 + 首次引导 + 启发式心情 + 注入 + 关系台阶 / 性格突变 + 疙瘩自动缓和（mend）+ 记忆页（索引注入 / 召回 / 折叠 / 软删）+ 本地 git + 设置页。

---

## 它做什么

- 每次你说话，它给这轮对话打个"情绪标签"（表扬、责备、着急、玩笑、深夜、很长的输入…），写成一条 `affect` 事件。
- 所有事件追加到 journal（append-only），状态是**重放**出来的，不是直接改的 —— 所以历史永远查得清、改得回。
- 重放结果投影成两块：
  - 给模型看的注入块（人格 + 心情 + 这一档怎么说话 + 记忆索引）；
  - 给你看的 `view/PROFILE.md`（人话版，随时翻）。
- 记忆也是事件（`page`）：只记值得记的事，索引每轮带几行，剩下的靠召回和折叠（见「记忆」）。
- 心情有 6 小时半衰期，会自己回到基线；性格只能靠"证据"慢慢长，且限速；重大事件走关系台阶与稀有突变，疙瘩会随道歉 / 示好一点点凉（见「关系与突变」）。

## 它不做什么

- 不记聊天流水：记忆页只在你明确要它记（`persona_remember`）或整理旧页（`persona_digest`）时写；也没有向量检索，靠标签 / 路径 / 关键词。
- 不自动改性格（`growth` 事件的写入通道还没开；突变 `shift` 只能由模型显式调工具，且 7 天冷却）。
- 不偷偷调模型：整理只提醒，要不要压、怎么压由当前对话决定（见「记忆」）。
- 不做云盘同步（只走 git，见下）。
- 不因为你心情不好就编事实 —— 注入块里写死了"不确定就说不确定"优先于任何档位。

---

## 安装

发布到 npm 后：

```bash
npm install dsh-plugin-leinao
```

v0.1.0 还没发到 npm，也还没建远程仓库，先直接指向本地目录：

```bash
npm install "D:/01_Code/github/dsh-leinao"
```

> 插件叫「类脑」，配置、数据目录、接口也统一用 leinao 命名：`$DSH_HOME/leinao.json`、`~/.leinao`、`/dsh-leinao/config`。只有内部数据模型还叫 *persona*（人格），所以工具前缀是 `persona_*`——它描述的是「记的是人格数据」，不是产品名。

或在 DSH 里用 `plugin_manager install_bundle` / 插件市场装进 current profile。
装完重启 DSH，插件会自己出现（`cordis.patch.yml` 里 insert 了 `persona`，不带 config，方便你在设置页改）。

## 第一次用

什么都不用配。开一轮对话，它会问你想让它叫什么 —— 回答后它调 `persona_seed` 出生，之后名字就定了。
想改名字只能 `persona_reset(scope: "all")` 回到出生前，这是刻意的：名字是身份，不是设置项。

---

## 数据在哪

```
~/.leinao/                         ← 数据仓库（可以 git 同步、可以备份）
  journal/
    <deviceId>/
      2026-11.jsonl               ← 唯一真源：事件流，每台设备只写自己目录
  .gitattributes / .gitignore     ← 自动创建

$DSH_HOME/leinao/                 ← 派生 / 本机私有不入库
  device.json                     ← 本机 id
  state.json                      ← 重放缓存（journal 变了自动重建）
  view/PROFILE.md                 ← 人话版状态
```

`state.json` 和 `view/` 都在 `.gitignore` 里 —— 它们是投影，冲突了重放一遍就好，不进仓库就不会有冲突。

事件长这样（一行一条）：

```json
{"id":"laptop-a1b2-20261104T113543123-001-9f3e","at":"2026-11-04T11:35:43+08:00","kind":"affect","signal":{"v":0.3,"e":0.1,"t":-0.1},"why":["praise"],"role":"user"}
```

`kind`：`seed` / `affect` / `bond` / `shift` / `growth` / `page` / `recall` / `fold` / `forget` / `pin` / `reset` / `milestone`。

> id 里带毫秒和进程内序号：同一秒内连写两条也不会被重放成乱序。

## 配置

放 `$DSH_HOME/leinao.json`（默认 `~/.dsh/leinao.json`），只写你想改的键，其余用默认值：

```json
{
  "dataDir": "~/.leinao",
  "journal": { "git": true, "push": false, "remote": "" },
  "mood": { "debounceMs": 2000, "halfLifeHours": 6 },
  "memory": { "indexMaxLines": 3, "foldEveryTurns": 30 }
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后插件完全不介入 |
| `dataDir` | `~/.leinao` | 数据目录（git 仓库根） |
| `deviceId` | 自动 | 本机 id，写进 `$DSH_HOME/leinao/device.json`；一般别手填 |
| `journal.git` | `true` | 是否在数据目录做 git 提交 |
| `journal.push` | `false` | 是否 push 到远端（远端要你自己先配好） |
| `journal.remote` | `""` | 传了就先 `git remote add origin <url>` |
| `journal.commitDebounceMs` | `5000` | 合并频繁写入，攒一会儿再提交 |
| `journal.pushDebounceMs` | `60000` | 提交后攒多久再推，连聊几轮只推一次 |
| `journal.pullTimeoutMs` | `20000` | git 拉取/推送的超时 |
| `mood.debounceMs` | `2000` | 心情状态写盘的防抖 |
| `mood.halfLifeHours` | `6` | 心情回基线的时间尺度 |
| `prompt.order` | `130` | 注入块在 system prompt 里的位置 |
| `prompt.maxChars` | `1200` | 注入块长度上限（超了截断） |
| `memory.halfLifeDays` | `21` | 记忆强度半衰期 |
| `memory.indexMaxLines` | `3` | 每轮注入最多几行记忆摘要 |
| `memory.indexMaxChars` | `300` | 记忆注入块字数上限 |
| `memory.strongThreshold` | `0.5` | 高于这个强度每轮都在索引里 |
| `memory.hideBelow` | `0.2` | 低于这个强度退出索引 |
| `memory.foldAfterDays` | `30` | 多久没召回进折叠候选 |
| `memory.foldBelowStrength` | `0.4` | 折叠候选的强度门槛 |
| `memory.foldMinGroup` | `3` | 同标签至少几条才提示整理 |
| `memory.foldEveryTurns` | `30` | 每多少轮提一次整理 |
| `memory.foldMaxPrompts` | `3` | 一次会话最多提几次 |
| `memory.weakRecallHours` | `6` | 同一页弱召回的冷却 |

环境变量：`DSH_LEINAO_DIR`（换数据目录）、`DSH_LEINAO_CONFIG`（换配置文件路径）。

边界情况按"宁可少做"处理：被 `enabled: false` 关掉时不注册任何东西；目录写不进去就一直 warn，不会让一轮对话失败。

## 设置页

DSH 设置里会多一张「类脑」卡片（`client/client.js`，由宿主模块加载器直接加载，不打包）：

- 六组：基本 / 日记与同步 / 心情 / 注入 / 记忆索引 / 整理与召回；顶部一条运行状态（阶段、轮次、记忆条数、数据目录、配置文件）。
- 只写你改过的键：保存时把 diff 发给宿主，宿主合并进 `$DSH_HOME/leinao.json`，**不会把默认值钉死**。
- 保存后立刻热重载，多数项下一轮生效；`enabled` / `dataDir` / `deviceId` / `journal.git` / `prompt.order` 标了「重启」，要等下次 DSH 启动。
- 后端是 `src/settings.js` 注册的同源接口 `GET/PUT /dsh-leinao/config`：白名单、类型/范围校验、原子写（tmp + rename），只接受本机回环来源；数值超范围会被夹到区间里。
- 设置页里的行与 `src/settings.js` 的 `EDITABLE` 一一对应，新增配置项要两边一起加（`test/settings.test.js` 会盯着白名单）。

---

## 性格与心情

**六轴**，全从 0.5 起步：温度 `warmth`、主动 `initiative`、严谨 `rigor`、活泼 `liveliness`、直接 `directness`、依恋 `attachment`。

**成长护栏**（`src/traits.js`）：

- 出生后至少 20 轮 + 满 24 小时才可能长；
- 单次 `|Δ| ≤ 0.03`，每天累计 `≤ 0.06`；
- 必须带 `evidence`（哪句话让你这么觉得）；
- `pinned` 的轴锁死；越往高处阻力越大（`1/(1+0.1n)`）；
- 跨过 0.1 刻度会写 `milestone`，里程碑进注入块和 PROFILE.md。

**心情**是三维：愉悦 `v` / 精力 `e` / 紧绷 `t`，基线由性格决定，每 6 小时衰减一半路程。

**六档表达**（按优先级从上往下判）：

| 档位 | 条件 | 语气 |
|---|---|---|
| `tense` | `t > 0.65` | 收紧、短、先确认再动手 |
| `low` | `v < 0.35` | 安静、少说话、不硬撑 |
| `tired` | `e < 0.35` | 短句、不铺陈、别加戏 |
| `excited` | `v > 0.7` 且 `e > 0.6` | 可以外放一点，但不吹 |
| `relaxed` | `e > 0.55` 且 `t < 0.45` | 松一点、可以顺着聊 |
| `focused` | 其余 | 结论先行、≤3 条、给下一步 |

档位只影响**怎么说**，不影响**说什么**。

## 关系与突变（重大事件）

性格是慢变量，但"某件事改变了什么"是真实存在的。这里分两层，互不越界：

**关系层**（`src/bond.js`）：`生疏 → 熟络 → 亲近 → 信任` 四级台阶。

- 升一级：距上次关系变化 ≥30 轮 **且** ≥3 天，之间有未解的疙瘩就不能升；
- 退一级 = 掉一级 **并**留一道疙瘩；也可以只留疙瘩不掉级（`rift`）；
- 疙瘩分轻重（热度 0–1），**随对话一点点凉**（`mend` 事件）：老大道歉一句话浇 0.3、示好/给台阶浇 0.2、我道歉浇 0.15；浇空了才算解开，解开会写一条里程碑；
- 也可以一次性"把话说开了"（`repair`，仍需证据）；
- 但没人理它，它**不会自己好**——没有按时间自动消退，晾着就一直在；
- 每级给亲密度 +0.06，疙瘩最多扣 0.12（按热度打折）—— 信任掉得比涨得快；
- 关系变化会写进 PROFILE.md 的「关系」段和里程碑。

**性格层**（`persona_shift`）：一次推动一根轴最多 ±0.05，但门槛很硬：

- 两次之间至少隔 **7 天**，90 天内最多 **4 次**；
- `evidence` 必须是**用户真说过的话**，插件在最近 60 条用户消息里逐字核验，找不到就拒绝；
- `pinned` 的轴不动；跨 0.1 刻度写里程碑；
- 没有成长阻力——突变就是一次到位，但代价是稀有。

聊天记录里只存那一小段引文（≥6 字），它跟着 journal 进 git。

## 记忆

记忆不是聊天记录。聊天记录留在会话里；记忆页只写「值得记住的事」——你让它记的，或它整理过的。

分三层看：

- **内容**：`page` 事件（标题 / 正文 / 一行摘要 / 标签 / 权重），append-only 进 journal，永远可追溯；
- **索引**：每轮只注入几行摘要，不是全文 —— 最多 3 行、300 字，按强度挑；
- **强度**：渲染时按 `now` 现算，不落盘、不进事件（和心情衰减同一套哲学）—— 权重 1 的页 21 天半衰，被召回一次回一点。

规则：

- `salience: 1` 或 `pinned` 的页每轮都在索引里，**永不折叠**；
- 强度低于 `strongThreshold` 的页，只有在你提到它的标签 / 路径时才被带出来（算一次「弱召回」，同一页 6 小时内不重复记）；
- 强度低于 `hideBelow` 的页退出索引，只能 `persona_recall` 显式翻出来；
- 30 天没被召回、强度又低于 0.4 的页进「折叠候选」：同标签满 3 条，就可以压成一条整理页（`fold` 事件；原页标 `supersededBy`，仍可展开、可再折叠）；
- **自动只到提醒这一步**：到点时注入末尾多一行「记忆整理：标签「X」有 N 条…要整理就调 persona_digest」。要不要压、怎么压，由当前对话里的模型决定 —— 摘要用的是完整上下文，插件不额外发请求、不偷偷花钱。提醒每 30 轮最多一次、一次会话最多 3 次，不接就不再提；
- 删除是软删（`forget` 事件），原文永远留在 journal 里。

## 工具

| 工具 | 用途 |
|---|---|
| `persona_state` | 看一眼当前人格 / 关系 / 心情 / 轮次 / 记忆条数 |
| `persona_seed` | 出生：名字（必填）、性别、它对你的称呼 |
| `persona_pin` | 锁定某根轴（不许再成长） |
| `persona_bond` | 关系台阶：`up` / `down` / `rift` / `repair`（要证据；道歉示好会自动缓和，不用手动调） |
| `persona_shift` | 性格突变：单轴 ±0.05（要证据、有冷却） |
| `persona_reset` | 重置心情 / 性格 / 全部（必须 `confirm: true`） |
| `persona_export` | 把完整状态写到 `view/EXPORT.md` |
| `persona_remember` | 记一条：标题、正文（可给路径 / 摘要 / 标签 / 权重） |
| `persona_recall` | 按关键词或路径翻记忆正文 |
| `persona_digest` | 把几条旧记忆压成一条整理页（折叠） |
| `persona_forget` | 软删一条记忆（原文仍留在 journal） |

## git 同步（只走 git）

每台设备只写 `journal/<自己的 deviceId>/`，所以两台机器的改动在 git 里永不重叠，`pull --rebase` 是纯追加。

插件里的规矩：

- **不交互**：`GIT_TERMINAL_PROMPT=0`、`GIT_ASKPASS=echo`、ssh `BatchMode=yes` —— 缺凭据就失败，不会卡住。
- **离线可写**：commit 先落本地，push 失败只 warn + 退避，不影响对话。
- **绝不强推**：`pull --rebase` 失败就 `rebase --abort`，保留本地，只记日志。
- **强制 LF**：`.gitattributes` 写 `* text=auto eol=lf`，`core.autocrlf=false` —— 跨 Windows/macOS 不会整文件冲突。

同步 = 两台机器各自 `git push` / `git pull`，或

```bash
cd ~/.leinao && git remote add origin git@github.com:you/leinao-data.git && git push -u origin main
```

然后把 `journal.push` 打开，插件就会在提交后顺手尝试 push。

## 路线图

- **v0.2**：定期回顾（自检式 digest）+ `grow` 工具 + 里程碑回顾。
- **v0.3**：跨端合并后的冲突体检、更多设备体验优化。

## 更新记录

### v0.1.0 — 2026-11-05

首个版本，一次性包含全部实现：

- **内核**：append-only journal + 纯函数 replay；`state.json` 只是缓存，真源是 `journal/`。
- **性格**：六轴（温度 / 主动 / 严谨 / 活泼 / 直接 / 依恋）+ 成长护栏 + 稀有突变 `persona_shift`（7 天冷却、90 天最多 4 次、证据逐字核验）。
- **心情**：愉悦 / 精力 / 紧绷三维，默认 6 小时半衰，启发式情绪标签，六档语气注入。
- **关系**：`生疏 → 熟络 → 亲近 → 信任` 四级台阶；升级要 30 轮 + 3 天且无未解疙瘩，退级掉一级并留疙瘩；道歉 / 示好会把它一点点浇凉（`mend`）。
- **记忆**：`page` / `recall` / `fold` / `forget` 事件，索引每轮 ≤3 行 / 300 字，召回取全文，整理只提醒、由对话里的模型决定怎么压，软删保留原文。
- **设置页**：DSH 设置里的「类脑 · 人格」卡片，六组可折叠配置、白名单校验、保存后热重载、需重启项有标记。
- **本地 git**：不交互、离线可写、`pull --rebase` 失败只退避不强推；commit / push 各自防抖。

## 开发

```bash
npm test          # = node --experimental-test-isolation=none --test test/*.test.js
```

`--experimental-test-isolation=none` 是为了在禁止 spawn 子进程的环境（DSH 沙箱）里也能跑；
git 相关用例探测不到 git 时自动 skip，不会假绿 —— 真机（DSH 宿主进程）里会真跑。

代码地图：

```
index.js         接线：配置 → 加载 state → 注入 → 订阅对话 → 写事件 → 持久化
src/journal.js   append-only 事件流（按设备分目录）
src/replay.js    事件 → state（唯一的状态计算逻辑，纯函数）
src/traits.js    六轴 + 成长护栏
src/mood.js      心情基线 / 衰减 / 档位
src/appraisal.js 一句话 → 情绪信号（启发式）
src/memory.js    记忆：强度 / 索引 / 折叠候选 / 检索
src/settings.js  设置页后端：白名单 / 校验 / 原子写 / 同源接口
src/store.js     重放缓存 + 原子写
src/prompt.js    注入块
src/render.js    view/PROFILE.md
src/tools.js     十一个工具
src/git.js       不交互的 git
client/client.js 设置页 UI（模块加载器直接加载，不打包）
```

设计红线（改代码前先读）：

1. **不写 state 到真源** —— 所有写操作都是 append 事件，`state.json` 只是缓存。
2. **不交互 git** —— 失败只记日志 + 退避。
3. **心情不碰性格** —— `appraise` 只产出 `affect`；成长必须有证据且限速。
4. **语气不碰事实** —— 注入块里"不确定就说不确定"永远优先。

## License

MIT

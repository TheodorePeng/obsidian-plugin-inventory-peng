# 0.1.0 阶段版验收

日期：2026-11-10。根据用户要求缩减验证规模，以尽快提供可使用版本。

## 已通过

- `npm run typecheck`：通过。
- `npm run lint`：通过。
- `npm test`：5 项通过，覆盖混合语言正文、自定义属性与 YAML 注释保留；相同内容不改写；卸载保留 last_seen；非法 YAML/身份变化停止写入；路径边界；Base 用户视图保留。
- `npm run build`：通过。
- 已核对源码与默认测试 Vault 真实路径，部署三项运行文件并保留 data.json；启用 Plugin Inventory Peng 成功。
- **真实运行、程序入口验证**：在 Obsidian AI Coding 的 `_PluginTests/plugin-inventory-peng/Inventory/` 完成首次创建，识别 30 个 Core 与 84 个 Community（包含自身），共 114 条记录。
- **真实原生 Base 渲染**：通过注册的 Open inventory 命令打开，界面显示 Installed / 114 results。
- **真实后续刷新**：同步摘要为 `114 plugins · +0 / ↻0 · 0 missing`，插件错误列表为空；清单打开时已启用周期刷新。

首次批量生成耗时超过一次 CLI 等待的 45 秒预算；应用中的原任务继续执行，因此没有重发创建。后续观察确认全部记录生成且刷新稳定。该超时不是历史完整性或 Settings UI 的验收证据。

## 尚未真实验收

跨 Vault 定位；真实启停其他插件后的 5 秒同步目标；弹窗批量处理；子文件夹/目录改名跟踪；独立窗口；中英文 IME 与并发编辑。没有为了测试而改动已有第三方插件。（Settings 界面的物理点击与 URI 点击已于 2026-11-12 补验，见下节。）

## 2026-11-12 补充：Note 级 Settings 属性

范围：把 Base 里动态计算的 Settings 链接物化到每条 Note 的 frontmatter `settings` 属性，使单独打开 Note 时属性面板里也有可点击的设置入口。Base 侧公式未改动。

### 已通过

- `npm run typecheck`、`npm run lint`、`npm run build`：通过。`npm test`：9 项通过（既有 6 项无回归，新增 3 项覆盖决策表防漂移、新 Note 写入、刷新／保留／幂等）。
- **属性渲染（真实 DOM）**：Obsidian 1.15.0 把 `settings` 的值渲染为 `.metadata-link-inner.external-link`，`data-href` 为完整 adv-uri，标签为 `⚙ Settings`；属性面板中该行显示为可点击链接。
- **物理点击**：Admonition 的 Note 点击后打开 Settings 窗口并直接显示该插件的 "Admonition Settings" 面板；已停用插件（Advanced Canvas）的 Note 点击后打开 Community plugins 总览，与 Base 公式的降级规则一致。
- **回填**：84 条受管社区插件 Note 全部写入 `settings`，同时补齐 `tier`／`source`／`aliases`／`github`（github 仅在可解析时写入，不写空值）。
- **双源一致性**：Base 的 114 行 Settings 链接与 Note 属性逐字符比对，84 行完全一致、0 处不一致；其余 30 行为插件当前不管理的 Core 笔记。
- **幂等性**：强制执行刷新命令后，114 个 Library 文件的 mtime 快照完全不变，镜像不会在周期刷新中改写文件。
- **Base 未受影响**：`base:query` 仍返回 114 行，Settings 列链接完好。
- **运行时错误**：`dev:errors` 中没有本插件产生的错误（仅有一个与本次无关的 `plugin:iconic` 报错）。

### 已知限制与未验证项

- **Calendar 的 Note 停在 General Settings**：`app.setting.openTabById("calendar")` 在 Obsidian 1.15.0 下自身抛错（Calendar 插件的设置面板渲染崩溃），Advanced URI 因此未能切页。Base 列使用同一条 href，行为完全一致，属既有第三方问题，非本次改动引入。
- **30 条 Core 笔记没有该属性**：插件设置中的「包含官方内置功能」当前为关闭状态，插件不管理这些笔记，也不向它们写入任何自动字段；打开该开关后即可获得同样属性。
- Advanced URI 缺失／被禁用时的「保留旧值」分支只有单元测试覆盖，未在运行时实测（实测需卸载或禁用第三方插件，超出本次授权）。
- 跨 Vault 复制后链接内的 Vault 标识会失效，与 Base 公式同源同风险，需在新 Vault 重新同步。

### 数据变化

部署前已将 `Inventory/`（Base + 114 条 Note）备份到 `_PluginTests/plugin-inventory-peng/_backup-20261112-211343/`。本次同步改写了 84 条 Library Note（新增 `settings` 并补齐 schema 字段），未改动 `data.json`，未触碰其他插件配置与用户正文。临时探针 Note 已删除。

## 明确延期

事务式设置路径迁移向导、迁移中断恢复、任意既有 Base 接管。阶段版拒绝覆盖未知 Base，拒绝将初始化后的路径直接切换成另一套位置；支持通过 Obsidian 文件列表移动现有清单，但尚未做完整移动矩阵验证。

## 数据与仓库

已安装目标插件并创建其自身设置与专用测试记录。没有向正式 Plugins 目录写入清单，没有修改其他插件配置或用户正文。独立 Git 仓库已初始化为 main。2026-11-11 补充：仓库已推送至 GitHub（`TheodorePeng/obsidian-plugin-inventory-peng`）并发布 `0.1.0` Release 供 BRAT 分发。

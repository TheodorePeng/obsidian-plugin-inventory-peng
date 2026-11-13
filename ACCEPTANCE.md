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

## 2026-11-13：设置页与路径迁移重构

本节取代上面的“事务式迁移向导、中断恢复”延期状态；任意未知 Base 接管仍不支持。

- **原问题复现（真实运行、内部入口）**：旧版已初始化后，指定新 Base 路径调用 `initialize` 返回 `Stage version: move the existing inventory in Obsidian File Explorer; it will follow the move. Settings-driven migration is not yet enabled.`
- **自动检查**：`npm run build`（含类型检查）通过；`npm test` 13 项通过。测试替身覆盖嵌套 Base 的移动、目标冲突、受管筛选被更改，以及模拟写入失败和重新加载日志后的保守恢复。`npm run lint` 退出成功，仍有 130 条警告，主要为项目既有动态接口类型警告和设置 API 提示。
- **真实界面**：Obsidian AI Coding、Obsidian 1.15.0；确认旧路径转换、长路径布局、目录和 Base 建议、非法扩展名禁用操作、检查清单、打开 Base，以及仅移动 Base 时的确认文案。浅色界面已观察。
- **真实文件操作＋隔离界面**：使用插件专用测试目录、单独插件实例和两条测试记录，通过设置界面创建清单并确认移动嵌套 Base 与笔记文件夹；目标存在、摘要正常。该实例的设置保存使用内存替身，未覆盖真实插件 `data.json`。另一次真实 API 验证在测试笔记写入稳定后移动，正文标记在移动后及数秒后仍存在，迁移日志在内存中清除。
- **原清单**：运行副本已部署并定向重载；原路径及 84 条受管记录保留，最终摘要为 0 missing、0 issues。部署前备份位于测试区 `_backup-settings-redesign-20261113-093942/`。对比备份：没有增删文件，插件自身笔记版本由 0.1.0 更新为 0.1.1，Base 的 Settings 公式中设置页 ID 顺序因重载发生变化。`data.json` 已转换为 schema 2；部署脚本未覆盖它。
- **测试环境观察**：在真实 Vault 中，文件刚创建后立刻修改，内容可能在随后的异步处理中回到创建内容；绕开本插件的独立测试也能观察到。稳定后再修改和移动的测试保留内容；原因未确认，不能据此宣称已解决该环境问题。
- **未验证**：真实进程中迁移断电／重启恢复、全部异常组合、深色／窄窗口、中英文切换及完整键盘导航；真实 UI 测试使用内存设置替身，不证明磁盘日志重启恢复。测试目录和复现证据保留在 `_PluginTests/plugin-inventory-peng/_validation-*`。

## 2026-11-13：Source 合并与 Base 兼容

- **自动检查**：类型检查、构建和 25 项测试通过；lint 退出成功，0 errors、130 warnings。覆盖目录分类、无缓存与离线缓存、旧 Base 和自定义筛选、用户字段、重复身份检查、中断后的日志恢复和受管 Source 缺失后的恢复。
- **官方目录**：真实请求并验证 `obsidian-releases/community-plugins.json`，得到 10,310 个有效 ID；使用缓存的已收录插件分类为 Community，无缓存时同一插件暂为 Non-community 并显示未核验。后两项为真实 Obsidian 内的受控缓存探针，不代表断网实测。
- **109 条受管笔记副本的真实运行升级**：预检并备份后完成升级，结果 Built-in 25、Community 67、Non-community 17；原笔记正文 109/109 相同，测试自定义属性保留，旧 `type` 0/109，Base 显示 Last Detected。该轮使用第一版逐文件备份；最终优化后的快照备份另以两条副本重新执行，均成功且内容保留。
- **最终优化版真实运行**：隔离副本升级 2 条、创建新清单 2 条均通过；Obsidian `base:query` 对升级后 Base 返回 Source、Last Detected 及 Settings 链接。人为移除副本的受管 Source 后刷新，最终版本成功恢复，并保留自定义属性。
- **恢复行为**：自动测试覆盖写入中断、重新载入已保存日志、源文件变化和备份完整性。真实 Obsidian 的隔离实例中人为注入中断，再用新实例读取磁盘日志恢复成功；未对整个 Obsidian 应用断电或重启。
- **原清单及部署**：源码及运行产物已部署到 Obsidian AI Coding 并定向重载；原清单的 109 条笔记与升级前副本逐项比较均相同，仍为旧格式，等待用户在设置中预览并确认升级。部署没有覆盖 data.json，插件新增的兼容状态按正常运行保存。
- **验收边界**：目录断网由受控缓存探针和自动替身测试覆盖，未切断真实网络；升级按钮与预览文本经真实设置页 DOM 检查，未完成真实鼠标确认流程；其他 Vault、复杂主题及完整键盘交互未验收。测试内容保留在 `_PluginTests/plugin-inventory-peng/_validation-source-*`。

## 2026-11-13：属性接管与互斥保存模式

本节取代此前“复杂旧 Base 规则暂停升级”的策略：主动修复先备份，修正受管属性并重建标准 Base；自定义视图保留在备份中。首次创建仍不会接管未知 Base。

- **自动检查**：最终类型检查、构建、34 项测试通过；lint 为 0 errors、132 warnings。覆盖受管字段纠正、重复字段、自定义字段冲突跳过、正文逐字保留、重复笔记隔离、缺失／损坏 Base 修复、操作中断重放、模式持久化、模式切换不移动文件及文件列表改名跟踪。
- **真实 Vault、程序入口修复**：在 `_PluginTests/plugin-inventory-peng/_validation-takeover-20261113-161336/` 创建隔离副本，注入重复受管属性、重复笔记、个人属性冲突和损坏 Base。预览并执行后修复 3 个文件，完整隔离 1 条重复笔记，跳过 1 条个人属性冲突笔记。逐字比较：2 条受管笔记正文相同、自定义属性保留；隔离的重复笔记全文相同。标准 Base 可以解析。
- **真实 Vault、程序入口保存与移动**：新实例以根目录模式创建 `Plugin Inventory.base` 和 `Plugin Library/`，随后移动到隔离区域的 `Moved/`。模式与实际路径写入独立的测试 JSON，迁移日志清除；原根目录中的 `unrelated.md` 原位保留。原生 `base:query` 返回 2 条记录，Source、Last Detected 和 Settings 链接正常。
- **真实设置 DOM、程序触发控件**：根目录模式隐藏独立路径输入；切到独立路径后隐藏根目录输入。切换只改变草稿，点击保存后才持久化；实际路径不变时没有物理移动。此项使用独立、未注册的测试设置页和程序触发 change/click，不等于真实鼠标与键盘验收。
- **最终部署**：三项运行产物部署到已核对的 `Obsidian AI Coding` 并定向重载，源码产物与安装文件 SHA-256 一致，`data.json` 部署前后 SHA-256 一致。未提交、推送或发布。
- **原清单恢复状态**：本轮开始时，原清单已经存在旧升级中断日志，进度为 90/110，备份为 `Inventory/Plugin Inventory backup 1794539644583`。本轮没有继续、清除或重置它；最终重载后仍为 90/110，自动同步暂停。上述修复与移动验收只操作隔离副本，未用测试副本覆盖原清单或插件数据。
- **未验证**：整个 Obsidian 进程重启／断电恢复、完整物理 UI 操作、所有主题与窗口尺寸及其他 Vault。恢复日志重载与模式恢复由自动测试覆盖，不能视为整应用重启验证。测试副本、备份和独立设置 JSON 保留；独立测试实例轮询已停止。

## 2026-11-13：修复中断导致设置锁定

本节更新前一节原清单仍停在 90/110 的状态。后续用户操作在内存推进至 95/110，遇到 Dataview.md 与旧快照不一致而停止；磁盘检查点仍为 90/110。差异位于属性区域，正文相同，变化来源未确认。

- 增加“重新预览当前文件”：保留旧备份，按当前内容重新扫描和预览；确认后生成新快照与日志，再修复受管字段。新备份的 plugin-data.json 保留被替换的旧恢复日志。预览过期或新日志保存失败时保留旧恢复状态。
- 恢复提示放到设置页顶部，说明路径为何暂时禁用，提供重新预览与重试原修复两个入口。检查、备份和修复显示数量进度；处理中阻止重复操作。
- 自动验证：38 项测试通过，类型检查与构建通过；lint 0 errors、132 warnings。新增覆盖当前正文／用户属性保留、旧日志归档、预览后变化、新恢复计划跳过个人属性冲突，以及新日志写入失败。
- 真实隔离副本：`_validation-recovery-1794560210/` 使用冲突的 Dataview 当前内容与旧快照测试重新规划，修复 2 个文件，无跳过、无错误，正文相同、旧快照仍存在。
- 原清单：先备份至 `_backup-recovery-1794560251/`，通过真实设置 DOM 程序触发“重新预览当前文件”与确认，修复 109 条笔记和 1 个 Base，无跳过。新备份为 `Inventory/Plugin Inventory backup 1794560381024/`；旧备份保留。原有 109 条正文全部一致，核对 436 个用户属性值全部一致。同步后为 111 条记录、0 missing、错误列表为空。
- 最终部署并定向重载后，恢复日志为空；检查清单、路径输入和模式选择均已启用。真实设置 DOM 程序触发根目录／独立路径切换，确认互斥显示、仅修改草稿；随后程序点击“检查清单”。上述是实际运行与程序触发 DOM 控件证据，不代表物理鼠标键盘验收。
- 未进行整应用重启、其他 Vault 操作、提交、推送或发布；保留既有工作区改动。最终构建再次部署，部署保留 data.json。

## 2026-11-13：0.1.2 稳定版发布记录

- 版本 0.1.2（tag / Release 名称 / manifest.json.version 三者一致）；minAppVersion 保持 1.15.0；versions.json 新增 `"0.1.2": "1.15.0"`。
- 本轮将此前各节所述的设置页与路径迁移重构、Source 合并与官方社区插件目录、受管属性接管、根目录／独立路径互斥保存模式、升级中断恢复，连同扩展的自动化测试与样式刷新，一并整理为 0.1.2 的发布内容。
- 发布流程：preflight → bump-versions → lint / test / typecheck / build / git diff --check → 提交 → 推送 main → 推送 tag 0.1.2 → gh release create（资产 main.js / manifest.json / styles.css）→ verify → registry-update → 同步测试 Vault。
- 以上各节中「未提交、推送或发布」等表述仅作为历史记录保留，不代表本版本发布后的工作区状态。

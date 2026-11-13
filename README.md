# Plugin Inventory Peng

Version 0.1.2 — usable stage release for macOS / Obsidian 1.15.0+.

[GitHub 仓库](https://github.com/TheodorePeng/obsidian-plugin-inventory-peng) · [Releases](https://github.com/TheodorePeng/obsidian-plugin-inventory-peng/releases) · Obsidian 1.15.0+ · macOS only

为每个 Obsidian Vault 建立一套**插件清单与配置知识库**：用原生 Bases 查看安装情况，用每个插件对应的 Markdown Note 记录用途、配置偏好和使用经验，让用户与 AI Agent 能够继续完善这些知识，并在需要时据此安装和配置插件。

## 这个插件能帮助你做什么？

- **日常查看**：在 Obsidian 内查看 Core / Community 插件、版本和启用状态，编辑分类、收藏和用途。
- **积累配置知识**：每个插件都有一条 Note，保存你针对当前 Vault 的配置偏好、原因与验证方法。卸载插件后仍保留笔记。
- **与 AI 协作**：AI 可以根据插件 ID 准确定位项目，阅读配置文档，与你讨论需要怎样设置，再在你的授权范围内执行安装或配置。
- **迁移时复用**：将清单和 Notes 带到另一个 Vault，AI 可以逐个读取你指定的插件记录，协助建立新的插件环境。

本插件负责记录与展示。AI Agent 的能力来自你使用的 AI 工具；本插件没有内置模型、聊天窗口或 AI 自动执行功能，也不需要配置 AI API Key。

## 安装

本插件尚未进入官方社区插件目录，请通过 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 或手动复制文件安装。

### 方式一：通过 BRAT 安装（推荐，可自动更新）

1. 在 Obsidian 社区插件市场安装并启用 **BRAT**（显示名 `Obsidian42 - BRAT`）。
2. 打开命令面板，运行 `BRAT: Add a beta plugin for testing`。
3. 输入仓库地址 `TheodorePeng/obsidian-plugin-inventory-peng`，点击 **Add Plugin**。
4. 在 **设置 → BRAT** 中确认该插件已启用。
5. 以后需要更新时，在 BRAT 中运行 `BRAT: Check for updates to all beta plugins and UPDATE`。

### 方式二：手动安装

从 [Releases](https://github.com/TheodorePeng/obsidian-plugin-inventory-peng/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`，放入目标 Vault 的 `.obsidian/plugins/plugin-inventory-peng/` 目录，重启 Obsidian 后在社区插件列表中启用。

如果该目录下已有 `data.json`，请保留它，不要覆盖——其中保存着你的设置和清单路径。

### 关于安装方式的说明

BRAT 的界面和命令名称可能随版本变化，具体以 [BRAT 官方仓库](https://github.com/TfTHacker/obsidian42-brat) 和 [开发者文档](https://tfthacker.com/brat-developers) 为准。本插件的分发以 GitHub Releases 中的 `main.js`、`manifest.json`、`styles.css` 三个文件为准。

## 快速开始

1. 启用官方 **Bases** 和本插件。
2. 打开 **Plugin Inventory Peng** 设置，选择保存方式。默认“根目录”：只选一个目录，自动使用 `Plugin Inventory.base` 和 `Plugin Library/`；选择“独立路径”时，分别填写 Base 文件和笔记文件夹。两种方式互斥，路径都相对于 Vault。
3. 点击“创建清单”，再点击“打开清单”。以后可使用“检查清单”检查并同步。清单打开期间每 3 秒检查一次，关闭后停止轮询；随时可手动刷新。
4. 点击插件名称打开对应 Note，与 AI Agent 讨论后填写 `Configuration` 表格。初始表头使用英文，内容可中英文混写。

首次创建会为当前安装的插件批量生成 Notes，可能需要数十秒；请等待完成，无需重复点击创建。

默认布局：

```text
Plugins/
├── Plugin Inventory.base
└── Plugin Library/
    └── 每个插件一条 Note.md
```

根目录模式只编辑根目录，独立路径模式只编辑 Base 和笔记路径；笔记文件夹允许内部子文件夹。切换模式只改变草稿；保存或确认移动后才生效。现有清单保持独立路径模式，不自动移动或将旧 Library 改名。`.base` 保存视图和筛选，Markdown 笔记保存实际记录。文件夹可不存在，创建时会自动建立。

### 清单的数据究竟在哪里？

| 内容 | 作用 | AI 如何使用 |
|---|---|---|
| `Plugin Inventory.base` | 定义表格、视图、筛选和展示入口 | 查看清单如何组织、引用了哪个 Library |
| Library 中 Note 的 Properties | 保存插件 ID、名称、类型、状态等结构化信息 | 定位插件、查询项目、判断目标 Vault 是否需要安装 |
| Note 正文的 `Configuration` | 保存用户的期望配置、操作说明及原因 | 与用户讨论配置、比较实际环境、执行并验证获准的修改 |

**实际记录保存在 Markdown Notes 中。** AI 阅读 database 时，应根据 Base 的路径和筛选范围找到关联 Notes，递归读取 Library 中的相关文件；不能只读 `.base` 就认为已经获取全部插件资料。

标准视图包含 All Plugins、Must-Have、Third-party、Community、Non-community、Core 和 Uninstalled。`plugin_id` 未放在默认可见列中，但已经写入每条 Note；可在 Bases 的属性选择中将它显示出来。

### 哪些内容由谁维护？

| 维护方 | 内容 |
|---|---|
| 本插件自动维护 | `plugin_id`、`name`、`source`、`status`、`version`、`last_seen`、`settings` |
| 用户或 AI Agent 维护 | `tier`、`aliases`、`category`、`favorite`、`purpose`、正文及其他扩展属性 |

`status` 使用 `enabled`、`disabled`、`uninstalled`；Core 插件没有普通意义上的卸载，只有前两种状态。Core 没有独立版本时留空。`last_seen` 在 Base 中显示为 **Last Detected**，表示最后一次检测到插件的日期，不代表上次使用。禁用的社区插件仍可被检测；普通同步目前检测启用的 Core 功能；修复既有笔记时也会核对禁用的 Core 功能。

刷新时只更新自动字段。用户字段和正文保留，数据未变化时不改写文件；卸载社区插件只更新状态，重新安装时按插件身份复用旧记录。新建笔记时提供 `tier`、`aliases`、`category` 和 `purpose` 初值；它们由用户维护，删除后同步不会重建。插件必要的自动字段被删除时可能恢复。

### Source 与旧版清单升级

- **Built-in**：Obsidian 内置功能；**Community**：插件 ID 在已获取的官方社区目录中；**Non-community**：目录未列出，或尚无可用目录缓存。它不区分本人和其他开发者，也不能证明本地文件与目录发布版本完全相同。
- 插件请求 Obsidian 官方社区目录并缓存 ID；自动请求最多每天一次，手动刷新可立即重试。失败时保留旧缓存；没有缓存时暂用 Non-community，设置页会提示尚未核验。请求不包含 Vault、笔记或插件列表。
- 已有清单使用“修复清单 → 预览修复”：预览受管字段、重复笔记和跳过项，确认后先备份，再修复属性并重建标准 Base。旧自定义视图与公式保存在备份，不再阻止升级；普通刷新不会反复重建 Base。
- 受管属性缺失、格式错误、值陌生或重复时，修复会使用扫描结果和已跟踪身份纠正。`author`、`github` 没有可靠新值时保留；Settings 依赖缺失时保留已有链接。用户属性与正文保留。
- 同一插件的重复笔记优先保留已跟踪路径，否则按完整路径排序保留第一条；其余完整移到备份的 conflicts/，不合并正文，也不修改其他笔记的链接。
- 自定义属性同名同值可合并；同名不同值、严重 YAML 错误、正文边界或身份不明确时跳过文件，修复其余内容并显示结果。被跳过的文件需处理后再次修复，普通同步不会强行覆盖它们。
- 备份中的 snapshot.json 包含原文和预期结果，manifest.json 记录路径与校验值，plugin-data.json 保留插件状态。修复中断后，设置页顶部显示恢复状态并暂停路径修改与同步。文件未变化时可“重试原修复”；文件有变化时选择“重新预览当前文件”，确认后备份当前内容并建立新计划，修正受管字段、保留当前正文与自定义属性。旧恢复日志随插件状态写入新备份，旧备份保留；不会用旧快照覆盖新编辑。

Settings 列需要 **Advanced URI** 已安装并启用。链接携带当前 Vault 标识；目标无设置页时进入插件总览。不自动安装任何依赖或启停其他插件。

同一条设置链接也写在每条 Note 的 `settings` 属性里，所以单独打开某条 Note 时，属性面板中同样有一个可点击的 `⚙ Settings` 入口。该属性与 Settings 列指向同一个目标，由同一次刷新维护；Advanced URI 不可用时不再写入新链接，已有链接保持原样。若你手动改过 Base 里的 Settings 公式，插件会在设置中提示 Base 列与 Note 属性可能不一致。

## 与 AI Agent 协作

### 1. 定位与安装插件

最重要的信息是 **`plugin_id` + `source`**。例如，Dataview 的 Note 会包含：

```yaml
plugin_id: dataview
name: Dataview
source: Community
```

对于官方社区目录中的插件，AI 可以用 `plugin_id` 精确查询官方注册表，找到对应项目和说明书；安装时再核对目标 Vault 与来源。Core 插件内置于 Obsidian，按需启用即可。

在 CLI 可用的环境中，AI 可使用以下命令形式安装社区插件。这里只是示例，你不必自己运行：

```sh
obsidian vault="Target Vault" plugin:install id=dataview
```

`version` 是当前或最后已知的安装记录，不是版本锁定要求。按照本项目的使用约定，未来安装采用当时可用于目标 Obsidian 的最新版本，是否启用由用户决定。当前 `status` 也不表示“必须恢复这个插件”。

对于自制插件、未进入官方目录的插件或特定 fork，单靠 ID 可能无法确定安装来源。可以由用户或 AI 补充可选属性：

```yaml
repository: https://github.com/实际维护者/实际仓库
```

本地源码、安装包位置或特殊安装方法，可以写在现有配置表格的 `Notes` 中。本插件会保留这些扩展信息，但不会自动查询或猜测来源。AI 发现来源不明、同名或 fork 差异时，应先核实，不能仅凭 ID 将自定义版本替换为官方版本。

### 2. 共同完善配置笔记

每条新 Note 的正文只预置一张空表：

```markdown
## Configuration

| Setting | Desired Value | Steps | Verification | Reason | Notes |
|---|---|---|---|---|---|
| | | | | | |
```

| 列 | 记录什么 |
|---|---|
| Setting | 具体设置项 |
| Desired Value | 当前 Vault 希望采用的配置值或行为 |
| Steps | 设置步骤，简单配置可以留空 |
| Verification | 如何确认设置生效 |
| Reason | 采用该配置的原因，便于以后调整 |
| Notes | 依赖、特殊情况、来源及补充说明 |

以模板目录为例，填写方式可以是以下形式；具体选项以安装版本为准：

| Setting | Desired Value | Steps | Verification | Reason | Notes |
|---|---|---|---|---|---|
| Template folder | `Templates` | 在插件设置中选择该目录 | 确认目录存在且模板可以调用 | 统一保存当前 Vault 的模板 | 新 Vault 中先检查路径 |

表格记录的是**期望配置**，不代表已经执行，也不是无条件执行指令。空白表格表示尚未记录配置。用户可以让 AI 结合实际需求、当前版本和使用经验提出建议，讨论后再将结论写入 Note。

模板只在新建时应用一次。后续内容由用户与 AI 维护，允许中英文混写或按需扩展；本插件不解析、补写或执行表格。凭据只记录获取和配置方法，不把实际 API Key、Token 或密码写入可迁移笔记。

### 3. 根据笔记实施配置

建议 AI 按以下流程工作：

1. **定位**：先读取清单元数据，找到用户指定的插件，再阅读对应 Note 的完整正文，无需每次加载全部插件正文。
2. **检查**：核对目标 Vault、插件来源、安装版本和实际配置。安装或启用不等于个人配置已经恢复。
3. **比较**：对照 `Desired Value` 列出差异；遇到旧版本选项、路径或依赖变化，解释需要的调整。
4. **执行**：在用户本次明确授权的范围内操作；缺少授权时先确认。笔记内容本身不构成操作授权。
5. **验证**：检查设置是否生效，并分别报告已完成、未完成和无法验证的部分。
6. **完善文档**：需要修改原有期望配置或记录新经验时，与用户对齐后更新相关内容，保留其他正文及属性。

AI 应使用当前环境支持的操作方式，不应假设每个插件都能通过同一种 JSON 格式配置，也不应默认直接覆盖插件的 `data.json`。本插件的清单功能不依赖 CLI；AI 执行安装或配置时是否使用 CLI，由其工具条件决定。

### 可以直接发给 AI 的请求

**讨论并记录配置：**

> 请在我的插件清单中找到 Templater，读取对应 Note。结合我的需求与当前实际环境，提出适合这个 Vault 的配置建议。先与我讨论，确认后写入 Configuration 表格，保留其他内容。

**在新 Vault 安装并配置指定插件：**

> 请阅读复制过来的 Dataview Note，核对目标 Vault 和插件来源，协助我安装最新兼容版本。再比较实际配置与 Configuration 表格中的期望值，说明差异，并按我们确认的范围执行和验证。

AI 必须能访问相应的文件或 Obsidian 工具才能读取和操作；仅安装本插件不会自动将这些信息发送给任何 AI 服务。

## 在另一个 Vault 复用

将 `.base` 文件及其关联的 Library Notes 一起复制；若调整目录，Base 的筛选范围也需要对应更新。只有 `.base` 文件不足以携带实际记录。

AI 可以直接读取复制后的 Notes，根据你逐个指定的插件进行安装和配置，不必先安装本管理插件。复制文件本身不会安装插件；目标 Vault 的状态与原 Vault 也可能不同。

如果希望新 Vault 同样自动维护清单，可以安装本插件，为它指定已有 Library，并选择一个新的 Base 文件路径。插件不会覆盖或接管未知的现有 Base。接入后状态按目标 Vault 的实际环境更新，正文保留。

## 移动清单与保护机制

- 已创建清单后，在根目录模式编辑根目录，或在独立路径模式编辑 Base 文件／笔记文件夹，点击“预览并移动清单”，检查源和目标后确认。整个笔记文件夹都会移动，包括其中的其他文件；插件不会覆盖或合并已有目标。
- 插件会更新受管 Base 的笔记范围，并保留自定义视图、笔记正文和自定义属性。路径不能进入 Obsidian 配置目录，新旧笔记文件夹不能互相嵌套；不能接管未知的已有 Base。
- 移动中断时自动同步暂停。设置会显示恢复状态；如果无法确认上一步结果，先检查提示中的源和目标，将原文件或文件夹恢复到源位置并确保目标不存在，然后点击“继续恢复”。不要删除恢复记录或手动改写插件数据。
- 根目录变更只移动插件 Base 和笔记文件夹，不移动根目录里的其他文件或旧备份。通过 Obsidian 文件列表移动整个根目录后仍保留根目录模式；单独改名导致固定结构失效时自动转为独立路径模式并提示。

## 其他边界
- 移出或删除 Note 后，通过“缺失记录”选择重建／移回或排除；排除项可以恢复。
- 初始化时遇到未知的已有 Base，会拒绝覆盖；可以选择一个新的 Base 文件路径，同时接入已有笔记文件夹。插件不会接管任意现有 Base。
- “修复清单”会备份并重建标准 Base；原有的恢复默认视图命令也进入修复预览。普通刷新不重建视图。
- 内部扫描接口不属于公开 API；来源不可用时保留原状态并报告问题。
- 不扫描或导出其他插件配置；联网只用于更新官方社区插件目录，不联网补全其他资料，不提供恢复计划、安装器、Notion 同步或跨 Vault 汇总。

## 开发

基于官方 obsidianmd/obsidian-sample-plugin 的最小构建模式裁剪；没有复制其他本机插件源码。

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

源码构建仅输出当前项目的 `main.js`。部署时只复制 `main.js`、`manifest.json`、`styles.css` 到目标 Vault 实际配置目录下 `plugins/plugin-inventory-peng/`，保留已有 `data.json`。

测试使用 `Obsidian AI Coding` Vault 的 `_PluginTests/plugin-inventory-peng/Inventory/`。实际验证范围及未测项目见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## 参考资料

- [Obsidian Bases](https://obsidian.md/help/bases)：数据与视图的关系。
- [Obsidian CLI](https://obsidian.md/help/cli)：查询、安装及启用插件的命令。
- [官方社区插件注册表](https://github.com/obsidianmd/obsidian-releases/blob/master/community-plugins.json)：插件 ID 与项目仓库的对应关系。

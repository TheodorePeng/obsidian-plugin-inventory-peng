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

1. 启用插件。使用 **Create Plugin Inventory** 选择根目录。留空表示 Vault 根目录。启用 Obsidian 官方 **Bases** 后，可以打开 `.base` 文件。
2. 审阅生成预览。确认后插件生成默认 Library、插件笔记和 Base，并将其设为当前清单。
3. 用 **Open Plugin Index** 查看清单。用 **Refresh Plugin Status** 更新已有笔记，用 **Fill Missing Plugin Notes** 预览并补齐 Markdown。
4. 在设置中的 **Note Template** 编辑新笔记正文，点击 **Save Template** 后生效。默认提供 Configuration 表格，保存空模板可生成空正文。

默认布局：

```text
Plugins/
├── Plugin Index.base
└── Plugin Library/
    └── 每个插件一篇 Markdown 笔记
```

每个 Vault 同时连接一个 Library 和一个可选的 Base。两条路径可独立更改。首次安装、重新开始或删除旧清单后，都可运行 **Create Plugin Inventory**。创建流程只使用空闲目标，旧路径和名称不会在升级时自动改写。

### 清单的数据究竟在哪里？

| 内容 | 作用 | AI 如何使用 |
|---|---|---|
| `Plugin Index.base` | 定义表格、视图、筛选和展示入口 | 查看清单如何组织、引用了哪个 Library |
| Library 中 Note 的 Properties | 保存插件 ID、名称、类型、状态等结构化信息 | 定位插件、查询项目、判断目标 Vault 是否需要安装 |
| Note 正文的 `Configuration` | 保存用户的期望配置、操作说明及原因 | 与用户讨论配置、比较实际环境、执行并验证获准的修改 |

**实际记录保存在 Markdown Notes 中。** AI 阅读 database 时，应根据 Base 的路径和筛选范围找到关联 Notes，递归读取 Library 中的相关文件；不能只读 `.base` 就认为已经获取全部插件资料。

标准视图包含 All Plugins、Must-Have、Third-party、Community、Non-community、Core 和 Uninstalled。`plugin_id` 未放在默认可见列中，但已经写入每条 Note；可在 Bases 的属性选择中将它显示出来。

### 哪些内容由谁维护？

| 维护方 | 内容 |
|---|---|
| 本插件自动维护 | `plugin_id`、`name`、`source`、`status`、`version`、`last_seen`、`settings` |
| 用户或 AI Agent 维护 | `tier`、`aliases`、`category`、`favorite`、`purpose`、正文及其他扩展属性 |

`status` 使用 `enabled`、`disabled`、`uninstalled`；Core 插件没有普通意义上的卸载，只有前两种状态。Core 没有独立版本时留空。`last_seen` 在 Base 中显示为 **Last Detected**，表示最后一次检测到插件的日期，不代表上次使用。禁用的社区插件仍可被检测；允许纳入 Core 时，启用和停用的 Core 功能均可被检测。

刷新时只更新自动字段。用户字段和正文保留，数据未变化时不改写文件；卸载社区插件只更新状态，重新安装时按插件身份复用旧记录。新建笔记时提供 `tier`、`aliases`、`category` 和 `purpose` 初值；它们由用户维护，删除后同步不会重建。插件必要的自动字段被删除时可能恢复。

### Source 与旧版清单

- **Built-in** 是内置功能。**Community** 表示插件 ID 在已核验的官方社区目录中。**Non-community** 表示目录未收录，或目前没有可用目录缓存。
- 手动刷新按缓存时效请求官方社区目录。失败时保留旧缓存。目录校验状态在设置页显示。
- 升级保留原 Library 和 Base 路径，旧格式笔记仍可识别。旧版有未完成操作时，在 **Legacy Recovery** 单独处理。
- **Advanced URI** 可用时，新建的 Base 提供 Settings 链接，刷新也会维护各插件笔记的 Settings 属性。选择新 Base 或执行重置时可重新生成对应公式。

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

在新 Vault 安装插件后，用 **Locate Plugin Library** 连接复制过来的笔记目录。用 **Set Plugin Index** 创建或接管 Base，再按需刷新插件状态。

## 移动清单、补齐和导入

- 在 Obsidian 文件列表改名或移动当前 Library、Base 或其父目录，插件会跟随路径。Library 移动后只更新 Base 中可确认的受管目录筛选。如果关闭 Obsidian 后才移动，用 **Locate Plugin Library** 重新定位。
- 删除部分笔记或整个 Library 后，使用 **Fill Missing Plugin Notes**。预览确认后，插件在当前配置的目录生成缺失记录。Base 即使缺失也可补齐。补建只使用当前插件信息和模板，手写内容需从原笔记导入。
- 用 **Import Plugin Notes** 从指定旧目录复制原笔记。相同身份默认保留当前文件；明确选择替换时，会先备份当前文件。
- **Set Plugin Index** 可以接管已有 `.base`。确认后先备份原文件，再写入标准索引。**Reset Plugin Index** 同样先预览和备份，仅处理 Base。Base 配置问题不会阻止笔记操作。
- 日常刷新只扫描当前 Library 内的笔记。重复身份会报告冲突。扫描插件不完整时，插件会提示原因并保留已有数据。插件不会扫描或导出其他插件的配置。

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

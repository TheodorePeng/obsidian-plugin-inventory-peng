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

Settings 界面的物理点击、URI 点击及跨 Vault 定位；真实启停其他插件后的 5 秒同步目标；弹窗批量处理；子文件夹/目录改名跟踪；独立窗口；中英文 IME 与并发编辑。没有为了测试而改动已有第三方插件。

## 明确延期

事务式设置路径迁移向导、迁移中断恢复、任意既有 Base 接管。阶段版拒绝覆盖未知 Base，拒绝将初始化后的路径直接切换成另一套位置；支持通过 Obsidian 文件列表移动现有清单，但尚未做完整移动矩阵验证。

## 数据与仓库

已安装目标插件并创建其自身设置与专用测试记录。没有向正式 Plugins 目录写入清单，没有修改其他插件配置或用户正文。独立 Git 仓库已初始化为 main。2026-11-11 补充：仓库已推送至 GitHub（`TheodorePeng/obsidian-plugin-inventory-peng`）并发布 `0.1.0` Release 供 BRAT 分发。

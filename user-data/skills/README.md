# 安装验收 Skill

此目录的每个一级子文件夹都是一套独立 Skill。应用会加载所有合格文件夹，不区分 PaletX、示例或第三方 Skill；不用的 Skill 可直接删除或移走。开源仓库只包含“示例规范”，不包含任何私有规范。

安装后的桌面应用默认从以下位置读取：

```text
文档/UXChecker-2/skills/<你的 Skill 文件夹>/
```

复制完成后，在应用中刷新 Skill 列表。每个 Skill 必须自包含，不应依赖仓库外的规范文件。

## 自动注册规则

- 文件夹根目录必须包含 `skill.json`、`SKILL.md` 和报告渲染器。
- `skill.json.groupName` 是下拉列表的分组名称；未填写时使用 `name`，再未填写时使用文件夹名。
- `standards/skins/index.json` 中的 `skins` 是该分组下面的皮肤选项。
- 每个皮肤的组件规范放在 `standards/component-packs-v3/skins/<skin-id>/components/`。
- 布局规范放在 `standards/layout/layout-audit-pack-v1.json`。
- 快速模式的动态分包由应用统一实现；Skill 仍只需提供上述独立组件文件，可选用 `skill.json.audit.fastMode` 声明输出预留和安全余量。

参考仓库内的“示例规范”即可制作自己的 Skill。完整的单组件文件协议、独立性要求和校验规则见 [`docs/SKILL-AUTHORING.md`](../../../docs/SKILL-AUTHORING.md)。

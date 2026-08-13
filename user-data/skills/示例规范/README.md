# Generic Web Audit 示例 Skill

应用通过两个文件自动注册 Skill：

1. 根目录 `skill.json`：声明 Skill 名称、入口、报告渲染器和可见皮肤。
2. `standards/skins/index.json`：声明皮肤下拉列表。

组件规范放在：

```text
standards/component-packs-v3/skins/<skin-id>/components/<component-id>.json
```

布局规范放在：

```text
standards/layout/layout-audit-pack-v1.json
```

复制本目录并修改 `id` 后，即可作为自定义 Skill 模板使用。每个组件文件必须独立、完整，不能引用其他规范文件。

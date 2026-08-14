# PixelClam 验收 Skill 制作规范

应用自动加载 `user-data/skills` 下每一个结构合格的 Skill 文件夹，不按品牌做特殊处理。删除或移走文件夹即不再加载。

## 目录协议

```text
我的规范/
├── skill.json
├── SKILL.md
├── scripts/render-interactive-report.mjs
├── assets/report-templates/interactive-html-report.template.html
└── standards/
    ├── layout/layout-audit-pack-v1.json
    ├── skins/index.json
    └── component-packs-v3/skins/
        ├── default/components/button.json
        └── dark/components/button.json
```

文件夹代表一套 Skill；`standards/skins/index.json` 中每个皮肤成为下拉项。同一个页面一次只验收一个皮肤。

`skill.json` 示例：

```json
{
  "id": "my-design-system",
  "name": "我的规范",
  "groupName": "我的规范",
  "version": "1.0.0",
  "description": "我的产品设计系统验收规范",
  "audit": {
    "fastMode": {
      "reservedOutputTokens": 6000
    }
  },
  "entry": "SKILL.md",
  "reportRenderer": "scripts/render-interactive-report.mjs"
}
```

`standards/skins/index.json` 示例：

```json
{ "skins": [{ "id": "default", "name": "默认浅色" }, { "id": "dark", "name": "深色" }] }
```

## 独立组件规范是最小执行单元

深度模式会用同一份 DOM 快照依次搭配 `button.json`、`input.json` 等单条规范请求 AI；快速模式会把这些完整文件按模型上下文容量动态装入多个批次。两种模式最后都在本地合并报告。因此每个 JSON 必须独立完整，禁止 `$ref`、import、外部链接，以及“参见公共规范”一类依赖。

最低可运行模板：

```json
{
  "kind": "independent-component-audit-pack",
  "version": "1.0.0",
  "selfContained": true,
  "skin": { "id": "default", "name": "默认浅色" },
  "component": { "id": "button", "name": "Button", "displayName": "按钮" },
  "detection": { "selectorAliases": ["button", "my-btn", "my-button"] },
  "scope": { "include": ["按钮和 role=button 的可点击操作"], "exclude": ["纯文本链接"] },
  "execution": {
    "oneComponentPerRequest": true,
    "skinIsolationRequired": true,
    "evidenceModes": ["image", "dom"],
    "instancePolicy": {
      "domNativeExemption": "如需免检某组件库的原生实例，在这里写出可从实例自身 DOM 验证的标签、类名和混合场景规则；不需要则删除本字段。",
      "imageModePolicy": "图片不能确认代码来源时，不应用 DOM 来源免检。"
    }
  },
  "rules": {
    "heightPx": 32,
    "borderRadiusPx": 4,
    "fontSizePx": 14,
    "backgroundColor": "#1677ff"
  },
  "comparisonPolicy": { "domTolerancePx": 1, "imageTolerancePx": 2, "maxIssuesPerInstance": 2 },
  "outputContract": {
    "locationFormat": "用户可理解的位置，代码位置（选择器或DOM路径）",
    "problemFormat": "当前XXX，应该XXX；当前XXX，应该XXX"
  }
}
```

文件必须命名为 `<component.id>.json`。验收前会校验：

- `selfContained` 必须为 `true`；
- `component.id` 必须存在并与文件名一致；
- 必须有 `component.displayName` 或 `component.name`；
- `skin.id` 必须与当前皮肤目录一致；
- `rules`、`componentStructure`、`skinStyle`、`sourceResolvedStyle` 至少存在一项。

建议填写 `detection.selectorAliases`，用于深度模式盘点页面是否出现该组件族，节省后续 AI 请求；它不参与样式合格判断。快速模式不执行组件盘点，会提交当前皮肤的全部组件规范。

## 快速模式的框架协议

动态分包由 PixelClam 通用执行框架负责，Skill 不需要提供脚本。程序计算：

```text
模型上下文窗口
- 完整 DOM、固定提示词和输出模板
- 预留输出 token
- 安全余量
= 当前批次可装入的完整组件规范
```

Skill 可在 `skill.json.audit.fastMode` 中覆盖少量建议值；未声明时使用模型配置：

```json
{
  "audit": {
    "fastMode": {
      "reservedOutputTokens": 6000,
      "safetyRatio": 0.15
    }
  }
}
```

通常不要在 Skill 中填写 `contextWindowTokens`，因为上下文容量属于模型或网关能力，应在本机 `model-config.json.fastMode` 中配置。只有该 Skill 明确要求更小的安全窗口时才覆盖它。

## 特殊策略必须逐文件写入

“原生组件免检、自研组件才检查”等规则必须写进每一个相关组件文件的 `execution.instancePolicy`。程序不内置 PaletX、Ant Design 或其他品牌规则。规则应说明实例自身的来源标记、祖先标记是否有效、混合或来源不明如何处理，以及图片模式无法确认代码来源时如何处理。

## 组件数量与选择

下拉框显示每个皮肤包含的组件规范数量：

- 深度模式先盘点页面实际出现的组件族，未出现的组件不进入样式验收。
- 快速模式不盘点，当前皮肤全部规范都会进入某个动态批次。

暂不提供组件复选框。组件命名由 Skill 作者定义，让普通用户手动排除容易漏检；调试时可临时移走某个组件 JSON。

## 发布前检查

1. 每个皮肤独立保存完整组件文件，不能跨皮肤引用。
2. 用含已知错误的小页面分别测试图片和 DOM 模式。
3. 确认报告能命中预植入错误，而不只是成功生成空报告。
4. 不把 API Key 写进 Skill。
5. 私有 Skill 通过 `.gitignore` 排除；开源仓库仅保留示例 Skill。

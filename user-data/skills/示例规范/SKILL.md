---
name: 示例规范
description: 使用通用 Web 基线检查页面布局与基础组件的演示 Skill。
version: "1.0.0"
---

# 通用 Web 示例验收

这是 UXChecker-2 的公开示例 Skill，用于验证安装、模型配置、DOM/图片证据和报告链路。

- 每次只使用当前组件对应的独立 JSON 规范。
- 只检查页面中实际出现的组件，不因组件缺失扣分。
- DOM 模式优先读取 computed style 与 bbox；图片模式不编造精确像素。
- 本规范是中性的示例基线，不代表 Apple、Google、Ant Design 或其他品牌规范。

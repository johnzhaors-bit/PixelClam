# PixelClam · 花甲

> AI UX Review & Visual QA

PixelClam 是一款可扩展的桌面端 UI 还原度验收工具。它把页面截图或登录后的运行态 DOM 快照，与当前设计系统的一份单组件规范交给兼容 Kimi/OpenAI Chat Completions 的模型分析，最后合并为可追溯的验收报告。

## 为什么叫 PixelClam

“花甲”轻巧、亲切，也有逐粒筛查的联想：PixelClam 会逐项检查像素、间距、对齐、状态和组件样式，同时把判断证据留在本地。

## 核心能力

- 图片模式：截图 + 单组件规范 + 固定输出模板。
- DOM 模式：登录后的运行态 DOM + computed style + bbox + 单组件规范。
- 多皮肤隔离：一次只加载所选皮肤的一套规范，不混用不同皮肤参数。
- 单组件轮询：同一份页面证据按组件规范逐轮复用，最后确定性合并报告。
- Skill 扩展：扫描本地 Skill 目录，自动注册规范分组、皮肤和组件。
- 来源策略下沉：是否免检某组件库的原生实例，由每份组件规范自行声明。
- 本地留档：保留冻结快照、请求清单、模型原始回复和结构化报告。

## 工作方式

```text
截图 ───────────────┐
                    ├─ 当前皮肤 / 单组件规范 ─ AI 验收 ─ 单组件结果 ┐
运行态 DOM 冻结快照 ┘                                              ├─ 总报告
                    └─ 页面布局规范 ──────── AI 验收 ─ 布局结果 ───┘
```

DOM 模式不会要求模型重新登录。PixelClam 在应用内浏览器保留登录状态，并冻结当前页面的可见 DOM、表单状态、computed style 和元素位置。

## 快速开始

要求 Node.js 20+。

```bash
npm install
npm start
```

首次运行后：

1. 打开“模型设置”，填写兼容 Chat Completions 的 Base URL、模型名和 API Key。
2. 将完整 Skill 文件夹放入应用打开的 Skill 目录。
3. 选择验收皮肤。
4. 输入页面地址进入 DOM 模式，或上传截图进入图片模式。
5. 等待各组件轮次完成并查看报告。

模型配置只保存在本机用户目录，不应提交到 Git。

## Skill

仓库包含一份无品牌的示例 Skill。应用会加载 Skill 目录下所有结构合格的一级文件夹；不用的 Skill 直接移走即可。

每个组件 JSON 都必须自包含，因为模型实际收到的是：

```text
页面证据 + 当前皮肤的一份组件规范 + 输出模板
```

禁止使用 `$ref`、外部 import 或“参见公共规范”。完整制作协议见 [Skill 制作规范](docs/SKILL-AUTHORING.md)。

## 模型配置

默认配置示例位于 `config/model-config.example.json`：

```json
{
  "enabled": true,
  "provider": "openai-compatible",
  "baseUrl": "https://api.moonshot.cn/v1",
  "model": "kimi-k3",
  "apiKey": "",
  "timeoutMs": 300000
}
```

也可在应用中打开本地配置文件夹直接修改 JSON。不要将真实 API Key 写入仓库、Issue 或日志。

## 开发与测试

```bash
npm test
npm run bootstrap:refresh
```

双轨构建：

```bash
npm run dist:release:all
```

- `release-artifacts/public/`：公开包，不含 Key 和私有 Skill，可以上传 GitHub。
- `release-artifacts/internal/`：内部包，包含本机模型配置与本机私有 Skill，只能用于企业内部发布。

也可以只构建其中一种：

```bash
npm run dist:release:public
npm run dist:release:internal
```

正式发布前必须阅读并执行 [打包与发布说明](docs/PACKAGING.md)，其中包含防止 Key、私有 Skill 和运行证据进入安装包的自动检查。

计划中的“完整 DOM + 全量规范动态分包”方案见 [快速验收模式设计](docs/FAST_MODE_DESIGN.md)。

## 隐私与安全

- DOM 快照和报告默认保存在本机，并可能包含测试页面中的业务文字。
- 运行验收会把当前页面证据与当前单组件规范发送给配置的模型服务。
- 请勿对未获授权的生产数据执行验收。
- `user-data/config`、私有 Skills、runs、reports 和构建产物默认被 `.gitignore` 排除。

## 当前状态

PixelClam 仍处于早期版本。复杂超长页面的安全分段、更多模型适配和组合组件布局验收仍在持续完善。

欢迎提交 Issue、改进示例 Skill 或补充不同页面类型的受控测试案例。

## License

[MIT](LICENSE)

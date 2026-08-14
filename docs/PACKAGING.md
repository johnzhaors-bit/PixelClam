# PixelClam 打包与发布说明

本文档用于防止公开安装包误带 API Key、公司私有 Skill、页面 DOM、报告或调试产物。

## 发布内容边界

公开安装包只能包含：

- Electron 应用代码：`electron/`、`src/`；
- 空 Key 的 `config/model-config.example.json`；
- `.build-test-assets` 中生成的公开示例 Skill；
- 运行依赖和 `package.json`。

禁止包含：

- `user-data/skills/Paletx-MultiSkin-Audit` 及任何公司规范；
- `user-data/.disabled-skills`；
- `user-data/config/model-config*.json` 中的真实 Key；
- `user-data/runs`、`user-data/reports`、`runs`、`reports`；
- `dist` 旧产物、`交付文件` 和本地 `.env`；
- 内网页面、登录信息及真实业务 DOM。

## 双轨发布目录

所有新包统一输出到互相隔离的目录：

- `release-artifacts/public/v版本号/`：公开包；无 Key、无 PaletX，只含示例 Skill，可以上传 GitHub。
- `release-artifacts/internal/v版本号/`：内部包；包含本机 Key 和 PaletX Skill，只能保存在本地或上传企业内部网站。

两个目录均生成 Windows x64 Portable、macOS arm64 ZIP、Linux x64 AppImage 和 `SHA256SUMS.txt`。每个目录还包含 `RELEASE-VARIANT.json`，明确标识是否允许公开上传。

## 标准发布流程

```bash
npm ci
npm test
npm run release:check
npm run dist:release:all
```

也可以单独构建：

```bash
npm run dist:release:public
npm run dist:release:internal
```

`dist:release:all` 先生成内部包，最后重新生成公开引导资源并构建公开包，确保工作区最终停留在安全的公开状态。

`release:check` 会重新生成公开引导资源并检查：

1. 产品名、包名和应用 ID；
2. 示例配置的 API Key 为空；
3. Electron 打包采用明确白名单并排除 `user-data`、tests 和 docs；
4. 引导资源只包含示例 Skill；
5. 不出现常见 Key 格式、内网网关和私有路径；
6. Git 已跟踪文件不包含私有规范与运行证据。

任何一项失败都不得发布。

## 平台产物

- Windows x64：Portable `.exe`；需要时另行构建 NSIS 安装版。
- macOS arm64：`.zip`。
- Linux x64：`.AppImage`。
- `SHA256SUMS.txt`：所有发布文件的 SHA-256。

## 安装包内部复核

构建脚本会自动检查三个平台解包目录中的 `bundle-manifest.json`、模型配置和 Skill。仍可手工复核：

```bash
npx asar list release-artifacts/public/v0.2.0/mac-arm64/PixelClam.app/Contents/Resources/app.asar
find release-artifacts -maxdepth 3 -type f -print
```

确认应用资源中没有 `user-data/runs`、`reports`、私有 Skill 名称和模型配置。发布者还应对解包后的文本再次运行凭据扫描。

## GitHub Release

Preview 版本建议使用类似 `v0.2.0-preview.1` 的标签，并说明：

- 这是早期预览版；
- 用户需要自行配置兼容模型服务；
- 公开包只包含示例 Skill；
- macOS 与 Windows 当前未签名，系统可能显示安全警告；
- DOM 或截图会发送到用户配置的模型服务。

安装包只上传到 GitHub Releases，不提交到 Git 历史。

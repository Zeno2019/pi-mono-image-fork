# 0.1.15 固定版本 fork

本 fork 从上游 `pi-codex-image-gen@0.1.15` tag 创建，未合入后续 main 或升级 Pi SDK。

- 上游仓库：<https://github.com/jvm/pi-mono>
- 目标目录：`packages/pi-codex-image-gen`
- 上游 tag / npm `gitHead`：`8dcf8a03e86ae5f20a89a2d5983a5fd0258bd6d6`
- 上游 npm tarball：<https://registry.npmjs.org/pi-codex-image-gen/-/pi-codex-image-gen-0.1.15.tgz>
- 上游 npm integrity：`sha512-NTISK58pZCM42txUroaQUF2oR/xxRGxzO7FrU+ymc+OWY6XDplFBc/pxVkSRvOZpr2QKCc7axwbU8owK6dZxuw==`
- 来源核验：原始 tarball 的 SHA-512 符合 npm 元数据，25 个发布文件与该 commit 逐字一致。
- fork 归属：`Zeno2019/pi-mono-image-fork`；源码分支 `fork/pi-codex-image-gen-0.1.15-host`，包根目录分发分支 `package/pi-codex-image-gen-0.1.15-host`。
- 行为基线：应用原 `pi-codex-image-gen@0.1.15.patch`，SHA-256 为 `b046ff5afd4cda6213f4027070df0b3ba7ce54d684cced4cf24f2a5c5957f0c8`。

包版本保留上游 `0.1.15`，`x-fork` 标识宿主接口修订 1。消费端使用固定的 Git 分发 commit，或 **fork commit + tarball + lockfile integrity** 区分和固定 fork；仅写 `pi-codex-image-gen: 0.1.15` 不能安装本 fork。

## Git 安装与宿主装配

分发分支通过 `git subtree split --prefix=packages/pi-codex-image-gen` 从源码分支生成，将本目录原样放到仓库根目录，不包含其它工作区。Git tag `image-gen-0.1.15-host.1` 指向首次分发 commit；已交付的 tag 不移动。来源历史保留在源码分支和本文件中，无需发布 npm。

Pi CLI 可使用以下 Git 源安装；应用交付应进一步记录 tag 对应的完整分发 commit，并用该 commit 固定依赖：

```sh
pi install git:github.com/Zeno2019/pi-mono-image-fork@image-gen-0.1.15-host.1
```

嵌入式 Pi 0.87.1 可通过同一 SDK 的 `DefaultPackageManager.install(source)` 安装，再用 `getInstalledPath(source, "user")` 获取包根目录。包管理器的 `agentDir`、工作目录和 settings 必须由应用隔离管理；安装不得操作用户全局 Pi 的配置或认证。宿主提供既有 Pi peers，Git 依赖安装应禁用自动安装 peers、开发依赖和生命周期脚本，例如为专用 settings 配置 `npmCommand: ["npm", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts"]`。

Git 安装负责取得包，不会自动完成应用宿主绑定。消费端继续加载自己的应用扩展，通过 Pi 扩展加载器导入包的 `extensions/host.ts`（包 export 为 `./host`），由应用注册工具、OAuth provider 并传入可信宿主。默认 `pi.extensions` 指向上游 CLI 扩展，嵌入式消费端应显式选择自己的应用扩展；受控宿主行为以 `./host` 为准。

## 本地修改边界

- `extensions/index.ts`：导出原认证与请求 helper；添加 strict OAuth 选项、注入 fetch 和重试次数选项。默认 CLI 入口沿用上游行为。
- `extensions/host.ts`：新增 `HostedImageHost<Result>` 和 `createHostedImageGenerator`，只接受受控图片字节并返回通用持久化回执；复用上游 OAuth、请求构造、SSE 解析、deadline 与 decoder。
- `package.json`：增加 `./host` export、fork 来源标识和 `FORK.md` 打包条目，依赖及 peers 保持原样。
- `tests/host.test.mjs`：覆盖严格图片 OAuth、非法参数/图片预算、单次 HTTP、授权门禁、取消后的持久化、错误脱敏和零额外网络请求。
- README、CHANGELOG、SECURITY、NOTICE 和包级 AGENTS 记录 fork 接口与边界。上游 Apache-2.0、NOTICE 及 OpenAI 衍生文件归属完整保留。

工具注册、宿主绑定、产品文案、图库状态及产品原图存储均由消费端负责；通用接口不包含 Yima 工具或图库协议。宿主入口不读取项目/全局图片配置，不接收路径参数，不调用 install telemetry，不回退 legacy OAuth，每次调用最多一次图片 HTTP。

`authenticate` 与 `fetch` 的可选注入只供可信宿主/隔离测试装配，不能暴露给模型、renderer、CLI 参数或环境变量。收到成功图片后，即使随后取消也等待 `persist`；存储失败不会重新生成。

## 验证与打包

本次针对消费端已固定的 `@earendil-works/pi-ai` / `pi-coding-agent` **0.87.1**、`typebox` **1.3.27** 验证；未重解 monorepo 的其它工作区依赖。使用这些已安装 peers 和 TypeScript 工具运行：

```sh
npm run -w packages/pi-codex-image-gen check
npm test -w packages/pi-codex-image-gen
npm run validate:packages
npm run -w packages/pi-codex-image-gen pack:dry-run
npm pack -w packages/pi-codex-image-gen --ignore-scripts --pack-destination /tmp
```

OAuth 回归仅使用合成凭据、注入的 token HTTP 与 loopback callback；没有真实登录或收费生图。应用侧另验证真实 Pi ResourceLoader / JSONL 和独立 profile 的 Electron utility 故障链路。不要将仅包含当前包的验证表述为整个 monorepo 的全部工作区通过。

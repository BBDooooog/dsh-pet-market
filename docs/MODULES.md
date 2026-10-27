# 模块划分

本文定义市场插件的内部结构、模块边界、端口接口、Host API、SSE 事件、服务面，以及与宠物宿主（PetHost）的交接契约。格式细节看 [PACK-FORMAT.md](PACK-FORMAT.md)，GitHub 解析细节看 [SOURCES.md](SOURCES.md)。

市场只依赖本文第 8 节的 PetHost 契约，不依赖任何具体宿主实现的内部结构。宿主可以是 DSH 里的一个插件，也可以是别的运行环境；换宿主只换适配层。

## 1. 三条依赖规则

1. `core/*` 只依赖端口接口类型，不 import 任何 DSH API、不直接读文件、不直接发网络请求。core 可在纯 Node 环境里用假实现跑测试。
2. `host/*` 是唯一接触 DSH（`ctx.fs`、`ctx.storageDomain`、`webServer`、`ctx.get('pethost')`）和操作系统的层。它把 DSH 能力实现成端口，把 core 编排成 HTTP。
3. `client/*` 只走 `/petmarket/api/*` 与 SSE，不 import 宿主半的代码，不直接访问 `github.com`，渲染素材只经 `/petmarket/api/packs/...` 或 `/petmarket/api/preview/...`。

```
client/*  ──HTTP/SSE──▶  host/router ──▶ host/service ──▶ core/jobs
                                              │                │
                                              ▼                ▼
                                          core/catalog    core/installer
                                                               │
                    ┌──────────────┬──────────────┬────────────┴───────────┐
                    ▼              ▼              ▼                        ▼
              core/resolver  core/fetcher   core/verifier          core/validator
                    │              │              │                        │
                    ▼              ▼              ▼                        ▼
              host/github-port host/http-port host/fs-port        core/ledger
                                                                          │
                                                                          ▼
                                                                  host/host-bridge
```

依赖无环：`installer` 依赖 `resolver/fetcher/verifier/validator/ledger`，反向没有边。`catalog` 只依赖 `resolver` 与缓存端口。

## 2. 模块总表

| 模块 | 职责 | 输入 | 输出 | 依赖 | 不做 |
| --- | --- | --- | --- | --- | --- |
| `core/source` | 归一化用户来源：URL、`OWNER/REPO`、release 链接、目录条目 | 原始字符串、配置 | `SourceRef` | 无 | 不发网络请求 |
| `core/resolver` | 把 `SourceRef` 解析成候选 release/资产，选择资产，取 `pet.json` 元数据 | `SourceRef`、频道 | `ResolvedCandidate[]` | `GithubPort`、`HttpPort`、缓存 | 不下载整包 |
| `core/fetcher` | 流式下载资产、限速、限大小、算 `sha256` | 资产 URL、大小上限 | 字节流 + `sha256` | `HttpPort` | 不解析格式 |
| `core/verifier` | 校验 `digest` 与 `checksums.json` | 期望哈希、文件 | 校验结论 | `FsPort` | 不判断语义 |
| `core/validator` | zip 边界、路径、扩展名、`pet.json` schema、`profile`、图集几何、预算 | 解包目录 | `PackValidation` | `FsPort` | 不安装、不注册 |
| `core/installer` | 编排安装/更新/回滚事务：暂存 → 原子提交 → 注册 → 激活；失败回滚 | 候选、目标版本 | `JobResult` | 上述全部 + `StorePort`、`HostPort` | 不对外暴露 HTTP |
| `core/ledger` | 已安装记录、版本保留、状态迁移、安装锁 | 记录变更 | `LedgerView[]` | `StorePort`、`FsPort` | 不决定 UI 文案 |
| `core/jobs` | 作业队列（串行）、状态机、进度聚合、取消、幂等 | 请求 | `JobView` | `ClockPort`、`EventPort` | 不直接干活 |
| `core/catalog` | 合并多源条目、去重、筛选、排序、分页；读缓存目录 | 源列表 | `CatalogPage` | `resolver`、缓存 | 不下载包 |
| `core/preview` | 为候选生成临时预览 token 与素材访问前缀 | 候选 | `previewId`、路径映射 | `FsPort` | 不渲染 |
| `host/github-port` | GitHub REST 调用、ETag、限流头、条件请求 | 端口调用 | 端口结果 | `fetch` | 不做资产选择策略 |
| `host/http-port` | 通用流式下载、域名白名单、重定向、超时、字节上限 | URL | 流 | `fetch` | 不解析包 |
| `host/fs-port` | 数据目录读写、原子 rename、路径沙箱 | 路径 | 字节 | `ctx.fs` | 不写业务判断 |
| `host/store-port` | `ledger.json` / `config.json` 持久化，降级到 `storageDomain` | 表名、值 | 值 | `ctx.fs`、`ctx.storageDomain` | 不管理包目录 |
| `host/host-bridge` | 把已解包目录交给 PetHost 注册并激活 | `LedgerRecord` | 注册结果 | `ctx.get('pethost')` | 不改包内容 |
| `host/router` | 路由前缀、同源校验、信封、SSE、静态素材 | HTTP 请求 | JSON/流 | `host/service` | 不含业务规则 |
| `host/service` | 对内部调用聚合成用例（安装/卸载/更新/目录） | 请求 DTO | 用例结果 | `core/*` | 不碰 HTTP 细节 |
| `host/scheduler` | 启动后延迟检查更新、周期检查、关停清理 | 配置 | 定时器 | `core/catalog` | 不自动安装 |
| `client/panel` | 市场主界面：目录、来源、已安装、任务 | 用户操作 | HTTP 调用 | `client/api` | 不含校验逻辑 |
| `client/source-editor` | 粘贴 GitHub 链接、显示解析候选、频道与 pin | 输入 | 解析请求 | `client/api` | 不解析 URL |
| `client/installed-list` | 已安装列表、启用/禁用/卸载/回滚、版本切换 | 记录 | 命令 | `client/api` | 不判断引擎兼容 |
| `client/progress` | SSE 订阅、阶段与百分比、失败原因 | SSE | UI 状态 | `client/api` | 不重试下载 |
| `client/preview` | 用 `pets:renderers` 播 `idle` 预览，不安装 | `previewId` | DOM | `pets:renderers` | 不写盘 |
| `client/i18n` | `zh`/`en` 文案，跟随 `locale` 服务 | locale | 字符串 | `locale` 服务 | — |

## 3. 端口接口

```ts
// 标识
type SourceRef = { kind: 'github'; owner: string; repo: string; tag?: string; asset?: string; channel: 'stable' | 'prerelease' };

interface GithubPort {
  repo(ref: { owner: string; repo: string }): Promise<{ defaultBranch: string; stars: number; archived: boolean }>;
  latestRelease(ref: { owner: string; repo: string }, opts: { includePrerelease: boolean }): Promise<ReleaseInfo | null>;
  releaseByTag(ref: { owner: string; repo: string }, tag: string): Promise<ReleaseInfo | null>;
  recentReleases(ref: { owner: string; repo: string }, limit: number): Promise<ReleaseInfo[]>;
  rateLimit(): Promise<{ remaining: number; resetAt: number; limit: number } | null>;
}

type ReleaseInfo = {
  tag: string; name: string; publishedAt: string; prerelease: boolean; draft: boolean;
  assets: AssetInfo[];
};
type AssetInfo = {
  name: string; size: number; digest: string | null;  // "sha256:…" 或 null
  url: string; contentType: string; downloadCount: number;
};

interface HttpPort {
  download(url: string, sink: (chunk: Uint8Array) => Promise<void> | void,
           opts: { maxBytes: number; timeoutMs: number; hosts: string[]; accept?: string }):
    Promise<{ sha256: string; bytes: number; finalUrl: string; status: number }>;
  getJson(url: string, opts: { etag?: string | null; maxBytes: number; timeoutMs: number }):
    Promise<{ status: number; etag: string | null; body: unknown } | { status: 304 }>;
}

interface FsPort {
  ensureDir(p: string): Promise<void>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  readFile(p: string): Promise<Uint8Array>;
  readText(p: string): Promise<string>;
  list(p: string): Promise<{ name: string; size: number; isDir: boolean }[]>;
  move(from: string, to: string): Promise<void>;     // 同卷 rename，原子
  remove(p: string): Promise<void>;
  stat(p: string): Promise<{ size: number; mtimeMs: number } | null>;
  hashFile(p: string): Promise<string>;
  resolveInRoot(rel: string): string;                 // 抛 path-traversal 型错误
}

interface StorePort {
  load<T>(table: 'config' | 'ledger', schema: unknown): Promise<T | null>;
  save(table: 'config' | 'ledger', value: unknown): Promise<void>;
  health(): { mode: 'fs' | 'domain' | 'degraded'; root: string; detail?: string };
}

interface HostPort {
  available(): boolean;
  contractVersion(): string | null;                    // \`petRuntime\` 语义版本，如 "1.2.0"
  list(): string[];                                   // 已注册 packId
  activeId(): string | null;
  register(input: { packId: string; version: string; manifest: unknown;
                    files: Record<string, string | { buffer: Uint8Array; type?: string }>;
                    source: string }): void;
  activate(packId: string): Promise<void>;
  deactivate(packId: string): Promise<void>;
  unregister(packId: string): boolean;
  assetUrl(packId: string, path: string): string;     // 宿主可直出的素材 URL，缺失返回 ''
}

interface ClockPort { now(): number; after(ms: number, fn: () => void): () => void }
interface EventPort { emit(e: MarketEvent): void }
```

`HostPort.register` 的 `source` 传 `market:<sourceRef>@<version>`，宿主侧可用它区分来源。`files` 由 `host/host-bridge` 把包目录读成 `路径 → 字节` 映射；包预算 80 MB 上限保证这一步的内存峰值可控。若宿主支持目录直读（`assetUrl` 非空），bridge 可只传 `pet.json` 与图集入口，其余按需读取。

## 4. Host API

统一前缀 `/petmarket/api`。响应信封：成功 `{ "ok": true, "value": … }`，失败 `{ "ok": false, "error": { "code": "...", "message": "...", "details": {…} } }`，HTTP 状态码与错误码一一对应。所有 `POST` 走 `requestTrusted` 同源校验，失败 `cross-origin`。请求体上限 256 KB，超限 `body-too-large`；JSON 解析失败 `bad-json`。

| 方法 | 路径 | 请求 | 响应 | 主要错误 |
| --- | --- | --- | --- | --- |
| GET | `/health` | — | `{ plugin, version, host, storage, jobs, github }` | `storage-degraded` |
| GET | `/catalog` | `?q&tag&sort&cursor&limit&sourceId` | `{ items, nextCursor, total }` | `offline-no-cache` |
| GET | `/sources` | — | `SourceView[]` | — |
| POST | `/sources` | `{ input, channel?, label? }` | `SourceView` + 首次解析结果 | `source-invalid`、`source-duplicate`、`github-rate-limited` |
| DELETE | `/sources/:sourceId` | — | `{ removed: true }` | `not-found` |
| POST | `/resolve` | `{ input, channel? }` | `{ candidates: Candidate[], previewId? }` | `github-not-found`、`release-not-found`、`asset-not-found`、`github-rate-limited` |
| POST | `/install` | `{ sourceRef, version?, assetName?, pin?, previewId? }` | `202 { jobId }` | `job` 类、`version-invalid`、`downgrade-blocked`、`pack-id-conflict` |
| GET | `/jobs` | `?state` | `JobView[]` | — |
| GET | `/jobs/:jobId` | — | `JobView` | `job-not-found` |
| POST | `/jobs/:jobId/cancel` | — | `JobView` | `job-not-found`、`invalid-params` |
| GET | `/installed` | — | `InstalledView[]` | — |
| POST | `/installed/:packId/activate` | `{ version? }` | `InstalledView` | `pack-not-found`、`runtime-unavailable`、`runtime-rejected` |
| POST | `/installed/:packId/disable` | — | `InstalledView` | `pack-not-found` |
| POST | `/installed/:packId/uninstall` | `{ purge?: boolean }` | `{ removed: true, pendingRestart?: boolean }` | `pack-not-found` |

| POST | `/updates/check` | `{ packIds? }` | `UpdateView[]` | `github-rate-limited`、`offline-no-cache` |
| GET | `/packs/:packId/:version/:path` | — | 素材字节 | `not-found`、`path-traversal` |
| GET | `/preview/:previewId/:path` | — | 素材字节（临时） | `not-found`、`pack-not-found` |
| GET | `/stream` | — | `text/event-stream` | `cross-origin` |

素材响应头：`Content-Type` 仅 `image/png`、`image/webp`、`application/json`、`text/plain`、`image/svg+xml`（SVG 仅 `<img>` 用途）；`X-Content-Type-Options: nosniff`；`Cache-Control: public, max-age=31536000, immutable`（路径含版本，天然不可变）。路径先过 `resolveInRoot`，任何 `..`、盘符、NUL 命中 `path-traversal`。

### 4.1 实现现状（v0.1.0）

上面是设计表；`lib/router.js` 里已经跑起来的是下面这一份。差异集中在「面板需要的少数便捷端点」和「预览暂存」两处。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `health` | `{ plugin, version, storageMode, degraded, dataRoot, runtime, installed, jobs, ui, desktop, at }` |
| GET | `installed` | `{ installed, runtime }` |
| GET | `catalog` | `{ sources, installed, ui, runtime, desktop, storage }`，面板一次拉齐 |
| GET | `sources` | `{ sources }` |
| POST | `sources` | `{ source, label? }` → `{ source }` |
| DELETE | `sources/:sourceId` | `{ sources }`（删除后的全集） |
| POST | `resolve` | `{ source }` → `{ candidate }`，不落盘 |
| POST | `install` | `{ source }` → `{ job }` |
| POST | `import?filename=` | 请求体是包字节（上限 25 MB） |
| POST | `import/local` | `{ path }`，本地目录或文件 |
| GET | `jobs`、`jobs/:jobId` | `{ jobs }` / `JobView` |
| POST | `jobs/:jobId/cancel` | `JobView` |
| POST | `updates/check` | `{ updates }`（GitHub 源才需要联网） |
| POST | `installed/:petId/activate|disable|uninstall` | 生命周期，返回该宠物的台账记录（v0.2 起不再有 rollback：同时只留一个版本，没有可回滚的对象） |
| POST | `installed/:petId/state` | `{ x?, y?, scale?, name?, nameFont?, nameColor?, nameFamily? }`，位置 / 缩放 / 别名 / 名字样式持久化；缩放 clamp 1–8，`name` trim 到 40 字、空串删除别名，`nameFont` 8–72 取整，`nameColor` 只收 `#rrggbb`（非法忽略），三者合并进 `ui.nameStyles[petId] = { size, color, family }` |
| POST | `installed/:petId/verify` | 重算包内 sha256 与 `checksums.json` 比对 |
| POST | `active` | `{ petId }`，切换桌面显示哪只 |
| GET | `packs/:petId/:version/<path>` | 素材字节 |
| GET | `stream` | SSE |

还没做的：`preview/:previewId/:path`（预览暂存目录）、`catalog` 的搜索/分页参数。两者都在 M2 里，不挡安装主链路。

### 4.2 系统桌面舞台（v0.1.0 已实现）

宠物不是只能在 DSH 页面里跑。插件在宿主可用时优先建 Electron 透明窗口；本机 DSH Desktop 的插件宿主以 `ELECTRON_RUN_AS_NODE=1` 运行（拿不到 `BrowserWindow`），因此主力实现是 **WPF 画家进程**：`lib/desktop-stage-wpf.js` 生成 `<root>/stage/state.json`，用 `powershell.exe -STA` 起 `stage/desktop-pet.ps1`，由它给每只宠物开一个透明置顶窗口画序列帧。

| 项 | 值 |
| --- | --- |
| 入口 | `createWpfStage({ store, router, logger, config, pluginRoot, getPort })`，`apply()` 里先试 `createDesktopStage()`（Electron），不可用再回落 WPF，`ctx.effect` 清理时 `dispose()` 杀画家进程 |
| 触发条件 | Electron 分支要求 `process.versions.electron` 且 `process.type` 不是 `renderer`/`worker`；WPF 分支要求 Windows 与 `powershell.exe` 存在，`config.desktop === false` 时整体关闭 |
| 画家进程 | `powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$sb=[scriptblock]::Create([IO.File]::ReadAllText('<script>')); & $sb -State … -Port … -Token … -Owner <pid>"`，`windowsHide:true`，stdout 丢弃、stderr 追加到 `<root>/stage/stage.err.log` |
| 窗口 | 每宠一个 `Window{WindowStyle=None, AllowsTransparency=$true, Background=Transparent, Topmost=$true, ShowInTaskbar=$false, ShowActivated=$false}`，内容是 `StackPanel{TextBlock(名字) + Image(序列帧)}`，鼠标样式 `Hand`；窗口高度 = 精灵高 + 一行名字（`ceil(nameFont*1.35)`，无名字时 0），窗口 `Top = 精灵 y - 名字高`，所以 `pos.y` 始终是精灵顶边 |
| 页面 | Electron 分支用 `stage/stage.html` + `stage/stage.js` + `stage/preload.cjs`；WPF 分支不用页面，直接 `Image` + `CroppedBitmap` |
| 数据 | `store.list()` + `ui.json`（`{ positions, names, nameStyles, active }`）→ `buildWpfState()` → `<root>/stage/state.json`（绝对 `image` 路径、`frame/sheet/animations/states`、`pos{x,y,scale,facing}`、`front`（`renderer.front === 'left' ? 'left' : 'right'`）、`name` 取 `ui.names` 别名优先、`nameFont` 取 `ui.nameStyles[id].size` → `ui.nameFonts[id]` → `frameH*scale*0.14`、`nameColor`/`nameFamily` 取 `ui.nameStyles[id]`、`menus` 原样透传给画家的右键菜单；`defaultScale()`：帧宽 ≤32 → 5x、≤64 → 4x、≤128 → 2x、否则 1x）；画家每 500 ms 读一次，内容不变则跳过；缩放时按底边中点重算左上角并回写 `/stage/position` |
| 帧推进 | `x=margin+col*(frame.w+spacing)`、`y=margin+row*(frame.h+spacing)` 取 `CroppedBitmap`；`1000/fps` 累加、`loop` 生效、`loop:false` 播完回落 `idle`；`NearestNeighbor` 缩放。帧缓存按 `pose#index` 存 `$pet.frames`（每帧只建一次），帧定时器 33 ms，滑过 6–14 fps 的动画 |
| 互动 | 左键拖动（`CaptureMouse` + 屏幕坐标：`$pet.dragStart = [Cursor]::Position`，位移除以 DPI 缩放后加到 `Left/Top`，松手 `POST /petmarket/api/stage/position`，`y` 回写时加上名字高度）、单击 = 朝一侧冲刺 140–230 px（`dash` 状态 260 dip/s，`POST /stage/click` 记一次点击）后回 `idle`、右键弹固定菜单「回窝睡觉」（`POST /stage/click {action:'sleep'}` → 宿主 `installer().disable()`）+「动作」子菜单（列出 `animations` 里除 `idle` 之外的动作，为空则不出现该项）、空闲 6–14 s 随机走并在 `WorkArea` 边缘转向；朝向按 `front` 决定是否 `scaleX(-1)`（原生朝左的猫向右走才翻）；窗口创建后立刻 `POST /stage/position` 认领落位坐标，避免下一次 payload 重新排 `slot` 把别的宠物挤走；三个鼠标回调、右键回调与外层 tick 全部 try/catch；菜单项处理器**不使用闭包**（闭包会切到新模块作用域，`Post-StageJson`/`Set-Pose`/`Write-StageLog` 全部解析不到，第一次点击就抛 `CommandNotFoundException` 把画家打死），每项数据放 `Tag`；另挂 `Dispatcher.Add_UnhandledException` 兜底（记录后 `Handled = $true`），任何 UI 回调抛错都不会带走画家进程 |
| 鉴权 | 画家进程没有浏览器 origin，不能用 `requestTrusted`；改用 `<root>/stage/token`（32 字节 hex，权限 0600）比对请求头 `x-petmarket-stage` |
| 写状态 | 直接 `writeFileSync(state.json)`，不做 rename：Windows 上画家每 500 ms 读该文件，rename 覆盖会拿到 `EPERM`；读到半截 JSON 时画家沿用上一帧。写失败时 250 ms 后重试一次，`desktop.reason` 回落为 `state-write-failed` |
| 层级 | 画家每 500 ms 用 `SetWindowPos(hwnd, HWND_TOPMOST, …, SWP_NOACTIVATE)` 重新声明置顶，避免被其它同为置顶的聊天/播放器窗口盖住 |
| 生命周期 | 画家写 `<root>/stage/stage.pid`（`{pid, owner}`）；宿主启动时 `cleanupStale()` 只杀「owner 已不在」的旧画家（`process.kill(pid,0)` 探活），并用 `<root>/stage/stage.lock`（`FileShare.None`）保证同一数据根只有一个画家，抢不到锁的进程写 `stage skipped …: another painter holds the lock` 后 exit 0；画家每 10 s 检查 owner 进程，宿主没了就退出；画家意外退出时宿主按 `min(30s, 1.5s × attempts)` 重启，存活超过 10 s 才重置计数 |
| 生效检查 | `GET /petmarket/api/health` 与 `/catalog` 的 `desktop` 字段：`{ available, engine: 'electron'|'wpf', reason, pid, pets, attachedAt }`；`reason` 取值 `running`/`exited`/`spawn-failed`/`state-write-failed`/`port-unavailable`/`script-missing`/`powershell-missing`/`platform-unsupported`/`disabled`/`disposed` |
| 关闭开关 | `config.desktop === false`；`config.displayIndex` 目前只用于 Electron 分支 |
| 装完是否出场 | `config.activateOnInstall` 默认 `false`：`install` 只登记 `active=false` 的素材，桌面画家不建窗口，用户点「出来玩」才 `activate`。设为 `true` 恢复「装完即出场」 |

沙箱约束：画家进程跑在系统 PowerShell 里，用绝对路径读图集；它只能通过 HTTP（带 token）回报位置，不碰 ledger。

## 5. SSE

`GET /petmarket/api/stream`，开启后立即推 `hello`，心跳 15 秒一次（注释行），断线由客户端退避重连。

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `hello` | `{ serverId, time, jobs: JobView[], installedCount }` | 连接建立 |
| `job.progress` | `{ jobId, state, phase, pct, bytesDone?, bytesTotal?, note? }` | 下载/校验/提交阶段变化，节流 100 ms |
| `job.done` | `{ jobId, packId, version, activated }` | 安装成功 |
| `job.failed` | `{ jobId, code, message, details? }` | 安装失败 |
| `installed.changed` | `{ packId, version?, state }` | 启用/禁用/卸载/回滚 |
| `catalog.changed` | `{ sourceId?, total }` | 目录刷新完成 |
| `sources.changed` | `{ sourceId, action: 'added' \| 'removed' }` | 来源增删 |

同一 job 的连续进度在 100 ms 窗口内合并，只推最后一帧；`job.done` 与 `job.failed` 前必有一次终态 `job.progress`。

实现（v0.1.0）：心跳是 25 秒一行的 `: ping` 注释；`hello` 载荷是 `{ plugin, version, jobs, installed, at }`。事件名与上表一致，客户端只需要 `addEventListener` 这四个以上事件名。

## 6. 服务面

```ts
ctx.provide('petmarket', {
  version: string,
  mode: 'pethost' | 'legacy' | 'local',
  dataRoot: string,
  install(source: string): JobView,            // 粘贴链接或 local: 路径，立刻返回作业
  list(): InstalledView[],                      // 台账快照
  jobs(): JobView[],
  activate(petId: string, version?: string): Promise<InstalledView>,
  disable(petId: string): Promise<InstalledView>,
  uninstall(petId: string, version?: string): Promise<InstalledView>,
  snapshot(): HealthView,
});
```

设计目标是让服务面、HTTP 层、测试共用同一组用例：HTTP 路由器与 `ctx.provide` 两条入口都在收尾到 `lib/install.js` 与 `lib/ledger.js`，没有第二套逻辑。

## 7. 客户端模块与落点

| 落点 | slot | 内容 |
| --- | --- | --- |
| 左侧栏入口 | `sidebar.panellist`（id `petmarket`，order 1） | 24×24 描边猫脸图标，label「宠物乐园」，点击切到 `main` 面板 |
| 主面板 | `main`（key `petmarket`） | 市场主面板：目录、来源、已安装、任务（与设置页同一组件） |
| 设置页 | `settings.section`（id `petmarket.market`） | 同一市场面板的设置页副本，供只在设置里找入口的用户 |
| 桌宠区域浮层 | `shell.overlay`（id `petmarket.stage`） | 系统桌面舞台可用时自动隐藏；不可用时在页面内渲染同一只宠物 |

客户端 `inject` 必须声明 `slots`：cordis 的 `ReflectService` 对未声明服务的属性读取抛 `cannot get property "..." without inject`，`ctx.get(name)` 不受限但 `ctx.slots.register(...)` 受限。每个 seat 用 `safeMount` 单独 try/catch，宿主缺某个 slot 时只丢那一个入口。样式不用 `styles` 服务承担成败：`installStyles()` 先试 `styles.insert(CSS)`，再无条件写入/复用 `<style data-plugin="dsh-pet-market">`，两条路任一生效面板就有样式（实测宿主里 `styles.insert` 返回成功但规则没落地）。

客户端注入 `pets:renderers` SPI 做预览：给一个临时 `previewId`，取 `pet.json` 与图集，用 `sprite` 渲染器播 `idle` 两秒，不写盘、不进 ledger。SPI 缺失时预览降级为静态缩略图，安装流程不受影响。

## 8. 宠物宿主契约（PetHost）

市场与宿主之间只有一份契约，宿主由谁实现与市场无关。宿主以服务名 `pethost` 暴露，市场通过 `ctx.get('pethost')` 取到，包一层 `HostPort`。

### 8.1 六个方法

| 方法 | 语义 | 市场何时调用 |
| --- | --- | --- |
| `contractVersion()` | 返回本宿主实现的 `petRuntime` 语义版本 | 安装前做 `engines` 判定；`/health` 展示 |
| `register(descriptor)` | 接收 `pet.json` 清单与文件映射，建立 packId → 实例模板的绑定 | 安装提交后、启动扫描修复时 |
| `activate(packId)` | 让该宠物出现在桌面上 | 用户点「启用」、安装末尾、回滚 |
| `deactivate(packId)` | 从桌面移除但保留注册 | 用户点「停用」、卸载前 |
| `unregister(packId)` | 解除注册并释放资源 | 卸载、替换安装、回滚失败清理 |
| `list()` / `activeId()` | 当前注册集合与当前激活项 | 面板状态对账、`broken` 判定 |

`descriptor` 结构固定为：

```json
{
  "packId": "pixel-cat",
  "version": "1.0.0",
  "profile": "sprite-sequence/v1",
  "manifest": { "…pet.json 全文…" },
  "files": { "sheet.png": "<Uint8Array>", "pet.json": "<Uint8Array>" },
  "source": "market:github:OWNER/pixel-cat@1.0.0",
  "dir": "packs/pixel-cat/1.0.0"
}
```

宿主可以按 `dir` 直读（进程同机时推荐），`files` 作为兜底。两种方式都由宿主决定，市场两种都提供。

### 8.2 宿主须满足的行为

1. `register` 幂等：同一 `packId` + `version` 重复注册不产生第二份实例。
2. `register` 之后到 `activate` 之前，宠物不出现在桌面上。
3. `activate` 成功返回后，该宠物的 `idle` 动画在 1 秒内可见。
4. `deactivate` 后资源可保留，但不再占用帧循环。
5. `unregister` 后内存中不再持有该包图集；做不到就返回 `false`，市场把记录标 `pending-restart` 并在 UI 明示。
6. 契约版本低于包的 `engines.petRuntime` 时，`register` 抛错，市场转成 `engines-mismatch`。
7. 宿主拒绝注册时抛带 `code` 的错误，市场原样透传为 `runtime-rejected` 的 `details.hostError`。

### 8.3 宿主能力要求

宿主对 `sprite-sequence/v1` 的能力要求见 [PACK-FORMAT.md §3.6](PACK-FORMAT.md)。市场只按那张表判定「能否 run」，不假设宿主用了什么渲染技术。

### 8.4 多实例

市场按「一个 `packId` 一个激活项」管理，这与多数桌宠宿主的模型一致。宿主若支持同包多实例，属于宿主能力，市场通过 `HostPort` 之外的扩展动作（`pack.spawn`）暴露；市场 v1 的 UI 只提供单实例开关。

## 9. 存储布局

```
<dataRoot>/                          # 插件数据目录，见 ARCHITECTURE.md §7
├── config.json                      # { schemaVersion, sources[], channel, githubTokenRef, ui{} }
├── ledger.json                      # { schemaVersion, records: { [packId]: LedgerRecord } }
├── packs/
│   └── <packId>/<version>/          # 解包后的包内容（pet.json 在根）
│       └── .market-install.json     # 安装元数据：sourceRef/tag/asset/sha256/installedAt
├── cache/
│   ├── github/<sha1(url)>.json      # release JSON + ETag + fetchedAt
│   ├── catalog/<sha1(url)>.json     # 目录索引 + ETag
│   └── preview/<previewId>/         # 临时预览，TTL 15 分钟
├── tmp/<jobId>/                     # 下载与解包暂存，结束即清
└── logs/market.log                  # 滚动日志，默认 2 MB × 3
```

`LedgerRecord`：

```json
{
  "packId": "pixel-cat",
  "version": "1.0.0",
  "state": "installed",
  "sourceRef": "github:OWNER/pixel-cat",
  "sourceUrl": "https://github.com/OWNER/pixel-cat",
  "tag": "v1.0.0",
  "assetName": "pixel-cat-1.0.0.dsppet",
  "sha256": "c4e0…",
  "sizeBytes": 1843200,
  "dir": "packs/pixel-cat/1.0.0",
  "channel": "stable",
  "pinned": false,
  "installedAt": 1761600000000,
  "activatedAt": 1761600001200,
  "profile": "sprite-sequence/v1",
  "verified": "digest+checksums",
  "previous": { "version": "0.9.0", "sha256": "9f2c…" },
  "manifest": { "name": { "zh": "像素猫" }, "size": { "w": 128, "h": 128 } }
}
```

`state` 取值 `installed`、`disabled`、`broken`、`pending-restart`。`previous` 只保留一层，满足回滚。

## 10. 并发、幂等、错误传播

1. 作业串行：全局同一时刻只跑一个安装类作业，其余 `queued`。理由是同卷 rename 与宿主注册都不是并发安全的。
2. 幂等键 `(kind, sourceRef, version)`：同键作业在 `queued`/执行中时，`POST /install` 返回既有 `jobId`，不新建。
3. 取消：只在 `queued`/`downloading`/`verifying` 生效；进入 `committing` 后取消返回 `invalid-params`，作业继续到终态。
4. 错误一律以 `code` + `message` + `details` 三层上报；`details` 带 `{ field, path, expected, actual }` 等定位信息，UI 直接展示 `field`。
5. 存储降级：`<dataRoot>` 不可写时切到 `storageDomain` 存元数据、`ctx.fs` 临时目录存包，`/health` 返回 `storage-degraded` 并在面板顶部常驻提示。
6. 宿主缺席：`ctx.get('pethost')` 为空时 `HostPort.available()` 为 false，安装流程在 `registering` 阶段失败为 `runtime-unavailable`，已提交的目录保留，装好宿主后点「注册」即可。

## 11. 插件生命周期

`apply(ctx)`：

1. 解析 `<dataRoot>`（`ctx.fs` 数据目录 → `<cwd>/.petmarket` → 降级标记）。
2. 载入 `config.json` 与 `ledger.json`，zod 校验，坏文件改名为 `.bak` 并从空记录起步（`storage-degraded`）。
3. `ctx.provide('petmarket', …)`。
4. `webServer.register({ kind: 'prefix', path: '/petmarket', handler })`。
5. 注册客户端资源与两个 slot。
6. `scheduler.start()`：启动 30 秒后首次检查更新，此后每 6 小时一次；不自动安装。
7. 对每个 `state: 'installed'` 且目录完整的记录尝试 `register`（幂等），失败标 `broken`。

`dispose()`：取消定时器、关闭 SSE 客户端、终止进行中的 job（标记 `job-canceled`）、释放预览目录。磁盘上的包与 ledger 保留。

### 11.1 DSH 插件形态的硬约束（v0.1.0 实测）

DSH 在两侧都把插件包进一层 façade，写法必须照这两条来，否则插件表现为「装上但什么都不显示」：

| 约束 | Host 半 | Client 半 |
| --- | --- | --- |
| 服务获取 | 只用 `ctx.get(name)`；`ctx.name` 仅对 `inject` 里声明过的服务可读 | 同左，`ctx.slots` 亦然 |
| 依赖声明 | `export const inject = ['webServer']`（数组；对象形式会被当成服务名，插件停在 `pending (waiting for services: required, optional)`） | `return { inject: [], apply(ctx) {} }` |
| 其它能力 | `ctx.effect/on/provide/timer 动词` 可直用 | 同左 |
| slot 注册 | — | `slots.register({ name, id, order, label }, Component)`；`settings.section` 的每个条目**必须**带 `label`（字符串或返回字符串的函数），缺了导航行是空白 |
| slot 时机 | — | `slots.inject(name, () => slots.register(...))`，等声明方就位再注册 |

`lib/util.js` 的 `resolveService` 因此只有 `ctx.get` 一条路径；`lib/router.js` 的 `attach` 先试 `ctx.webServer`（已声明的可读属性），失败再回落 `resolveService`。客户端 `client.js` 的 `mountSlot` 把 `label` 透传给 `slots.register`。



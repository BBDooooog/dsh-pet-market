# DSH 宠物乐园（dsh-pet-market）

一个 DSH 插件：装上它，把 GitHub 仓库链接粘进来，或者把已经下好的 `.dsppet` 拖到面板上，序列帧宠物就出现在桌面上。素材由作者自己发布、自己维护；市场只认格式，不认内容。

> 市场是分发管道，不是商店；格式是契约，不是审核。

状态：**可运行的插件实现**（Host + Client 两半，零运行时依赖）。格式规范、模块划分、链接解析、评审面板在 `docs/`。

## 30 秒上手

本机已经接好（profile 里加了 `link:D:/AI/dsh/dsh-pet-market`，依赖也装过），只差重启 DSH。重装一遍的命令如下：

```bash
# 1. 把插件接进当前 profile（一次性）
node -e "const fs=require('node:fs');const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,'utf8'));j.dependencies['dsh-pet-market']='link:D:/AI/dsh/dsh-pet-market';if(!j.dsh.profile.bundles.includes('dsh-pet-market'))j.dsh.profile.bundles.push('dsh-pet-market');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')" "$HOME/.dsh/profiles/desktop/package.json"

# 2. 装依赖（link 类型只是建软链）；pnpm 不在 PATH 时用 DSH 自带的那份
pnpm --dir "$HOME/.dsh/profiles/desktop" install
# "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" \
#   "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs" --dir "$HOME/.dsh/profiles/desktop" install

# 3. 重启 DSH（dshmarket 的自重启接口在当前 host 上被关闭：features.restart=false）
```

重启后看左侧栏的「宠物乐园」图标（同一面板也出现在 设置 → 宠物乐园）。只想核对服务在不在，用 `http://127.0.0.1:<port>/petmarket/api/health`，端口每次启动都可能变，从 DSH 窗口地址或启动日志里取。本机 `~/.dsh/petmarket` 里已经预装了演示宠物并设为激活，重启即可看到它在系统桌面右下角。

### 面板一片空白或提示「后端未加载」

插件的 Host 半只在 DSH 启动时挂载。装完不重启，页面能看到入口（client 半由页面加载清单直接送下来），但 `/petmarket/api/*` 全是 404 —— 面板会明确这么提示。处理顺序：

1. 完全退出 DSH（不是关窗口），重新启动。
2. `curl http://127.0.0.1:<port>/petmarket/api/health` 应返回 `{"ok":true,...}`；端口在启动日志里。
3. 仍然 404：确认 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-pet-market`，且 `node_modules/dsh-pet-market` 是指向本仓的软链。
4. 想直接看 Host 半的报错：用 `pmrescue` 模板 profile 起一个旁路实例（`dsh pmrescue --from-default-profile web --dump-config`，再把本仓 link 进去），日志里会打出 `petmarket (dsh-pet-market): Error: ...` 原文。

### 桌面上的猫忽然不见了

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 点一下就消失 | 旧版画家的鼠标回调在 `$ErrorActionPreference='Stop'` 下抛错会带走整个进程；现在三个回调都包了 try/catch，单个动作失败只写 `stage.log` | 完全重启 DSH（画家进程随宿主重启换新脚本） |
| `health` 里 `desktop.reason` 是 `exited` | 宿主不会无痕重启画家；现在按 `min(30s, 1.5s × attempts)` 退避重启 | 重启 DSH；或看 `<root>/stage/stage.err.log` |
| 猫被聊天软件窗口盖住 | 别的应用也是置顶窗口 | 画家每 180 ms 重新 `SetWindowPos(HWND_TOPMOST)`，重启后生效 |
| 面板里显示「出来玩」但桌面没有 | ledger 与 `ui.json` 两处 active 不一致（旧版的 `/active` 只写 ui.json） | 面板点「出来玩」重新激活，现在会同时改 ledger |

## 三条安装路径

| 路径 | 操作 | 走哪条链路 |
| --- | --- | --- |
| GitHub 仓库 | 面板输入 `owner/repo`、`owner/repo@v1.2.0` 或任意 release 链接 | 解析 release → 选资产 → 下载 → 校验 → 注册 |
| Release 直链 | 面板输入 `https://github.com/OWNER/REPO/releases/download/v1.0.0/pet.dsppet` | 不碰 GitHub API，直接下载（未认证 API 限流 60 次/小时时仍然可用） |
| 已有包 | 把 `.dsppet` / `.zip` 文件拖进面板，或点「选择文件」 | 本地读取 → 校验 → 注册 |
| 本地目录 | `local:D:/packs/pixel-cat`（开发调试用） | 读目录 → 校验 → 注册 |

## 演示：一只 CC0 像素猫 + 两只原创黄狗

`demo/packs/pixel-cat/` 是把 [Cat sprites（OpenGameArt，Shepardskin，CC0 1.0）](https://opengameart.org/content/cat-sprites) 的 GIF 重新打包成 `sprite-sequence/v1` 的完整样例：

![Pixel Cat 缩略图](demo/packs/pixel-cat/thumbnail.png)

- 图集 `240x102`，单帧 `40x34`，3 行 × 6 列：`idle` 2 帧、`walk` 6 帧、`run` 6 帧。
- 原生朝左（`renderer.front: "left"`），所以向右走时由画家自动水平镜像，不会「倒着走」。
- 打好的包：`demo/dist/pixel-cat-1.2.0.dsppet`（4350 B，带 `checksums.json` 与 `.sha256`）。

`demo/packs/yellow-dog/` 与 `demo/packs/yellow-dog-2/` 是用 Pillow 直接画出来的两个黄狗包（无第三方素材，随仓库授权）：

![Yellow Dog 缩略图](demo/packs/yellow-dog/thumbnail.png)

- 同一套图和动作，两个 `petId`（`yellow-dog`、`yellow-dog-2`），所以可以同时装两只，互不覆盖位置与状态。
- 原生朝右（`renderer.front: "right"`）。
- 打好的包：`demo/dist/yellow-dog-1.1.0.dsppet`、`demo/dist/yellow-dog-2-1.1.0.dsppet`。

重建与自检：

```bash
python demo/tools/build-assets.py    # GIF 帧 → 猫图集（需要 Pillow，仅作者侧依赖）
python demo/tools/build-dog-assets.py # 画狗图集
node demo/build-demo-pack.mjs        # 猫目录 → .dsppet，并用市场的校验器自校验
node demo/build-dog-pack.mjs         # 两个狗包
node test/run.mjs                    # 22 项测试，含插件在 DSH 风格 ctx 下的启动、WPF 画家进程、画家重启、stage token、详情页与改名
```

演示流程（重启 DSH 之后）：

1. 左侧栏「宠物乐园」→ 把 `demo/dist/pixel-cat-1.2.0.dsppet`、`yellow-dog-1.1.0.dsppet`、`yellow-dog-2-1.1.0.dsppet` 依次拖进虚线框。
2. 每个包都点一次「出来玩」：三只同时在场，各自有独立位置、朝向、动画进度，互不干扰。
3. 宠物跑在**系统桌面**上（透明置顶窗口，不属于 DSH 窗口）：点它会朝一侧冲刺一段（140–230 px）再回 `idle`，按住拖动 1:1 跟手，自己会在屏幕底部来回走，右键弹出「回窝睡觉 / 动作 →」。
4. 列表行里的 `− / Nx / +` 调 1–8 倍缩放：缩放以**底边中点**为锚点，宠物原地变大变小，位置与缩放都记在 `~/.dsh/petmarket/ui.json`。
5. 点「看看它」进单只宠物的页面：能看它声明的契约（契约版本、需要的运行时、渲染方式、单帧尺寸、图集布局、默认缩放、动画数、对齐点），每条动作是一段**真在播的逐帧预览**（下面标帧数、fps、循环还是播一次、接哪个动作），还有状态映射、「右键它能做什么」、事件反应，以及来源、内容指纹、安装目录和时间。
6. 名字旁边的铅笔图标点开才进入编辑，回车即存，`Esc` 取消；名字画在宠物头顶，字号默认跟着缩放走。详情页可以改**底色、字体、字号**（存 `ui.json` 的 `nameStyles`：`{ size, color, family }`），底色深浅会自动决定文字黑白。
7. 再粘一个真实仓库链接试 GitHub 链路；没有 `.dsppet` 资产的仓库会以 `asset-not-found` 结束，不会留下半装状态。

## 宠物在桌面上怎么动

- 每只宠物一个画家进程里的一个透明窗口；新宠物默认落在**没被 DSH 窗口遮住**的角落（右下 → 左下 → 右上 → 左上依次试）。
- `idle` 待机一段时间（3–9 秒）后随机进入 `walk`，走 1.8–4.2 秒再回 `idle`；碰到工作区边缘会掉头并翻转贴图。
- 帧推进固定 33 ms 一次 tick，且一次 tick 最多前进一帧：帧率低的包不会“跳帧”，帧率高的包也不会被追上。
- 非循环动画播完后按 `next` 链走（`run → idle`），没有 `next` 就回 `idle`。
- 朝向以包里的 `renderer.front` 为准：台账里没有该字段的早期安装，画家会直接读包内 `pet.json`，所以左向素材不会倒着走。
- 单击 = 朝一侧冲刺 140–230 px（`dash` 状态，260 dip/s），冲刺期间 `facing` 跟着方向变；朝向按素材自身朝向（`renderer.front`）决定是否水平镜像。
- 右键 = 「回窝睡觉」（等价于收起）+「动作」子菜单（列出这个包声明的全部动作，没有额外动作就不出现这一项）；菜单是圆角浅色样式，不跟随系统深色。
- 画家的窗口每 180 ms 重新置顶一次，避免被其他置顶窗口（聊天工具、企业水印层）压住。

## 两套舞台：系统桌面 + DSH 面板

宠物有两处显示位置，同一个 `ui.json` 决定位置：

| 舞台 | 实现 | 什么时候有 |
| --- | --- | --- |
| 系统桌面舞台 | 主力是 WPF 画家进程：`lib/desktop-stage-wpf.js` 写 `stage/state.json`，用 `powershell.exe -STA` 起 `stage/desktop-pet.ps1`，它给每只宠物开一个透明置顶窗口直接画 `CroppedBitmap` 帧。宿主能建 Electron 窗口时优先用 `lib/desktop-stage.js`（`stage/stage.html` + `data:` 图集） | Windows + `powershell.exe`；Electron 分支要求宿主是 Electron 主进程（本机 DSH Desktop 的插件宿主以 `ELECTRON_RUN_AS_NODE=1` 运行，因此实际走 WPF） |
| DSH 内嵌舞台 | `client.js` 的 `shell.overlay` seat，React 组件 + 同一套序列帧计算 | 任何 Web 宿主，包括浏览器打开 DSH；桌面舞台 `available` 时自动让位，避免同一只宠物出现两次 |

桌面舞台的要点：

- WPF 画家窗口 `WindowStyle=None + AllowsTransparency + Topmost + ShowInTaskbar=$false + ShowActivated=$false`，出现时不抢焦点、不进任务栏；Electron 分支等价参数是 `transparent + frame:false + alwaysOnTop('floating') + skipTaskbar + focusable:false`。
- 画家每 500 ms 读一次 `stage/state.json`（内容没变就跳过），宿主改数据只写文件，不跨进程推消息；帧定时器 33 ms（30 fps），动画本身 6–14 fps，帧数据按 `pose#index` 缓存，不在每帧重建 `CroppedBitmap`。
- 拖动用 `CaptureMouse` + 屏幕坐标（`Cursor.Position` 差值除以 `TransformToDevice.M11`），松手才 `POST /petmarket/api/stage/position` 写 `ui.json` 并广播 `installed.changed`；单击 `POST /stage/click` 切 `happy` 1.5 s。这两个端点认请求头 `x-petmarket-stage`（token 存在 `<root>/stage/token`），因为画家进程没有浏览器 origin，不走同源校验。
- 画家每 10 s 检查 owner 进程，DSH 退出它就退出；宿主启动时读 `stage/stage.pid`，只清掉「owner 已经不在」的残留画家，并用 `<root>/stage/stage.lock` 独占锁保证同一数据根下只有一个画家。
- `config.desktop: false` 关掉桌面舞台；Electron 分支可用 `config.displayIndex` 选屏。
- `GET /petmarket/api/catalog` 的 `desktop` 字段给出状态：`{ available, engine: 'wpf'|'electron', reason, pid, pets, attachedAt }`，面板底部直接显示。


## 数据落在哪

```
~/.dsh/petmarket/            # 数据根，配置可覆盖
├── config.json              # 源列表、keepVersions、allowPrerelease
├── ledger.json              # 每只宠物的版本、状态、来源、哈希、目录
├── ui.json                  # 桌面位置与当前激活的宠物
├── packs/<petId>/<version>/ # 解包后的素材，含 .market-install.json
├── cache/github/            # release 元数据缓存（10 分钟）
├── tmp/<jobId>/             # 暂存区，原子提交后消失
└── logs/market.log
```

数据根不可写时自动降级到临时目录，并在 `health.dataRoot` 里给出 `storage-degraded`。

## API（全部挂在 `/petmarket/api`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `health` | 运行模式、数据根、台账、作业快照 |
| GET | `installed` | 已安装宠物与版本状态 |
| GET | `catalog` | 面板一次拉齐：源、已安装、UI 状态 |
| GET | `jobs` / `jobs/:jobId` | 作业列表与单个作业的阶段、进度、错误 |
| POST | `install` | `{source}`：GitHub 链接 / `local:` 路径 |
| POST | `resolve` | 只解析不安装，用于安装前预览 |
| POST | `import?filename=` | 原始字节上传（拖拽走这条） |
| POST | `installed/:petId/activate|disable|uninstall|state` | 生命周期 |
| POST | `active` | 切换桌面上显示哪只 |
| GET | `packs/:petId/:version/<path>` | 读包内素材（客户端渲染用） |
| GET | `stream` | SSE：`job.progress`、`job.done`、`job.failed`、`installed.changed`、`sources.changed` |

写操作要求同源（`sec-fetch-site` / `origin` 校验），返回值统一是 `{ok:true,value}` 或 `{ok:false,error:{code,message}}`。完整表格见 [MODULES.md](docs/MODULES.md)。

## 宠物宿主怎么接

市场不自己画宠物，它把包交给宿主。宿主实现 `pethost` 服务即可：

```js
ctx.provide('pethost', {
  contractVersion: () => '1.0.0',
  register: async (descriptor) => { /* {petId, version, profile, dir, manifest, files, source} */ },
  activate: async (petId) => {},
  deactivate: async (petId) => {},
  unregister: async (petId) => {},   // 返回 false 表示需要重启后生效
  list: async () => [{ packId, version }],
})
```

没有 `pethost` 时市场自动降级：只做安装与台账，渲染交给插件自带的 overlay（`client.js`）。这套 overlay 本身就是一个最小的序列帧播放器，支持 `sheet` 与 `frames` 两种模式、`loop:false` 的单次动画、`pingpong`、以及按帧偏移的图集取帧。

## 仓库布局

```
dsh-pet-market/
├── index.js              # 插件入口（Host 半）：打开存储 → 建桥 → 装 HTTP → 提供服务面
├── client.js             # 插件入口（Client 半）：设置面板 + 桌面 overlay
├── cordis.patch.yml      # 插件挂载声明
├── lib/
│   ├── util.js           # 信封、路径、同源校验、错误映射
│   ├── zip.js            # 纯 JS zip 读取（bomb / 路径穿越防护）
│   ├── hash.js           # sha256
│   ├── pack.js           # sprite-sequence/v1 校验器（几何、预算、engines）
│   ├── sources.js        # 源解析：GitHub 链接各形态 / local: 路径
│   ├── github.js         # release 解析、资产选择、直链优先
│   ├── download.js       # 流式下载 + 重试 + 限流退避
│   ├── ledger.js         # 存储布局、台账、原子写
│   ├── runtime.js        # pethost → legacy → local 三级桥
│   ├── install.js        # 作业队列、阶段权重、回滚
│   └── router.js         # HTTP + SSE
├── test/run.mjs          # node --test，14 项
├── demo/                 # CC0 像素猫素材、打包脚本、产物
└── docs/                 # 架构、格式、模块、源解析、评审
```

## 文档

| 文档 | 看什么 |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 目标与非目标、拓扑、信任边界、三条主流程、状态模型、MVP、失败模式 |
| [PACK-FORMAT.md](docs/PACK-FORMAT.md) | 序列帧包规范 v1：字段、图集几何、播放语义、宿主实现要求、预算、错误码 |
| [MODULES.md](docs/MODULES.md) | 模块表、端口、Host API 全表、SSE、PetHost 契约、存储、并发幂等 |
| [SOURCES.md](docs/SOURCES.md) | 链接形态、解析算法、资产选择、哈希链、限流缓存、更新回滚 |
| [REVIEW.md](docs/REVIEW.md) | D1–D13 决策、P1–P9 开放选择、评审顺序 |

## 边界

| 市场负责 | 市场不负责 |
| --- | --- |
| 解析链接、选资产、校验格式、安装、回滚 | 素材内容、画风、动作是否得体 |
| 台账、版本、启用/停用/卸载、桌面位置 | 宠物的动作编排（由 `pet.json` 声明） |
| 宿主契约与兼容判定、overlay 兜底渲染 | 宿主内部实现与性能 |
| 错误定位：每个失败都有稳定错误码 | 作者的发版流程（由包模板 CI 承担） |

v1 只收 `sprite-sequence/v1`：其他 `renderer.type` 直接 `profile-unsupported`，等运行时能真的跑起来再扩 profile。


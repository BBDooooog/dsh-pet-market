# 序列帧素材包规范 v1（`sprite-sequence/v1`）

本文件是市场的唯一权威格式规范。市场按本规范校验，任何宠物宿主（PetHost）按本规范 load 和 run。素材包仓库、作者模板、CI 校验器、宿主 vendor 的 JSON Schema 都以本文为准。

- 规范版本：`schema: 1`
- Profile：`sprite-sequence/v1`（市场 v1 只接受这一种 profile）
- 兼容声明：`engines.petRuntime`（宠物宿主契约版本范围）
- 包扩展名：`.dsppet`（zip 容器）

本文描述的是契约，不描述某个具体宿主的现状。宿主要接入市场，就要满足本文第 3.6 节的实现要求；实现进度不影响格式定义。

## 1. 三个文件的职责

| 文件 | 归属 | 作用 | 谁校验 |
| --- | --- | --- | --- |
| `pet.json` | 宿主契约 | 身份、画布、图集、动画、状态映射、菜单、反应 | 市场（安装前）+ 宿主（load 时） |
| `market.json` | 展示附加 | 标签、预览图、截图、主页、变更日志 | 市场（可选，缺失即降级为无标签） |
| `checksums.json` | 完整性 | 包内每个文件的 `sha256` | 市场（解包后逐个比对） |

身份只认 `pet.json`：`id` 与 `version` 以 `pet.json` 为唯一来源。`market.json` 若同时写了 `id`/`version`，必须与 `pet.json` 完全一致，否则 `schema-invalid`。

## 2. 包结构

```
pixel-cat.dsppet
├── pet.json
├── market.json
├── checksums.json
├── sheet.png
├── thumbnail.webp
├── screenshots/
│   ├── 01.png
│   └── 02.webp
└── LICENSE.txt
```

规则：

1. 解包后 `pet.json` 必须在包根，或在一个唯一的顶层目录里（如 `pixel-cat/pet.json`）。校验器剥掉这层目录后再校验；剥后仍找不到 `pet.json` 判 `schema-invalid`。
2. `pet.json` 里引用的一切资产路径都是相对包根的 POSIX 路径，禁止绝对路径、盘符、`..`、NUL。
3. 解包后文件数 ≤ 512，单文件 ≤ 20 MB，解压总量 ≤ 80 MB，压缩比 > 200:1 判 `zip-bomb`。
4. 允许的扩展名白名单：`png`、`webp`、`json`、`txt`、`md`、`svg`。出现 `html`、`js`、`mjs`、`wasm`、`exe`、`dll`、`so`、`sh`、`bat`、`ps1`、`zip` 一律 `file-type-rejected`。
5. 不支持符号链接、加密 zip、分卷、zip64。
6. 文件名大小写冲突（`Sheet.png` 与 `sheet.png`）判 `path-traversal`（Windows 上会互相覆盖）。

## 3. `pet.json` 字段

### 3.1 顶层

| 字段 | 必填 | 类型 | 约束 |
| --- | --- | --- | --- |
| `schema` | 是 | int | 必须为 `1` |
| `id` | 是 | string | `^[a-z0-9][a-z0-9._-]{1,63}$`，全局唯一 |
| `version` | 是 | string | semver，如 `1.2.0` |
| `name` | 是 | string \| i18n | i18n 形如 `{ "zh": "…", "en": "…" }` |
| `description` | 否 | string \| i18n | ≤ 400 字 |
| `author` | 否 | string | ≤ 80 字 |
| `license` | 否 | string | SPDX 标识符 |
| `homepage` | 否 | string | https URL |
| `engines` | 是 | object | `{ "petRuntime": "^1" }`，市场用宿主声明的契约版本判定，不猜具体实现版本 |
| `size` | 是 | object | `{ "w": int, "h": int }`，渲染逻辑尺寸（CSS px），1..1024 |
| `anchor` | 否 | object | `{ "x": 0..1, "y": 0..1 }`，默认 `{ "x": 0.5, "y": 1 }` |
| `renderer` | 是 | object | 见 3.2，`type` 必须为 `sprite` |
| `bubble` | 否 | object | `{ "anchor": "top"\|"bottom", "style": string }` |
| `menus` | 否 | object | 预设 id → 菜单项数组，见 3.4 |
| `actions` | 否 | object | 自定义动作名 → `{ "params": …, "effect": … }` |
| `reactions` | 否 | array | 见 3.5 |

### 3.2 `renderer`（序列帧核心）

| 字段 | 必填 | 类型 | 约束 / 默认 |
| --- | --- | --- | --- |
| `type` | 是 | string | 固定 `"sprite"`；其它值判 `profile-unsupported` |
| `mode` | 否 | string | `"sheet"`（默认）或 `"frames"` |
| `image` | sheet 必填 | string | 图集相对路径，PNG 或 WebP |
| `framesDir` | frames 必填 | string | 帧目录相对路径，如 `frames/idle/` |
| `frame` | 是 | object | `{ "w": int, "h": int }`，1..512 |
| `grid` | 否 | object | `{ "cols", "rows", "margin", "spacing" }`，缺省由图片尺寸推导 |
| `animations` | 是 | object | 动画名 → 动画定义，见 3.3，1..32 项 |
| `states` | 是 | object | pose → 动画名，必须含 `idle` |
| `hitbox` | 否 | object | `{ "x", "y", "w", "h" }`，相对帧左上角，缺省为整帧 |
| `flip` | 否 | object | `{ "supported": bool }`，宿主按朝向做水平镜像，默认 `true` |
| `front` | 否 | string | `"left"` \| `"right"`，素材本身朝哪边，默认 `"right"`。宿主据此决定什么时候镜像：朝左的素材向右走时才翻，否则会出现「倒着走」 |

图集坐标规则（sheet 模式，`c` 为列、`r` 为行，均从 0 起）：

```
x = margin + c * (frame.w + spacing)
y = margin + r * (frame.h + spacing)
列数 cols = (imageWidth  - 2*margin + spacing) / (frame.w + spacing)
行数 rows = (imageHeight - 2*margin + spacing) / (frame.h + spacing)
```

`cols`、`rows` 必须整除，否则 `sheet-geometry`。声明了 `grid` 时须与推导值一致。

### 3.3 动画定义

| 字段 | 必填 | 类型 | 约束 / 默认 |
| --- | --- | --- | --- |
| `row` | sheet 必填 | int | `0 ≤ row < rows` |
| `from` | 否 | int | 起始列，默认 `0`；`from + frames ≤ cols` |
| `frames` | 是 | int | 1..128，全包合计 ≤ 512 |
| `fps` | 是 | number | 1..30，建议 6..12 |
| `loop` | 否 | bool | 默认 `true` |
| `next` | 否 | string | 播完后自动切换的动画名 |
| `hold` | 否 | int | 末帧额外停留帧数，0..30，默认 0 |
| `direction` | 否 | string | `"forward"`（默认）或 `"pingpong"` |
| `events` | 否 | object | 帧号 → 事件名，帧号 `< frames`，事件名 `^[a-z][a-z0-9._-]{0,31}$` |
| `facing` | 否 | string | `"right"`（默认）或 `"left"`，作为该动画的默认朝向 |
| `dir` | frames 可选 | string | 帧目录，默认 `<framesDir>/<动画名>/` |

播放语义：

1. 第 `i` 帧（`0 ≤ i < frames`）对应列 `from + i`，显示时长 `1000 / fps` 毫秒，所有帧等时长。
2. `loop: true`：播完末帧回第 0 帧，持续循环。
3. `loop: false`：播到末帧后停住，并派发 `animation.completed` 事件；若声明了 `next`，顺序切到该动画。
4. `hold`：末帧额外停 `hold` 帧时长后再判断 `loop`/`next`。
5. `direction: "pingpong"`：正放再倒放，倒放不重复首末帧。
6. 帧事件：动画可声明 `"events": { "3": "footstep" }`，第 3 帧进入时派发 `animation.frame` 事件，`payload.animation` 与 `payload.name` 带上动画名与事件名。
7. 状态映射：`states` 的键是宿主的 pose 名，值是动画名。`idle`、`busy`、`talk`、`error` 是推荐内置 pose；任何其它 pose 名都合法，由 `actions`/`reactions`/菜单的 `state` op 驱动。
8. 缺失某 pose 对应动画时回落到 `idle`；`idle` 缺失判 `schema-invalid`。

朝向：`flip.supported` 为 true 时，宿主用 `scaleX(-1)` 做水平镜像。素材默认朝右就不用写；朝左的素材必须写 `renderer.front: "left"`，宿主才知道「向右走」时该翻过来——漏写会让宠物看起来在倒着走。

frames 模式：每个动画从 `<framesDir>/<动画名>/`（或 `dir`）读 `000.png`、`001.png`… 连续编号，编号必须从 0 开始无缺号，文件数须等于 `frames`；`row`、`from`、`grid` 在该模式忽略。sheet 与 frames 的播放语义完全一致。

### 3.4 菜单项

菜单项由宿主渲染，市场逐项校验：

```json
{ "id": "wave", "label": { "zh": "挥挥手", "en": "Wave" }, "kind": "action", "action": "play", "params": { "name": "wave" } }
```

`kind` 取值：

| kind | 必需字段 | 语义 |
| --- | --- | --- |
| `action` | `action`（动作 id） | 调宿主动作，`params` 透传 |
| `command` | `command` | 转调已注册命令 |
| `url` | `url`（https） | 用户点击后打开外部链接 |
| `submenu` | `items` | 子菜单，深度 ≤ 2 |
| `separator` | 无 | 分隔线（`{ "separator": true }`） |

### 3.5 `reactions`

```json
{ "on": "agent.state", "when": { "status": "running" }, "debounce": 400, "do": [ { "op": "play", "name": "busy" } ] }
```

`on` 允许：`agent.state`、`agent.error`、`tool.start`、`tool.end`、`timer`、`pack.activated`、`pack.deactivated`。`do` 的 op 集合与宿主动作 op 对齐：`state`、`play`、`say`、`bubble.clear`、`move`、`scale`、`visible`、`menu`、`menu.close`、`pack`。

### 3.6 宿主实现要求

接入本规范的宠物宿主按这组要求实现，本文与宿主实现的版本差由 `engines.petRuntime` 卡住。P0 缺一项，本 profile 的包就跑不对；P1 影响体验；P2 属扩展。

| 级别 | 要求 | 验收方式 |
| --- | --- | --- |
| P0 | 图集按 `margin` / `spacing` / `frame` 计算帧矩形，支持非零边距 | 一个带 8 px 边距的 4×4 图集能逐帧对齐 |
| P0 | 动画从 `from` 列开始 | 一行 16 格、`from: 8`、`frames: 4` 只播后 4 格 |
| P0 | `loop: false` 播完停住并派发 `animation.completed` | 单次动画停末帧，`next` 生效 |
| P0 | `hold` 生效 | 末帧停留时长 = `hold × 1000/fps` 毫秒 |
| P0 | `states` 支持任意 pose 名，未知 pose 回落 `idle` | 自定义 pose `dance` 能触发并能回 idle |
| P0 | 帧矩形计算与图片像素 1:1，不缩放模糊（整数缩放） | 128px 图集在 128px 逻辑尺寸下清晰 |
| P0 | 返回可校验的契约版本（`petRuntime` 语义版本） | 市场读得到并用于 `engines` 判定 |
| P1 | `direction: "pingpong"` | 正放倒放序列正确 |
| P1 | `events` 帧事件派发 | 第 3 帧触发 `animation.frame` |
| P1 | `hitbox` 参与命中判定 | 透明区域点击不响应 |
| P1 | `flip` 镜像 | 朝向切换只换 transform |
| P2 | `mode: "frames"` 目录序列帧 | 与 sheet 模式渲染结果一致 |
| P2 | 自定义动画混合、图层、阴影 | 由 profile 后续版本定义 |

宿主的实现细节（DOM、Canvas、原生窗口）不在本文范围。市场只依赖「按本文 load 与 run」这一条。

## 4. `market.json`

```json
{
  "schema": 1,
  "tags": ["cat", "pixel", "idle"],
  "homepage": "https://github.com/OWNER/REPO",
  "license": "MIT",
  "previews": [
    { "path": "thumbnail.webp", "label": { "zh": "待机", "en": "Idle" } }
  ],
  "screenshots": ["screenshots/01.png"],
  "changelog": "CHANGELOG.md",
  "contact": "https://github.com/OWNER"
}
```

约束：`tags` ≤ 8 个，每个 ≤ 24 字符，小写 `[a-z0-9-]`；`previews` ≤ 4；`screenshots` ≤ 6；全部路径相对包根且在白名单内。缺省时市场从 `pet.json` 的 `name`/`description` 与 `animations` 派生展示信息。

## 5. `checksums.json`

```json
{
  "schema": 1,
  "algorithm": "sha256",
  "files": {
    "pet.json": "9f2c…",
    "market.json": "1a7d…",
    "sheet.png": "c4e0…"
  }
}
```

规则：键为相对包根路径（POSIX）；不含 `checksums.json` 自身；值与文件字节的 sha256 十六进制小写 64 位一致，否则 `digest-mismatch`。缺失 `checksums.json` 时市场仍可安装，但 ledger 标记 `verified: "container-only"`，UI 显示「仅容器校验」。

## 6. PNG / WebP 尺寸探测

| 格式 | 探测方式 | 要求 |
| --- | --- | --- |
| PNG | 读签名后 IHDR 的 `width`/`height` | 必须与 `grid` 推导一致 |
| WebP | 读 `VP8X`/`VP8 `/`VP8L` 头 | 同上 |
| SVG | 仅允许出现在 `thumbnail`/`screenshots` | 以 `<img>` 加载；含 `<script`、`onload=`、`javascript:` 判 `file-type-rejected` |
| 其它 | — | `image-format-unsupported` |

## 7. 资源预算（默认值，可在市场配置里放宽）

| 项目 | 上限 |
| --- | --- |
| 图集单边 | 4096 px |
| 单帧 | 512 × 512 |
| 动画数 | 32 |
| 单动画帧数 | 128 |
| 全包帧数 | 512 |
| 包体积 | 20 MB |
| 解压总量 | 80 MB |
| 文件数 | 512 |
| 估算显存（全部图集解码后） | 64 MB |

## 8. 校验错误码（格式相关）

| 码 | 触发 |
| --- | --- |
| `schema-invalid` | 字段缺失、类型错、id 不符合正则、`states.idle` 缺失、`market.json` 与 `pet.json` 身份不一致 |
| `profile-unsupported` | `renderer.type` 非 `sprite`，或 `schema` 非 1 |
| `engines-mismatch` | `engines.petRuntime` 不满足宿主契约版本 |
| `asset-missing` | 引用了包内不存在的文件；frames 模式缺号 |
| `sheet-geometry` | 图集宽高与 `frame`/`grid` 不整除，或 `from + frames > cols`、`row ≥ rows` |
| `image-format-unsupported` | 图集不是 PNG / WebP |
| `file-type-rejected` | 出现白名单外扩展名，或 SVG 内联可执行内容 |
| `zip-invalid` | zip 结构损坏、加密、分卷 |
| `zip-bomb` | 解压总量或压缩比越界 |
| `path-traversal` | 绝对路径、`..`、NUL、大小写冲突、Windows 保留名 |

## 9. 完整示例

`pet.json`：

```json
{
  "schema": 1,
  "id": "pixel-cat",
  "version": "1.0.0",
  "name": { "zh": "像素猫", "en": "Pixel Cat" },
  "description": { "zh": "四行动画：待机、走、跑、开心", "en": "Four rows: idle, walk, run, happy" },
  "author": "OWNER",
  "license": "MIT",
  "homepage": "https://github.com/OWNER/pixel-cat",
  "engines": { "petRuntime": "^1" },
  "size": { "w": 128, "h": 128 },
  "anchor": { "x": 0.5, "y": 1 },
  "bubble": { "anchor": "top", "style": "default" },
  "renderer": {
    "type": "sprite",
    "mode": "sheet",
    "image": "sheet.png",
    "frame": { "w": 128, "h": 128 },
    "grid": { "cols": 8, "rows": 4, "margin": 0, "spacing": 0 },
    "animations": {
      "idle": { "row": 0, "from": 0, "frames": 8, "fps": 8, "loop": true },
      "walk": { "row": 1, "from": 0, "frames": 6, "fps": 12, "loop": true },
      "run": { "row": 2, "from": 0, "frames": 6, "fps": 16, "loop": true },
      "happy": { "row": 3, "from": 0, "frames": 5, "fps": 12, "loop": false, "next": "idle", "events": { "4": "tail-wag" } }
    },
    "states": { "idle": "idle", "busy": "run", "talk": "happy", "error": "idle" },
    "hitbox": { "x": 24, "y": 32, "w": 80, "h": 96 },
    "flip": { "supported": true },
    "front": "right"
  },
  "menus": {
    "default": [
      { "id": "hi", "label": { "zh": "打招呼" }, "kind": "action", "action": "say", "params": { "text": "喵", "ttl": 3000 } },
      { "id": "happy", "label": { "zh": "开心" }, "kind": "action", "action": "play", "params": { "name": "happy" } }
    ]
  },
  "actions": {
    "stretch": { "params": {}, "effect": "play:happy" }
  },
  "reactions": [
    { "on": "agent.state", "when": { "status": "running" }, "do": [{ "op": "play", "name": "run" }] },
    { "on": "tool.start", "debounce": 400, "do": [{ "op": "play", "name": "happy", "repeat": true }] }
  ]
}
```

同目录 `checksums.json` 覆盖 `pet.json`、`market.json`、`sheet.png` 等实际文件（sha256 由打包 CI 计算写入）。

## 10. 兼容与演进

1. `schema` 只增不改语义：新增可选字段不升 `schema`；已有字段语义变化必须升 `schema` 并保留旧分支校验。
2. 市场与宿主都按 `schema` 分派校验器；遇到高于自身的 `schema` 判 `profile-unsupported`，附「请升级宿主」提示。
3. 未知字段透传保留，不因未知字段拒包（前向兼容）。
4. 废弃流程：先标记 `deprecated` 并双写一段时间，再从校验器移除。
5. 市场 v1 只接受 `sprite-sequence/v1`。`frames` 目录模式与 sheet 模式同级：宿主声明支持哪个由 `engines.petRuntime` 与 profile 能力表决定，市场在候选详情里展示「该宿主支持的能力」。
6. 新增 profile（如 `sprite-multi-layer/v1`）走新 profile id，不修改 `sprite-sequence/v1` 的字段语义。

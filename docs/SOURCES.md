# 来源与安装解析

本文定义市场如何把一个 GitHub 链接变成候选素材包、如何校验、如何更新与回滚、失败时给什么码。包内部结构看 [PACK-FORMAT.md](PACK-FORMAT.md)，模块边界看 [MODULES.md](MODULES.md)。

## 1. 输入形态

用户能给的东西不止一种 URL。`core/source` 负责全部归一化，归一化失败一律 `source-invalid`，并回显 `details.accepted` 列出可接受形态。

| 输入 | 归一化结果 |
| --- | --- |
| `OWNER/REPO` | `{ owner, repo, channel: 'stable' }` |
| `https://github.com/OWNER/REPO` | 同上（去掉 `.git` 与尾斜杠） |
| `https://github.com/OWNER/REPO/` | 同上 |
| `https://github.com/OWNER/REPO/releases` | 同上 |
| `https://github.com/OWNER/REPO/releases/latest` | 同上，`channel: 'stable'` |
| `https://github.com/OWNER/REPO/releases/tag/<TAG>` | 追加 `tag: TAG` |
| `https://github.com/OWNER/REPO/releases/download/<TAG>/<ASSET>` | 追加 `tag`、`asset` |
| `https://api.github.com/repos/OWNER/REPO/releases/...` | 解析出 `owner`/`repo`/`tag`/`asset` |
| `https://raw.githubusercontent.com/OWNER/REPO/<ref>/pet.json` | 解析出 `owner`/`repo`，按 `<ref>` 当 tag 解析第 4 步；该 ref 无 release 时 `release-not-found` |
| `local:<绝对路径>` | 仅测试与离线导入：指向一个已解包目录，跳过下载与哈希，直接格式校验 |
| 其它 | `source-invalid`，`details.accepted` 给前四种 GitHub 形态与 `local:` 形态 |

`owner` 与 `repo` 按 GitHub 规则校验：`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` 与 `^[A-Za-z0-9._-]{1,100}$`。大小写统一按 GitHub 的重定向结果为准。

`sourceRef` 是持久标识：`github:<owner>/<repo>`（小写化 owner/repo），可选后缀 `@<tag>`。`sourceId` 为其 `sha1` 前 12 位，用于删除与日志。

## 2. `resolve` 算法

`POST /petmarket/api/resolve` 是唯一入口，安装前必走一次。纯解析，不写盘、不下载整包。

```
resolve(input, channel):
  1. src = normalize(input)                        // source-invalid；local: 直接走第 9 步
  2. repo = github.repo(src)                        // 404 → github-not-found；403/429 → github-rate-limited
  3. if repo.archived: 记 note（仍可解析）
  4. if src.tag:
       rel = github.releaseByTag(src, tag)          // 无 → release-not-found
     else if channel == 'prerelease' or src.channel == 'prerelease':
       list = github.recentReleases(src, 10)        // 跳过 draft；取第一个（含 prerelease）
       rel = list[0]                                // 空 → release-not-found
     else:
       rel = github.latestRelease(src, includePrerelease: false)   // 空 → release-not-found
  5. assets = rel.assets.filter(是候选包)            // 见 §3
  6. if assets.length == 0: asset-not-found { release: rel.tag, scanned: names }
  7. candidates = assets.map(a => {
       meta = 读包内 pet.json（范围请求取 zip 中央目录，最多下 512 KB）   // 失败则 meta = null
       return { assetName, size, digest, tag, version: meta?.version ?? parse(tag),
                packId: meta?.id ?? null, name: meta?.name ?? null,
                profile: meta?.renderer?.type === 'sprite' ? 'sprite-sequence/v1' : null,
                engines: meta?.engines ?? null, metaStatus }
     })
  8. 排序：digest 非空优先 → size ≤ 预算 → semver 降序 → assetName 字典序
  9. previewId = core/preview 建临时目录，把候选包解到 cache/preview/<previewId>/
 10. 返回 { candidates, previewId }
```

`local:` 源返回单候选：`digest: null`、`tag: 'local'`、`sha256` 由目录内容整体算出，装到 `packs/<id>/<version>` 后与远程安装完全同构，用于离线导入与测试夹具。

第 7 步的范围请求是可选的优化：实现上先整包下载但不写盘、上限 512 KB 的流式解析 zip 中央目录更简单；两种都遵守「不把整包留在内存」。

候选返回给 UI 的形态：

```json
{
  "sourceRef": "github:owner/pixel-cat",
  "tag": "v1.0.0",
  "assetName": "pixel-cat-1.0.0.dsppet",
  "size": 1843200,
  "digest": "sha256:c4e0…",
  "packId": "pixel-cat",
  "version": "1.0.0",
  "name": { "zh": "像素猫" },
  "profile": "sprite-sequence/v1",
  "engines": { "petRuntime": "^1" },
  "previewId": "p_8f3a…"
}
```

## 3. 资产选择

候选判定，全部满足才算：

1. `name` 以 `.dsppet` 或 `.zip` 结尾。
2. `size` ≤ 包预算（20 MB），且 > 0。
3. `name` 不是 `*.sha256`、`*.sig`、`*.asc`、`*.txt`、`*.json`。

排序键（稳定、确定性，便于审计）：

1. 扩展名 `.dsppet` 优先于 `.zip`。
2. `name` 与仓库名相似的优先（去分隔符后小写包含）。
3. `digest` 非空的优先。
4. `size` 在预算内更大者优先（减少截断概率）。
5. `name` 字典序升序作为最终裁决。

歧义处理：解出多个候选时 `POST /resolve` 全量返回，安装必须显式带 `assetName`；只解出一个时 UI 可一键装。不做「猜一个装上去」。

约定：作者仓库建议资产名 `<packId>-<version>.dsppet`，可选附 `<packId>-<version>.dsppet.sha256`（内容为十六进制 sha256，可带 `sha256:` 前缀与文件名）。

## 4. 三层校验链

| 层 | 来源 | 校验对象 | 失败码 |
| --- | --- | --- | --- |
| L1 容器 | GitHub asset `digest`（`sha256:…`） | 下载的 zip 字节 | `digest-mismatch` |
| L2 内容 | 包内 `checksums.json` | 解包后的每个文件 | `digest-mismatch` |
| L3 结构 | `core/validator` | zip 边界 + `pet.json` + 图集几何 | `zip-*`、`path-traversal`、`file-type-rejected`、`schema-invalid`、`sheet-geometry`、`asset-missing` |

L1 缺失（老 release 或镜像）时，市场仍下载并计算 sha256，把结果写进 ledger，`verified` 标 `container-only` 或 `unverified`，UI 显示来源标记。L2 缺失时 `verified: container-only`。三层全过标 `digest+checksums`。

GitHub 自 2025-06 起在 release 资产上暴露 `digest` 字段（[changelog](https://github.blog/changelog/2025-06-03-releases-now-expose-digests-for-release-assets/)），L1 直接用它，不额外请求。

一致性检查：解析出的 `pet.json.version` 与 `tag` 不一致时不阻断，但候选上标注 `version-vs-tag: mismatch`；`packId` 与仓库名不一致同样标注，因为 `packId` 是唯一身份。

## 5. 下载

| 项 | 值 |
| --- | --- |
| 协议 | 仅 `https` |
| 域名白名单 | `github.com`、`api.github.com`、`objects.githubusercontent.com`、`codeload.github.com`、`raw.githubusercontent.com` |
| 重定向 | 最多 5 跳，每跳重新校验域名，越界 `download-failed` |
| 连接超时 | 10 秒 |
| 空闲超时 | 30 秒无字节 |
| 总超时 | 180 秒 |
| 字节上限 | 20 MB（与包预算一致），超出 `asset-too-large` |
| 重试 | 网络错误 3 次，指数退避 0.5/1/2 秒，带 `If-Range` 从头重下 |
| 并发 | 全局 1 个下载 |

下载流边写 `tmp/<jobId>/<assetName>` 边算 sha256，写完先比 L1 再解包。`Content-Length` 与 `size` 不一致时以实际字节为准并记日志。

## 6. 限流与缓存

未认证 REST 限流为每 IP 每小时 60 次（[文档](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)），认证后 5000 次。市场把请求压到最低：

| 缓存 | 键 | TTL | 失效 |
| --- | --- | --- | --- |
| release JSON | `sha1(owner/repo#stable\|prerelease)` | 15 分钟 | `ETag` 条件请求得 304 则续期 |
| 单 tag release | `sha1(owner/repo@tag)` | 24 小时 | tag 不可变，长缓存 |
| 仓库元数据 | `sha1(owner/repo)` | 60 分钟 | 同上 |
| 目录索引 | `sha1(indexUrl)` | 30 分钟 | 同上 |
| 包内 `pet.json` 元数据 | `sha1(asset digest)` | 永久 | 内容寻址 |
| 候选预览 | `previewId` | 15 分钟 | 到期清理 |

限流响应（403/429 且 `x-ratelimit-remaining: 0`）映射为 `github-rate-limited`，`details.retryAt` 取 `x-ratelimit-reset`，UI 显示「HH:mm 后可重试」。可选配置 `githubTokenRef` 指向 DSH 的密钥项，用认证额度；token 只出现在 Host 半的请求头，日志与错误里打码为 `ghp_***`。

一次安装的 API 消耗：`resolve` 1 次（缓存命中 0），`install` 0 次（候选里已带 URL），`updates/check` 每包 1 次（缓存命中 0）。默认安装后 30 秒与每 6 小时各一轮检查，10 只宠物一天约 40 次请求，留在未认证额度内。

## 7. 离线与降级

1. 所有网络调用失败时先用缓存：release JSON、目录索引、已安装记录里的 `manifest` 快照。
2. 目录页在离线时展示缓存条目并标 `cached at <时间>`；安装按钮置灰，附 `offline-no-cache` 或具体网络码。
3. 已安装宠物的列表、启用/禁用/卸载/回滚全部离线可用（只碰本地磁盘与宿主）。
4. 预览：缓存里已有该包则照常预览；否则显示 `market.json` 里的缩略图（若曾在目录里见过）。

## 8. 更新

`POST /updates/check` 对每个 `state: installed|disabled` 且 `pinned: false` 的记录做一次 `resolve`（走缓存），得到候选后比较：

| 情况 | 判定 | UI |
| --- | --- | --- |
| `semver(candidate) > semver(installed)` | 有更新 | 「更新到 x.y.z」 |
| `semver` 相等且 `sha256` 相同 | 无变化 | 无标记 |
| `semver` 相等且 `sha256` 不同 | 内容被替换 | 「同版本内容变化」，需确认后按替换安装 |
| `semver(candidate) < semver(installed)` | 降级 | 默认折叠，`downgrade-blocked` 直到用户在详情里显式允许 |
| 候选 `prerelease` 且记录 `channel: stable` | 跳过 | 只在频道切到 `prerelease` 后出现 |

安装更新走同一个 `install` 用例：新版本先落到 `packs/<packId>/<newVersion>/`，成功后注册并激活，旧版本目录保留为 `previous`。注册失败时旧版本重新激活，新目录保留待重试。

频道是来源级设置：`stable` 用 `releases/latest`，`prerelease` 用 `releases` 列表首个。`pin: true` 的记录不参与检查，也不被「全部更新」覆盖。

## 9. 回滚

`POST /installed/:packId/rollback`：

1. 读 `ledger.records[packId].previous`，目录必须存在且 `pet.json` 可读，否则 `version-invalid`。
2. `register` 旧版本 → `activate`。
3. 成功则交换 `version` 与 `previous`，`state` 回到 `installed`，`activatedAt` 刷新。
4. 失败则恢复原激活版本，返回 `runtime-rejected` 并附宿主原始错误。

回滚不做网络请求，也不重新校验哈希（安装时已校验，目录只读）。

## 10. 冲突与替换

| 情况 | 行为 |
| --- | --- |
| `packId` 已安装，来自同一 `sourceRef` | 视为升级或重装，正常走 install |
| `packId` 已安装，来自不同 `sourceRef` | `pack-id-conflict`，`details.existing` 给现有来源；UI 提供「替换」——先卸装再装，ledger 记新来源 |
| 两个目录条目声明同一 `packId` | 目录合并时保留 `sourcePriority` 高者，另一个在详情里列出「同 id 的另一来源」 |
| 已安装目录被外部删除 | 启动扫描发现目录缺失，标 `broken`，提供「重新安装」 |

## 11. 单仓库多包（v1.1 候选）

一个仓库的 release 里可以挂多个 `.dsppet`，市场把每个资产当一个包，`resolve` 返回多候选。v1 已支持多候选选择，只是不做「一次装多个」。目录条目用 `assetPattern`（glob）指定资产，如 `pixel-cat-*.dsppet`。

## 12. 目录索引仓库

`dsh-pet-index` 是纯静态仓库，`index.json` 由 PR 维护，GitHub Pages 或 `raw.githubusercontent.com` 直出。市场默认预置该 URL 为第一个来源（可删）。

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-20T00:00:00Z",
  "entries": [
    {
      "packId": "pixel-cat",
      "repo": "OWNER/pixel-cat",
      "assetPattern": "*.dsppet",
      "name": { "zh": "像素猫", "en": "Pixel Cat" },
      "summary": { "zh": "128px 四行动画" },
      "tags": ["cat", "pixel"],
      "previewUrl": "https://raw.githubusercontent.com/OWNER/pixel-cat/main/thumbnail.webp",
      "license": "MIT",
      "addedAt": "2026-09-01"
    }
  ]
}
```

合并规则：按 `packId` 去重；用户自己添加的来源优先于索引来源；索引条目只提供发现，安装仍走该条目 `repo` 的 release，`packId`/`version` 最终以包内 `pet.json` 为准。索引条目的 `name`/`summary` 仅作列表展示，安装后以包内元数据覆盖。

目录条目校验：`repo` 合法、`assetPattern` ≤ 64 字符、`name`/`summary` 长度受限、`previewUrl` 域名在白名单（`raw.githubusercontent.com`、`github.com`）。单条不合法只跳过该条并记日志，不整体失败。

## 13. 失败表

| 码 | 触发 | 用户可见动作 |
| --- | --- | --- |
| `source-invalid` | 输入形态不认 | 展示可接受形态示例 |
| `source-duplicate` | 同一 `sourceRef` 已在来源列表 | 聚焦已有项并刷新 |
| `github-unauthorized` | token 失效 | 提示重新配置 `githubTokenRef` |
| `github-rate-limited` | 额度用尽 | 显示重置时间，可加 token |
| `github-not-found` | 仓库不存在或私有 | 检查链接与仓库可见性 |
| `release-not-found` | 无 release，或指定 tag 不存在 | 提示先发 release |
| `asset-not-found` | release 里无符合命名规则的资产 | 列出扫到的资产名与判定原因 |
| `asset-too-large` | 资产超 20 MB | 提示拆包或压缩图集 |
| `digest-mismatch` | L1 或 L2 不符 | 建议重新发布资产 |
| `download-failed` | 网络、超时、重定向越界 | 重试 |
| `zip-invalid` / `zip-bomb` / `path-traversal` | 容器不合法 | 指向打包脚本 |
| `file-type-rejected` | 出现白名单外文件 | 列出首个越界文件 |
| `schema-invalid` | 字段缺失或类型错 | 展示 `details.field` |
| `profile-unsupported` | 非 `sprite-sequence/v1` | 说明 v1 支持范围 |
| `engines-mismatch` | 宿主契约版本不满足 | 显示所需与现有版本 |
| `asset-missing` | 引用文件不存在 | 展示缺失路径 |
| `sheet-geometry` | 图集与 `frame`/`grid` 不整除 | 展示推导出的 `cols`/`rows` |
| `image-format-unsupported` | 图集非 PNG/WebP | 提示转换 |
| `pack-id-conflict` | id 已被其它来源占用 | 提供替换 |
| `version-invalid` | 版本号格式不符或回滚目标缺失 | 展示合法版本列表 |
| `downgrade-blocked` | 目标版本低于已装 | 需显式确认 |
| `runtime-unavailable` | 宠物宿主缺席 | 提示安装/启用宿主 |
| `runtime-rejected` | 宿主拒绝注册 | 展示宿主原始错误 |
| `pack-not-found` | 操作对象不存在 | 刷新列表 |
| `disk-error` | 写入失败 | 检查磁盘与权限 |
| `storage-degraded` | 数据根降级 | 顶部常驻提示 |
| `job-canceled` / `job-failed` | 作业终态 | 可重试 |
| `offline-no-cache` | 离线且无缓存 | 联网后重试 |
| `job-not-found` | jobId 失效（重启后） | 刷新任务列表 |

## 14. 安全约束

1. 只发 `https`，只连白名单域名，重定向逐跳校验。
2. 包当纯数据：校验器按扩展名白名单放行，任何可执行类型直接 `file-type-rejected`。包的运行方式是宿主按 [PACK-FORMAT.md](PACK-FORMAT.md) 解析动画数据，包内不存在可执行入口。
3. 解包逐条校验路径：拒绝 `..`、绝对路径、盘符、NUL、Windows 保留名（`CON`、`PRN`、`AUX`、`NUL`、`COM1..9`、`LPT1..9`）、大小写冲突。
4. 解包全部落在 `tmp/<jobId>/`，校验通过才 `rename` 到 `packs/`；跨目录只走 `FsPort`。
5. 素材响应固定 `Content-Type` 白名单 + `nosniff`，SVG 只以 `<img>` 形态使用。
6. token 只在 Host 半使用；日志、错误、ledger、SSE 载荷都不出现明文。


## 认证与限额

owner/repo 走 GitHub REST 时，进程环境里存在 GITHUB_TOKEN（或 GH_TOKEN）就会带上 Authorization: Bearer，限额从 60 次/小时升到 5000 次/小时；该头只发给 pi.github.com，预签名的资产下载地址与 github.com/.../releases/download/... 都不带。owner/repo#asset 用来在一个 release 里指定具体资产。

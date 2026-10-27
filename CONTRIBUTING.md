# 参与这个项目

三条路，都欢迎：报 bug、做宠物、改代码。

## 报 bug

开 issue 时带上这些，能省一轮来回：

1. `http://127.0.0.1:<port>/petmarket/api/health` 的返回（端口在 DSH 窗口地址或启动日志里）。
2. `<root>/stage/stage.log` 的最后 30 行（`<root>` 通常是 `%USERPROFILE%\.dsh\petmarket`）。
3. 面板里复现的那一步：装包 / 出场 / 拖动 / 右键 / 改名 / 详情页。
4. 你的 Windows 版本与缩放比例（右键桌面 → 显示设置）。

## 做一只宠物

完整格式在 [docs/PACK-FORMAT.md](docs/PACK-FORMAT.md)。最小闭环：

```bash
# 1. 建包目录（可以直接复制 demo/packs/pixel-cat 改）
mkdir -p my-pet/animations

# 2. 准备图集：单帧 40x34，横向排帧，行 = 动作
#    row 0 = idle，row 1 = walk，row 2 = run（行号随你，写进 pet.json 即可）

# 3. 写 pet.json / manifest.json / market.json / thumbnail.png

# 4. 打包 + 自校验
node demo/build-demo-pack.mjs   # 换成你自己的目录，或直接调用 demo/pack-lib.mjs 的 buildPack()

# 5. 发 release：tag v1.0.0，把 my-pet-1.0.0.dsppet 附上去
```

要点：

- `id` 全局唯一、小写（`^[a-z0-9][a-z0-9._-]{1,63}$`），升级改 `version`，`id` 不动。
- 素材原生朝左就把 `renderer.front` 写成 `"left"`，画家会自己镜像，别在美术里翻两遍。
- 打包时固定时间戳（见 `demo/pack-lib.mjs` 的 `dosTime`），否则同一份源每次 sha256 都变，`digest-mismatch` 会拦。
- 体积预算：单包 ≤ 20 MB，解压 ≤ 80 MB，单帧 ≤ 512 px，全包 ≤ 512 帧。超了校验器会在装之前就拦下并给错误码。
- 包里永远只有数据：市场不会执行你的 JS，也不会替你审核内容——版权与分级写在包里的 `LICENSE.txt`。

想让别人能搜到：在 issue 里贴仓库链接 + release 链接 + 一张缩略图。我们只核对「格式对不对、能不能跑」，不看内容风格。

## 改代码

```bash
node test/run.mjs        # 23 项，零依赖，秒级
node --check client.js   # 客户端是单文件、无构建
```

约定：

- `lib/` 里放纯函数与端口实现，`index.js` 只做装配，`client.js` 只走 `/petmarket/api/*` 与 SSE。
- 新字段先加进 `lib/pack.js` 的校验器，再让画家/面板读；未知字段透传，不删。
- 画家里所有事件回调都包 `try/catch` 并写 `stage.log`——一个像素画错不该带走整只宠物。
- 提交信息用中文一句话说清「改了什么、为什么」，附带受影响的端或字段。

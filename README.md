# 繁简转换复制

一个极简的 Chrome 扩展：在任意网页里选中文字，右键选择「复制为台湾繁体」，文字会被转换并写入剪贴板，页面右下角浮现一条轻提示。

转换引擎是 [opencc-js](https://github.com/nk2028/opencc-js) 1.4.2 的本地词典包，全部在本机完成，不联网、不上传任何文本。

## 功能

- 右键菜单里只有一项 **复制为台湾繁体**，直接平铺显示、点一下即完成，不需要再进二级菜单。
- 只做字形转换，不替换地区用词：`鼠标 → 鼠標`、`内存 → 內存`。
- 支持普通网页文本、iframe 内的文本、`input` / `textarea` 里的选区，长选区不会被截断。
- 复制成功后右下角显示「已转换为台湾繁体并复制」，约 1.2 秒自动消失；文本已经是台湾繁体时提示「已是台湾繁体，已复制」，复制失败时提示「复制失败，请重试」。
- 写剪贴板由扩展自己的 **offscreen 文档**完成，不经过网页，因此不受站点 `copy` 事件拦截、也不受页面 `clipboard-write` 权限策略影响；浏览器内部页、扩展商店、PDF 阅读器同样能复制，只是没有提示。
- 无弹窗、无选项页、无工具栏按钮，安装即用；没有任何 `host_permissions`。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本目录（含 `manifest.json` 的那一层）。
3. 建议把扩展固定到工具栏，方便查看权限。

`vendor/opencc.full.js` 与 `icons/*.png` 已随仓库生成，开箱即可加载，不需要构建。

## 打包与分发

```bash
npm run pack       # 生成 dist/opencc-js-convert-copy-v1.0.0.zip
npm run pack:crx   # 生成 dist/opencc-js-convert-copy-v1.0.0.crx（CRX3 签名）
npm run release    # 同步词典 + 生成图标 + 自测 + ZIP + CRX
```

两个包都只含运行时文件（`manifest.json`、`background.js`、`offscreen.*`、`icons/`、`vendor/`、`README.md`），manifest 位于根目录，因此 ZIP 也可直接作为 Chrome Web Store 的上传包。

三种分发方式：

| 方式 | 对方要做什么 | 适用场景 |
| --- | --- | --- |
| 上架 Chrome Web Store | 打开商店页面点「添加至 Chrome」 | 公开分发；需注册开发者账号（一次性 $5）并过审 |
| 分发 `.crx` | 拖到 `chrome://extensions`（需开发者模式） | 自用/内网，一次拖入即装 |
| 分发 ZIP 包 | 解压 → `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 | 团队/朋友分发，最稳，不受 `.crx` 拦截策略影响 |

### 安装 `.crx`

1. `chrome://extensions` → 右上角开启「开发者模式」。
2. 把 `dist/opencc-js-convert-copy-v1.0.0.crx` 拖进页面 → 弹窗点「添加扩展程序」。

扩展 ID：`gkdfihakfemdgagdocciieaalfpdalca`，由 `dist/opencc-js-convert-copy.pem` 决定。重新打包会复用已有 `.pem`，所以 ID 保持不变——**升级同 ID 扩展必须用同一个私钥**，请离线备份 `.pem`，丢了就只能换 ID。

注意事项：

- 本仓库的 `.crx` 由脚本按 CRX3 规范生成（`Cr24` + protobuf 头 + RSA-SHA256 签名，签名内容为 `CRX3 SignedData\0` + 头部长度 + `signed_header_data` + ZIP），打包时自校验签名与内嵌 ZIP。
- Chrome 对非商店来源的 `.crx` 有拦截策略：开发者模式下拖入通常可安装，部分版本或企业策略会直接拒绝；被拒时改用 ZIP，或用企业策略 `ExtensionInstallForcelist` 下发（其中的扩展 ID 即上面的 32 位字符串）。
- `.crx` 的扩展 ID 与 ZIP 解压安装得到的 ID 不同（后者由路径推导）。两者功能相同，但不能互相覆盖升级。

## 使用

1. 在网页中选中一段文字。
2. 右键 →「复制为台湾繁体」（直接出现在右键菜单里，无需展开子菜单）。
3. 直接 `Ctrl+V` 粘贴，右下角会看到复制成功的提示。

## 切换用词风格

默认只转字形。若想要台湾/香港用语（`鼠标 → 滑鼠`、`软件 → 軟體`），修改 `background.js` 顶部的 `MENUS` 即可，只需要改 `from` / `to`：

| 需求 | `from` → `to` |
| --- | --- |
| 仅字形（默认） | `cn` → `tw` |
| 台湾用语 | `cn` → `twp` |
| 香港用语 | `cn` → `hk` |
| 需要「繁 → 简」 | 往 `MENUS` 里追加一项 `tw` → `cn` |

> 目前只注册一项菜单，右键时直接显示。追加第二项后 Chrome 会把它们并排放在同一层级，仍然不需要二级菜单。

改完在 `chrome://extensions` 里点该扩展的刷新按钮生效。

`opencc-js` 支持的取值：`cn`、`tw`、`twp`、`hk`、`hkp`、`t`、`jp`。

## 目录结构

```
manifest.json          MV3 清单：权限、经典 Service Worker、图标、最低 Chrome 116
background.js          右键菜单注册、opencc 加载与转换、选区读取、offscreen 复制、页面提示注入
offscreen.html/js      offscreen 文档：复制主路径（textarea + execCommand）
vendor/opencc.full.js  opencc-js 1.4.2 UMD 全量包（脚本生成，勿手改）
icons/                 16/32/48/128 图标（脚本生成）
scripts/
  sync-opencc.js       把 opencc-js 的 UMD 包复制/下载为 vendor/opencc.full.js
  make-icons.js        零依赖绘制图标（zlib 手写 PNG）
  verify.js            命令行自测：清单完整性 + 真实词典转换断言
  pack.js              打 ZIP 分发包（仅运行时文件）
  pack-crx.js          打 CRX3 签名包，并生成/复用 .pem 私钥
  lib/zip.js           ZIP 编码（两个打包脚本共用）
  lib/runtime-files.js 运行时文件清单
dist/                  打包产物：.zip / .crx / .pem（不参与加载）
```

## 开发脚本

```bash
npm run build        # 同步词典 + 生成图标 + 自测（一条命令跑完）
npm run pack         # 打 dist/<name>-v<version>.zip
npm run pack:crx     # 打 dist/<name>-v<version>.crx（复用已有 .pem）
npm run release      # build + pack + pack:crx
npm run sync:opencc  # 仅同步 vendor/opencc.full.js（无 node_modules 时从 jsDelivr 下载）
npm run icons        # 仅重新生成图标
npm test             # 仅自测
```

`npm run sync:opencc` 会优先读取 `node_modules/opencc-js/dist/umd/full.js`（先 `npm install`），没有则从 CDN 下载同一版本。

## 手动验证清单

浏览器内的右键流程无法自动化，请在 Chrome 中逐项确认：

1. 选中普通段落，右键直接出现「复制为台湾繁体」（与系统菜单项同一层级，无需展开子菜单）；不选中文字时该项不出现。
2. 选中「汉字转换测试」，执行该项，粘贴得到 `漢字轉換測試`，右下角出现提示。
3. 选中已经是繁体的「漢字轉換測試」，执行该项，粘贴内容不变，提示「已是台湾繁体，已复制」。
4. 在 `textarea` 里选中文字后执行转换，粘贴结果正确，提示正常。
5. 在 iframe 内的文字上执行转换，粘贴结果正确，提示出现在页面右下角（而不是小窗口内）。
6. 选中超过 2000 字的长文转换，粘贴内容完整未截断。
7. 打开 `chrome://version`（无法注入脚本的页面），选中文字右键执行转换，剪贴板内容正确（此场景无提示）。
8. 在会拦截复制的站点（如多数内容站、文库站）上执行转换，粘贴内容为转换结果而不是上次剪贴板内容。

## 故障排查

**现象：右键有菜单，但粘贴出来还是旧内容 / 没有提示**

1. 到 `chrome://extensions` 确认本扩展版本是 **1.1.0** 以上；改了代码后必须点该扩展卡片上的刷新按钮重新加载。
2. 点该扩展的「检查视图 Service Worker」链接，打开控制台，重现一次操作，看日志：
   - `[繁简转换] 台湾繁体：12 字 → 已复制`：复制成功（若无提示，说明页面禁止注入脚本，属正常）。
   - `[繁简转换] offscreen 复制未成功：写入失败`：offscreen 写入被拒，检查 `offscreen` / `clipboardWrite` 权限是否完整、`manifest.json` 是否被改动。
   - `[繁简转换] 词典预加载失败`：`vendor/opencc.full.js` 缺失或损坏，执行 `npm run sync:opencc` 后重新加载。
   - 完全没有日志：菜单点击没有触发处理，通常是扩展没重新加载或该页面属于受限页面。
3. 提示条显示「复制失败，请重试」时，说明两条复制路径都没成功，请把上面控制台里的 `[繁简转换]` 日志发出来。

**为什么不在网页里直接复制**：页面注入的 `document.execCommand("copy")` 会因用户激活丢失而“返回 true 但没真正写入”，且站点可以拦截 `copy` 事件，所以复制统一放在扩展的 offscreen 文档里执行（`textarea.select()` + `execCommand("copy")`）。

## 已知限制

- 只复制，不修改网页原文。
- 不处理标点符号的地区差异（如 `「」` 与 `“”`）。
- 仅字形转换不做分词级用词替换，`软件` 转成 `軟件` 而非 `軟體`（可按上文「切换用词风格」修改）。
- 需要 Chrome 116+（offscreen 的 `runtime.getContexts`）。
- 与所有依赖 `activeTab` 的扩展一样，首次在某个页面使用时才获得该页面的脚本注入权限。

## 隐私

扩展不申请网络权限，代码中没有任何远程请求。选中的文字只在页面、Service Worker 与本地词典之间流转，不会离开本机。

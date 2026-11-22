#!/usr/bin/env node
/**
 * 生成可直接分发的扩展压缩包：dist/<name>-v<version>.zip
 *
 * 只打包运行时需要的文件（不放 scripts/、node_modules/、dist/ 本身），
 * 解压后即可在 chrome://extensions 里「加载已解压的扩展程序」，
 * 也可以直接作为 Chrome Web Store 的上传包。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { ROOT, collectRuntimeEntries } = require("./lib/runtime-files");
const { createZip } = require("./lib/zip");

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const baseName = pkg.name || "extension";

  const entries = collectRuntimeEntries();
  const zip = createZip(entries);

  const distDir = path.join(ROOT, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const target = path.join(distDir, `${baseName}-v${manifest.version}.zip`);
  fs.writeFileSync(target, zip);

  for (const entry of entries) {
    console.log(`  + ${entry.name}（${(entry.data.length / 1024).toFixed(1)} KB）`);
  }
  console.log(`\n已生成 dist/${path.basename(target)}（${(zip.length / 1024).toFixed(1)} KB，${entries.length} 个文件）`);
  console.log("安装：解压后在 chrome://extensions 打开开发者模式 → 加载已解压的扩展程序 → 选择解压目录。");
}

try {
  main();
} catch (error) {
  console.error(`[pack] ${error.message}`);
  process.exit(1);
}

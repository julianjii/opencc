#!/usr/bin/env node
/**
 * 把 opencc-js 的 UMD 全量包复制到 vendor/opencc.full.js。
 *
 * 扩展运行时不依赖 node_modules，也不允许远程代码（MV3 要求），
 * 所以词典必须以本地文件形式随扩展一起分发。
 *
 * 优先使用 node_modules 中的文件；未执行过 npm install 时，
 * 自动从 jsDelivr 下载同一版本（仅开发期需要一次网络，产物无需联网）。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const ROOT = path.join(__dirname, "..");
const TARGET = path.join(ROOT, "vendor", "opencc.full.js");
const MIN_BYTES = 200 * 1024;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = String(pkg.devDependencies["opencc-js"] || "").replace(/^[^\d]*/, "");
if (!version) throw new Error("package.json 中缺少 opencc-js 版本号");

const localSource = path.join(ROOT, "node_modules", "opencc-js", "dist", "umd", "full.js");
const remoteSource = `https://cdn.jsdelivr.net/npm/opencc-js@${version}/dist/umd/full.js`;

const banner = [
  "/*!",
  ` * opencc-js v${version} — dist/umd/full.js (UMD, 词典已内置)`,
  " * 由 scripts/sync-opencc.js 自动生成，请勿手工修改。",
  ` * 来源: ${remoteSource}`,
  " * 许可证: Apache-2.0 (见 https://github.com/nk2028/opencc-js)",
  " */",
  "",
].join("\n");

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 60000 }, (res) => {
      const { statusCode = 0, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects < 5) {
        res.resume();
        resolve(download(new URL(headers.location, url).toString(), redirects + 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`下载失败: HTTP ${statusCode} ${url}`));
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error(`下载超时: ${url}`)));
    request.on("error", reject);
  });
}

async function main() {
  let source = null;
  let origin = "";

  if (fs.existsSync(localSource)) {
    source = fs.readFileSync(localSource);
    origin = path.relative(ROOT, localSource);
  } else {
    console.log(`未找到 node_modules 中的 opencc-js，改从 CDN 下载 v${version} ...`);
    source = await download(remoteSource);
    origin = remoteSource;
  }

  if (source.length < MIN_BYTES) {
    throw new Error(`词典文件异常（${source.length} 字节），拒绝写入`);
  }

  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, Buffer.concat([Buffer.from(banner, "utf8"), source]));

  const sizeKB = (source.length / 1024).toFixed(1);
  console.log(`已生成 vendor/opencc.full.js（${sizeKB} KB，来源 ${origin}）`);
}

main().catch((error) => {
  console.error(`[sync-opencc] ${error.message}`);
  process.exit(1);
});

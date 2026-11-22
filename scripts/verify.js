#!/usr/bin/env node
/**
 * 命令行自测（无需浏览器）：
 *  1. 校验 manifest 字段、必需文件、图标尺寸；
 *  2. 语法解析所有脚本；
 *  3. 用 vendor 中的真实词典断言繁简转换结果（防止误切成 twp/hk 用语转换）。
 *
 * 浏览器内的右键菜单流程无法自动化，需按 README 手动验证。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readBuffer(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function pngSize(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function loadOpenCC() {
  const source = readText("vendor/opencc.full.js");
  const mod = { exports: {} };
  new Function("module", "exports", source)(mod, mod.exports);
  return mod.exports;
}

console.log("检查清单与文件 ...");

const manifest = JSON.parse(readText("manifest.json"));
check("manifest_version 为 3", manifest.manifest_version === 3);
check("使用经典 Service Worker（可 importScripts）", manifest.background && manifest.background.service_worker === "background.js" && !manifest.background.type);

const permissions = manifest.permissions || [];
for (const permission of ["contextMenus", "scripting", "activeTab", "clipboardWrite", "offscreen"]) {
  check(`声明 ${permission} 权限`, permissions.includes(permission));
}
check("未申请 host_permissions（最小权限）", !manifest.host_permissions || manifest.host_permissions.length === 0);
check("声明最低 Chrome 版本 116（offscreen getContexts）", Number(manifest.minimum_chrome_version) >= 116);

for (const file of ["background.js", "offscreen.html", "offscreen.js", "vendor/opencc.full.js", "README.md"]) {
  check(`存在 ${file}`, fs.existsSync(path.join(ROOT, file)));
}

for (const size of [16, 32, 48, 128]) {
  const file = `icons/icon${size}.png`;
  const filePath = path.join(ROOT, file);
  if (!fs.existsSync(filePath)) {
    check(`存在 ${file}`, false);
    continue;
  }
  const info = pngSize(readBuffer(file));
  check(`${file} 为 ${size}x${size} PNG`, Boolean(info && info.width === size && info.height === size), info ? `实际 ${info.width}x${info.height}` : "不是有效 PNG");
  check(`manifest 引用 ${file}`, Boolean(manifest.icons && manifest.icons[String(size)] === file));
}

check("offscreen.html 引入 offscreen.js", readText("offscreen.html").includes("offscreen.js"));

const vendorSize = fs.statSync(path.join(ROOT, "vendor/opencc.full.js")).size;
check("词典文件体积正常（> 200 KB）", vendorSize > 200 * 1024, `${vendorSize} 字节`);

console.log("\n检查脚本语法 ...");

for (const file of [
  "background.js",
  "offscreen.js",
  "scripts/sync-opencc.js",
  "scripts/make-icons.js",
  "scripts/pack.js",
  "scripts/pack-crx.js",
  "scripts/lib/zip.js",
  "scripts/lib/runtime-files.js",
  "scripts/verify.js",
]) {
  try {
    new vm.Script(readText(file), { filename: file });
    check(`${file} 语法正确`, true);
  } catch (error) {
    check(`${file} 语法正确`, false, error.message);
  }
}

const background = readText("background.js");
const menuIds = background.match(/id: "convert-to-[a-z]+"/g) || [];
check("右键菜单只注册一项（直接显示，无二级选择）", menuIds.length === 1, menuIds.join(", "));
check("菜单项为简化→繁体", menuIds[0] === 'id: "convert-to-traditional"');
check("菜单标题为「转换繁体并复制」", background.includes('title: "转换繁体并复制"'));
check("菜单仅在选区场景显示", background.includes('contexts: ["selection"]'));
check("默认预设为仅字形转换（cn → tw）", background.includes('from: "cn",\n    to: "tw"'));
check("复制优先走 offscreen（规避站点 copy 拦截）", background.includes("copyViaOffscreen(text)"));
check("页面注入复制保留为兜底", background.includes("copyViaPage(tabId, text)"));
check("提示与复制解耦（失败也会提示）", background.includes("showToastInPage"));

const offscreen = readText("offscreen.js");
check("offscreen 使用 execCommand 写剪贴板", offscreen.includes('document.execCommand("copy")'));
check("offscreen 回传复制结果", offscreen.includes("sendResponse({ ok:"));
check("offscreen 复用常驻 textarea 缓冲区", readText("offscreen.html").includes("clipboard-buffer"));

console.log("\n检查转换结果（使用 vendor 真实词典）...");

let OpenCC = null;
try {
  OpenCC = loadOpenCC();
} catch (error) {
  check("加载 vendor/opencc.full.js", false, error.message);
}

if (OpenCC) {
  check("导出 OpenCC.Converter", typeof OpenCC.Converter === "function");

  const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });
  const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

  const simplified = "汉字转换测试，鼠标和内存";
  const traditional = "漢字轉換測試，鼠標和內存";

  check("简体 → 繁体", toTraditional(simplified) === traditional, toTraditional(simplified));
  check("繁体 → 简体", toSimplified(traditional) === simplified, toSimplified(traditional));
  check("转换可逆", toSimplified(toTraditional(simplified)) === simplified);
  check("仅字形：软件 → 軟件（非 軟體）", toTraditional("软件") === "軟件", toTraditional("软件"));
  check("仅字形：記憶體 → 记忆体（非 内存）", toSimplified("記憶體") === "记忆体", toSimplified("記憶體"));

  const longText = "汉字转换测试。".repeat(400);
  const longResult = toTraditional(longText);
  check("长文本（2400 字符）可完整转换", longResult.length >= 1200 && longResult.startsWith("漢字轉換測試。"), `输出 ${longResult.length} 字符`);
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);

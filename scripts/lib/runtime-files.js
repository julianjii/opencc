#!/usr/bin/env node
/**
 * 扩展运行时文件清单：ZIP / CRX 打包共用，避免两个脚本的清单不一致。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

const ROOT_FILES = ["manifest.json", "background.js", "offscreen.html", "offscreen.js", "README.md"];
const DIR_FILES = [
  ["icons", ["icon16.png", "icon32.png", "icon48.png", "icon128.png"]],
  ["vendor", ["opencc.full.js"]],
];

/** @returns {{name: string, data: Buffer}[]} */
function collectRuntimeEntries() {
  const entries = [];

  for (const file of ROOT_FILES) {
    const fullPath = path.join(ROOT, file);
    if (!fs.existsSync(fullPath)) throw new Error(`缺少必需文件：${file}`);
    entries.push({ name: file, data: fs.readFileSync(fullPath) });
  }

  for (const [dir, files] of DIR_FILES) {
    for (const file of files) {
      const fullPath = path.join(ROOT, dir, file);
      if (!fs.existsSync(fullPath)) throw new Error(`缺少必需文件：${dir}/${file}`);
      entries.push({ name: `${dir}/${file}`, data: fs.readFileSync(fullPath) });
    }
  }

  return entries;
}

module.exports = { ROOT, ROOT_FILES, DIR_FILES, collectRuntimeEntries };

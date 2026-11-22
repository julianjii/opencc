#!/usr/bin/env node
/**
 * 生成扩展图标（16/32/48/128 PNG）。
 *
 * 零第三方依赖：手写 PNG 编码（zlib + CRC32），
 * 图形为「蓝紫渐变圆角方块 + 白色双向箭头」，4x 超采样抗锯齿。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT_DIR = path.join(__dirname, "..", "icons");
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

const TOP_COLOR = [56, 132, 255];
const BOTTOM_COLOR = [124, 58, 237];

// 背景圆角方块（归一化坐标）
const BG = { x0: 0.04, y0: 0.04, x1: 0.96, y1: 0.96, r: 0.235 };

// 上箭头指向右：横杆 + 三角箭头
const BAR_TOP = { x0: 0.215, y0: 0.345, x1: 0.59, y1: 0.435 };
const HEAD_TOP = [
  [0.575, 0.245],
  [0.575, 0.535],
  [0.8, 0.39],
];

// 下箭头指向左：横杆 + 三角箭头
const BAR_BOTTOM = { x0: 0.41, y0: 0.565, x1: 0.785, y1: 0.655 };
const HEAD_BOTTOM = [
  [0.2, 0.61],
  [0.425, 0.465],
  [0.425, 0.755],
];

function insideRoundedRect(x, y, rect) {
  const { x0, y0, x1, y1, r } = rect;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function insideTriangle(x, y, triangle) {
  const [a, b, c] = triangle;
  const d1 = (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
  const d2 = (x - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (y - c[1]);
  const d3 = (x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1]);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function insideGlyph(x, y) {
  return (
    insideRoundedRect(x, y, { ...BAR_TOP, r: 0.045 }) ||
    insideTriangle(x, y, HEAD_TOP) ||
    insideRoundedRect(x, y, { ...BAR_BOTTOM, r: 0.045 }) ||
    insideTriangle(x, y, HEAD_BOTTOM)
  );
}

function lerpColor(t) {
  const k = Math.min(Math.max(t, 0), 1);
  return [
    TOP_COLOR[0] + (BOTTOM_COLOR[0] - TOP_COLOR[0]) * k,
    TOP_COLOR[1] + (BOTTOM_COLOR[1] - TOP_COLOR[1]) * k,
    TOP_COLOR[2] + (BOTTOM_COLOR[2] - TOP_COLOR[2]) * k,
  ];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!insideRoundedRect(x, y, BG)) continue;
          hits += 1;
          if (insideGlyph(x, y)) {
            r += 255;
            g += 255;
            b += 255;
          } else {
            const color = lerpColor((y - BG.y0) / (BG.y1 - BG.y0));
            r += color[0];
            g += color[1];
            b += color[2];
          }
        }
      }

      const offset = (py * size + px) * 4;
      if (hits === 0) continue;
      pixels[offset] = Math.round(r / hits);
      pixels[offset + 1] = Math.round(g / hits);
      pixels[offset + 2] = Math.round(b / hits);
      pixels[offset + 3] = Math.round((hits / samples) * 255);
    }
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log(`已生成 icons/icon${size}.png`);
}

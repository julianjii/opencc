#!/usr/bin/env node
/**
 * 生成 CRX3 格式的扩展包：dist/<name>-v<version>.crx
 *
 * CRX3 结构：magic "Cr24" + uint32(3) + uint32(header 长度) + header + ZIP
 * header 为 protobuf：
 *   field 2    sha256_with_rsa  { public_key(DER/SPKI), signature }
 *   field 10000 signed_header_data { crx_id = sha256(public_key)[0..16] }
 * 签名内容："CRX3 SignedData\0" + uint32LE(signed_header_data 长度) + signed_header_data + ZIP
 *
 * 私钥保存在 dist/<name>.pem：同一个扩展 ID 的更新必须复用同一私钥，
 * 因此脚本检测到已有 .pem 时直接复用（请自行备份，丢失后无法升级同 ID 扩展）。
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT, collectRuntimeEntries } = require("./lib/runtime-files");
const { createZip } = require("./lib/zip");

const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\0", "binary");

/* --------------------------------------------------------------- protobuf */

function encodeVarint(value) {
  const bytes = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function bytesField(fieldNumber, payload) {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload]);
}

/* ------------------------------------------------------------------- 密钥 */

function loadOrCreatePrivateKey(pemPath) {
  if (fs.existsSync(pemPath)) {
    console.log(`复用已有私钥 ${path.basename(pemPath)}（扩展 ID 保持不变）`);
    return crypto.createPrivateKey(fs.readFileSync(pemPath));
  }

  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  fs.writeFileSync(pemPath, privateKey.export({ type: "pkcs8", format: "pem" }));
  console.log(`已生成新私钥 ${path.basename(pemPath)}，请备份：升级扩展必须用同一个私钥`);
  return privateKey;
}

/* ------------------------------------------------------------------ CRX3 */

function buildCrx({ zip, privateKey }) {
  const publicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const crxId = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);

  // SignedData { bytes crx_id = 1; }
  const signedHeaderData = bytesField(1, crxId);

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0);
  const signatureInput = Buffer.concat([SIGNATURE_CONTEXT, lengthPrefix, signedHeaderData, zip]);
  const signature = crypto.sign("sha256", signatureInput, privateKey);

  const keyProof = Buffer.concat([bytesField(1, publicKey), bytesField(2, signature)]);
  const header = Buffer.concat([bytesField(2, keyProof), bytesField(10000, signedHeaderData)]);

  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);

  return { buffer: Buffer.concat([prefix, header, zip]), crxId };
}

/* ------------------------------------------------------- protobuf 回读解析 */

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  for (;;) {
    if (index >= buffer.length) throw new Error("protobuf varint 越界");
    const byte = buffer[index];
    index += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error("protobuf varint 过长");
  }
  return { value, offset: index };
}

/** 解析只含 length-delimited 字段的消息，返回 [{fieldNumber, value}]。 */
function readFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (wireType !== 2) throw new Error(`不支持的 wire type：${wireType}`);
    const length = readVarint(buffer, offset);
    offset = length.offset;
    fields.push({ fieldNumber, value: buffer.subarray(offset, offset + length.value) });
    offset += length.value;
  }
  return fields;
}

function pickField(fields, fieldNumber, name) {
  const field = fields.find((item) => item.fieldNumber === fieldNumber);
  if (!field) throw new Error(`CRX 头缺少字段 ${name}`);
  return field.value;
}

/**
 * 从序列化后的字节回读校验：
 * 结构与版本 → 内嵌 ZIP 与源一致 → 公钥哈希等于 signed_header_data 中的 crx_id → RSA 签名有效。
 * 这样能确认 Chrome 也能解析我们写出的 protobuf 头。
 */
function verifyCrx(crx, zip) {
  if (crx.subarray(0, 4).toString("ascii") !== "Cr24") throw new Error("CRX 魔数不正确");
  if (crx.readUInt32LE(4) !== 3) throw new Error("CRX 版本不是 3");

  const headerLength = crx.readUInt32LE(8);
  const header = crx.subarray(12, 12 + headerLength);
  const embeddedZip = crx.subarray(12 + headerLength);
  if (!embeddedZip.equals(zip)) throw new Error("内嵌 ZIP 与源文件不一致");

  const fields = readFields(header);
  const proof = readFields(pickField(fields, 2, "sha256_with_rsa"));
  const publicKey = pickField(proof, 1, "public_key");
  const signature = pickField(proof, 2, "signature");
  const signedHeaderData = pickField(fields, 10000, "signed_header_data");
  const signedData = readFields(signedHeaderData);
  const crxId = pickField(signedData, 1, "crx_id");

  const expectedCrxId = crypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
  if (!crxId.equals(expectedCrxId)) throw new Error("crx_id 与公钥哈希不匹配");

  const lengthPrefix = Buffer.alloc(4);
  lengthPrefix.writeUInt32LE(signedHeaderData.length, 0);
  const signatureInput = Buffer.concat([SIGNATURE_CONTEXT, lengthPrefix, signedHeaderData, embeddedZip]);

  const keyObject = crypto.createPublicKey({ key: publicKey, format: "der", type: "spki" });
  if (!crypto.verify("sha256", signatureInput, keyObject, signature)) {
    throw new Error("签名校验失败");
  }
}

/** 由 crx_id 推出 Chrome 显示的扩展 ID（每半字节映射到 a-p）。 */
function extensionId(crxId) {
  let id = "";
  for (const byte of crxId) {
    id += String.fromCharCode(97 + (byte >> 4));
    id += String.fromCharCode(97 + (byte & 0x0f));
  }
  return id;
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const baseName = pkg.name || "extension";

  const distDir = path.join(ROOT, "dist");
  fs.mkdirSync(distDir, { recursive: true });

  const zip = createZip(collectRuntimeEntries());
  const privateKey = loadOrCreatePrivateKey(path.join(distDir, `${baseName}.pem`));
  const { buffer, crxId } = buildCrx({ zip, privateKey });

  verifyCrx(buffer, zip);

  const target = path.join(distDir, `${baseName}-v${manifest.version}.crx`);
  fs.writeFileSync(target, buffer);

  console.log(`\n已生成 dist/${path.basename(target)}（${(buffer.length / 1024).toFixed(1)} KB，CRX3 签名已自校验通过）`);
  console.log(`扩展 ID：${extensionId(crxId)}`);
  console.log("安装：chrome://extensions 打开开发者模式 → 把 .crx 拖入页面 → 确认安装。");
}

try {
  main();
} catch (error) {
  console.error(`[pack-crx] ${error.message}`);
  process.exit(1);
}

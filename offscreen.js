/**
 * offscreen 文档：复制的主路径。
 *
 * 必须在扩展页面里写剪贴板，原因有两条：
 *  1. 页面内注入的 document.execCommand("copy") 会因丢失用户激活而“返回 true 但没写入”；
 *  2. navigator.clipboard.writeText 在 offscreen 文档里不可用（文档永不获得焦点），
 *     所以这里只能用 textarea.select() + document.execCommand("copy")。
 */
"use strict";

const buffer = document.getElementById("clipboard-buffer");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen" || message.type !== "copy") return false;

  const text = typeof message.text === "string" ? message.text : "";
  if (writeByExecCommand(text)) {
    sendResponse({ ok: true });
    return false;
  }

  // 理论上走不到这里；保留 Clipboard API 作为极少数环境的兜底。
  navigator.clipboard
    .writeText(text)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.warn(`[繁简转换] offscreen 写入失败：${error && error.message}`);
      sendResponse({ ok: false });
    });

  return true; // 异步响应，保持消息通道
});

function writeByExecCommand(text) {
  if (!text || !buffer) return false;

  buffer.value = text;
  let ok = false;
  try {
    buffer.focus();
    buffer.select();
    buffer.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch (error) {
    ok = false;
  } finally {
    buffer.value = "";
  }

  return ok;
}

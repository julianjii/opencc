/**
 * 繁简转换复制 — MV3 Service Worker（经典脚本，非 module）
 *
 * 流程：右键点击 → 注入读取选区（全 frame，取最长结果）→ opencc 本地词典转换
 *      → 由 offscreen 文档写剪贴板（不受站点 copy 拦截与页面权限策略影响）
 *      → 注入页面显示右下角轻提示；offscreen 不可用时退回页面内复制。
 *
 * 权限说明：脚本注入依靠右键点击授予的 activeTab，因此不申请任何 host_permissions。
 */
"use strict";

/**
 * 右键菜单定义：只注册一项，右键时直接出现在菜单里，不需要再点一层。
 * 默认只做字形转换（鼠标 → 鼠標、内存 → 內存）。
 * 想要台湾/香港用语（鼠标 → 滑鼠、软件 → 軟體），把 to 改成 twp / hk 即可。
 *
 * 需要「繁 → 简」时，往数组里再追加一项即可（id / title 照上面的写法补全），
 * 例如 from: "tw", to: "cn", target: "简体"。
 */
const MENUS = [
  {
    id: "convert-to-traditional",
    title: "复制为台湾繁体",
    from: "cn",
    to: "tw",
    target: "台湾繁体",
  },
];

const OPENCC_FILE = "vendor/opencc.full.js";
const OFFSCREEN_URL = "offscreen.html";
const TOAST_HOST_ID = "__opencc-convert-copy-toast__";
const OFFSCREEN_TIMEOUT_MS = 3000;

/** opencc 词典约 1 MB，在 Service Worker 首次求值时同步加载，之后复用 converter。 */
let openccLoaded = false;
try {
  importScripts(OPENCC_FILE);
  openccLoaded = true;
} catch (error) {
  console.warn(`[繁简转换] 词典预加载失败，将在首次使用时重试：${error && error.message}`);
}

const converters = new Map();

/* ------------------------------------------------------------------ 菜单注册 */

function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    for (const menu of MENUS) {
      chrome.contextMenus.create(
        { id: menu.id, title: menu.title, contexts: ["selection"] },
        () => void chrome.runtime.lastError,
      );
    }
  });
}

// 每次 Service Worker 求值都重建菜单：升级/重载后不会残留旧版本的菜单项。
registerMenus();
chrome.runtime.onInstalled.addListener(registerMenus);
chrome.runtime.onStartup.addListener(registerMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleClick(info, tab).catch((error) => {
    console.warn(`[繁简转换] 处理失败：${error && error.message ? error.message : error}`);
  });
});

/* ---------------------------------------------------------------- 主处理流程 */

async function handleClick(info, tab) {
  const menu = MENUS.find((item) => item.id === info.menuItemId);
  if (!menu || !tab || typeof tab.id !== "number") return;

  const selected = await readSelection(tab.id, info.selectionText);
  const text = selected.trim();
  if (!text) {
    console.warn("[繁简转换] 未读取到选区文本");
    return;
  }

  const converted = convert(menu, text);
  const copied = await copyText(tab.id, converted);
  const message = copied
    ? converted === text
      ? `已是${menu.target}，已复制`
      : `已转换为${menu.target}并复制`
    : "复制失败，请重试";

  console.log(`[繁简转换] ${menu.target}：${text.length} 字 → ${copied ? "已复制" : "复制失败"}`);
  await showToastInPage(tab.id, message);
}

function convert(menu, text) {
  if (!openccLoaded) {
    // 极端情况：首次预加载失败，这里重试一次（同步，不会发起网络请求）。
    importScripts(OPENCC_FILE);
    openccLoaded = true;
  }

  const key = `${menu.from}->${menu.to}`;
  let converter = converters.get(key);
  if (!converter) {
    const api = self.OpenCC;
    if (!api || typeof api.Converter !== "function") {
      throw new Error("opencc 词典未能正确加载");
    }
    converter = api.Converter({ from: menu.from, to: menu.to });
    converters.set(key, converter);
  }

  return converter(text);
}

/* ------------------------------------------------------------------ 读取选区 */

async function readSelection(tabId, fallbackText) {
  const fallback = typeof fallbackText === "string" ? fallbackText : "";

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: readSelectionInPage,
    });

    let longest = "";
    for (const result of results || []) {
      const value = typeof result.result === "string" ? result.result : "";
      if (value.trim().length > longest.trim().length) longest = value;
    }
    if (longest.trim()) return longest;
  } catch (error) {
    console.warn(`[繁简转换] 页面脚本注入失败，改用浏览器选区文本：${error && error.message}`);
  }

  return fallback;
}

/** 在页面隔离世界中执行：读取普通选区，兼顾 input / textarea 内的选区。 */
function readSelectionInPage() {
  let text = "";

  try {
    const selection = window.getSelection();
    if (selection) text = selection.toString();
  } catch (error) {
    text = "";
  }

  if (!text.trim()) {
    try {
      const element = document.activeElement;
      const tag = element && element.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        const start = element.selectionStart;
        const end = element.selectionEnd;
        if (typeof start === "number" && typeof end === "number" && end > start) {
          text = element.value.slice(start, end);
        }
      }
    } catch (error) {
      /* 某些输入框不支持 selectionStart，忽略 */
    }
  }

  return text;
}

/* ------------------------------------------------------------------ 写剪贴板 */

async function copyText(tabId, text) {
  // 首选：扩展自己的 offscreen 文档。属于扩展页面，clipboardWrite 生效，
  // 不会被站点的 copy 事件监听拦截，也不受页面 Permissions-Policy 影响。
  if (await copyViaOffscreen(text)) return true;
  // 兜底：页面内注入复制（站点未拦截时可用）。
  return copyViaPage(tabId, text);
}

async function copyViaPage(tabId, text) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: copyInPage,
      args: [text],
    });
    return Boolean(result && result.result);
  } catch (error) {
    console.warn(`[繁简转换] 页面内复制失败：${error && error.message}`);
    return false;
  }
}

/** 在页面隔离世界中执行：textarea + execCommand，失败再试 Clipboard API。 */
async function copyInPage(text) {
  const copyByExecCommand = () => {
    // 复制用的 textarea 会抢走选区与焦点，先记录、事后再还原。
    const previousActive = document.activeElement;
    const selection = window.getSelection();
    const savedRange =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;

    const element = document.createElement("textarea");
    element.value = text;
    element.setAttribute("readonly", "");
    element.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;margin:0;padding:0;border:0;opacity:0;";
    const host = document.body || document.documentElement;
    if (!host) return false;

    host.appendChild(element);
    let ok = false;
    try {
      element.select();
      element.setSelectionRange(0, text.length);
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    element.remove();

    try {
      if (previousActive && typeof previousActive.focus === "function") {
        previousActive.focus({ preventScroll: true });
      }
    } catch (error) {
      /* 页面元素不允许聚焦时忽略 */
    }
    try {
      if (savedRange && selection) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
      }
    } catch (error) {
      /* 选区已失效时忽略 */
    }

    return ok;
  };

  const copyByClipboardApi = async () => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      return false;
    }
  };

  return copyByExecCommand() || (await copyByClipboardApi());
}

/* ------------------------------------------------------------------ 轻提示 */

async function showToastInPage(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: showToast,
      args: [message, TOAST_HOST_ID],
    });
  } catch (error) {
    // 受限页面（chrome://、扩展商店、PDF）无法注入，复制成功只是没有提示。
    console.warn(`[繁简转换] 无法显示提示：${error && error.message}`);
  }
}

/** 在页面隔离世界中执行：closed Shadow DOM 隔离样式，1.2 秒后自动消失。 */
function showToast(message, toastHostId) {
  const previous = document.getElementById(toastHostId);
  if (previous) previous.remove();

  const wrapper = document.createElement("div");
  wrapper.id = toastHostId;
  wrapper.style.cssText =
    "all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none;";

  const root = wrapper.attachShadow({ mode: "closed" });
  const card = document.createElement("div");
  card.textContent = message;
  card.style.cssText = [
    "box-sizing:border-box",
    "max-width:70vw",
    "font:13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif",
    "color:#f8fafc",
    "background:rgba(24,27,34,.92)",
    "padding:8px 12px",
    "border-radius:10px",
    "box-shadow:0 8px 24px rgba(0,0,0,.28)",
    "white-space:nowrap",
    "overflow:hidden",
    "text-overflow:ellipsis",
    "opacity:0",
    "transform:translateY(8px)",
    "transition:opacity 160ms ease,transform 160ms ease",
  ].join(";");
  root.appendChild(card);
  (document.documentElement || document.body).appendChild(wrapper);

  requestAnimationFrame(() => {
    card.style.opacity = "1";
    card.style.transform = "translateY(0)";
  });

  setTimeout(() => {
    card.style.opacity = "0";
    card.style.transform = "translateY(8px)";
    setTimeout(() => wrapper.remove(), 240);
  }, 1200);
}

/* ------------------------------------------------------- offscreen 剪贴板 */

let offscreenCreating = null;

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, ms);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || typeof chrome.runtime.getContexts !== "function") return false;

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts && contexts.length > 0) return true;

  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["CLIPBOARD"],
        justification: "将转换后的文字写入系统剪贴板",
      })
      .catch((error) => {
        // 并发创建时可能报“已存在”，只要文档在就够了。
        console.warn(`[繁简转换] offscreen 文档创建：${error && error.message}`);
      })
      .finally(() => {
        offscreenCreating = null;
      });
  }

  await offscreenCreating;

  const created = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return Boolean(created && created.length > 0);
}

async function copyViaOffscreen(text) {
  try {
    if (!(await ensureOffscreenDocument())) return false;

    const payload = { target: "offscreen", type: "copy", text };
    const response = await withTimeout(chrome.runtime.sendMessage(payload), OFFSCREEN_TIMEOUT_MS);
    if (response && response.ok) return true;

    // 文档刚创建时消息可能发空，稍等再试一次。
    await new Promise((resolve) => setTimeout(resolve, 120));
    const retry = await withTimeout(chrome.runtime.sendMessage(payload), OFFSCREEN_TIMEOUT_MS);
    if (retry && retry.ok) return true;

    console.warn(`[繁简转换] offscreen 复制未成功：${response ? "写入失败" : "无响应"}`);
    return false;
  } catch (error) {
    console.warn(`[繁简转换] offscreen 复制异常：${error && error.message}`);
    return false;
  }
}

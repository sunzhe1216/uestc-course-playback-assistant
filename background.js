"use strict";

const TARGET_HOST = "resource.uestc.edu.cn";
const COURSE_PATH_PREFIX = "/learn/course/detail/spoc/courseWare/";
const STORAGE_KEY = "settings";
const AUTOPLAY_KEY_PREFIX = "uestcCourseHelper.autoplay.";
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const DEFAULT_SETTINGS = Object.freeze({ speed: 1, autoNext: false });
const AUTOPLAY_GRANT_TTL_MS = 90_000;

// Status is deliberately kept only in memory: it describes the current page,
// not a learning record. The content script refreshes it whenever the page changes.
const statusByTab = new Map();
let settingsWriteQueue = Promise.resolve();

function isTargetUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && parsed.hostname === TARGET_HOST
      && parsed.pathname.startsWith(COURSE_PATH_PREFIX);
  } catch {
    return false;
  }
}

function isTargetSender(sender) {
  return Boolean(sender?.tab && isTargetUrl(sender.tab.url));
}

function isPopupSender(sender) {
  return Boolean(
    !sender?.tab
      && typeof sender?.url === "string"
      && sender.url.startsWith(chrome.runtime.getURL(""))
  );
}

function normaliseSettings(candidate) {
  const requestedSpeed = Number(candidate?.speed);
  return {
    speed: SPEEDS.includes(requestedSpeed) ? requestedSpeed : DEFAULT_SETTINGS.speed,
    autoNext: typeof candidate?.autoNext === "boolean" ? candidate.autoNext : DEFAULT_SETTINGS.autoNext
  };
}

async function readSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normaliseSettings(stored[STORAGE_KEY]);
}

function writeSettings(partialSettings) {
  const write = settingsWriteQueue.then(async () => {
    const previous = await readSettings();
    const next = normaliseSettings({ ...previous, ...partialSettings });
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  });

  // Keep later writes usable even if a previous storage call failed.
  settingsWriteQueue = write.catch(() => {});
  return write;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

async function sendToTopFrame(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // A page can be loading or have no matching content script. The preference
    // is still safely stored and will be applied when the script becomes ready.
    return undefined;
  }
}

function asStatus(payload) {
  if (!payload || typeof payload !== "object") return null;
  const status = payload.status && typeof payload.status === "object" ? payload.status : payload;
  return { ...status, updatedAt: Date.now() };
}

async function broadcastStatus(tabId, status) {
  try {
    await chrome.runtime.sendMessage({ type: "status", tabId, status });
  } catch {
    // No popup may be open; there is nothing to notify.
  }
}

async function getPageState(tab) {
  if (!tab || !isTargetUrl(tab.url)) {
    return { active: false, status: null };
  }

  let status = statusByTab.get(tab.id) ?? null;
  const response = await sendToTopFrame(tab.id, { type: "get-content-status" });
  const liveStatus = asStatus(response);
  if (liveStatus) {
    status = liveStatus;
    statusByTab.set(tab.id, status);
  }

  return { active: true, status };
}

async function handleGetState() {
  const [settings, tab] = await Promise.all([readSettings(), getActiveTab()]);
  const pageState = await getPageState(tab);
  return { settings, tabId: tab?.id ?? null, ...pageState };
}

async function handleUpdateSettings(message) {
  const settings = await writeSettings(message?.settings ?? {});
  const tab = await getActiveTab();

  if (!tab || !isTargetUrl(tab.url)) {
    return { settings, tabId: tab?.id ?? null, active: false, delivered: false, status: null };
  }

  const response = await sendToTopFrame(tab.id, { type: "settings-updated", settings });
  const status = asStatus(response) ?? statusByTab.get(tab.id) ?? null;
  if (status) statusByTab.set(tab.id, status);

  return { settings, tabId: tab.id, active: true, delivered: response !== undefined, status };
}

async function handleIncomingStatus(message, sender) {
  if (!isTargetSender(sender)) return { accepted: false };
  const status = asStatus(message.status);
  if (!status) return { accepted: false };

  statusByTab.set(sender.tab.id, status);
  await broadcastStatus(sender.tab.id, status);
  return { accepted: true };
}

function autoplayStorageKey(tabId) {
  return `${AUTOPLAY_KEY_PREFIX}${tabId}`;
}

async function armAutoplay(sender, message) {
  if (!isTargetSender(sender)) return { armed: false };
  const settings = await readSettings();
  if (!settings.autoNext) return { armed: false, reason: "disabled" };

  const requestedTtl = Number(message?.ttlMs ?? message?.ttl);
  const ttlMs = Number.isFinite(requestedTtl)
    ? Math.min(Math.max(requestedTtl, 5_000), AUTOPLAY_GRANT_TTL_MS)
    : AUTOPLAY_GRANT_TTL_MS;
  const expiresAt = Date.now() + ttlMs;
  const previousSignature = typeof message?.previousSignature === "string"
    ? message.previousSignature
    : null;
  const grantId = typeof message?.grantId === "string" && message.grantId.length > 0
    ? message.grantId
    : null;
  const courseId = typeof message?.courseId === "string" && message.courseId.length > 0
    ? message.courseId
    : null;
  if (!grantId) return { armed: false, reason: "missing-grant-id" };
  await chrome.storage.session.set({
    [autoplayStorageKey(sender.tab.id)]: { expiresAt, previousSignature, grantId, courseId }
  });
  return { armed: true, expiresAt };
}

async function consumeAutoplay(sender, message) {
  if (!isTargetSender(sender)) return { allowed: false };

  const key = autoplayStorageKey(sender.tab.id);
  const stored = await chrome.storage.session.get(key);
  const grant = stored[key];

  const expiresAt = typeof grant === "object" && grant !== null
    ? Number(grant.expiresAt)
    : Number(grant);
  const previousSignature = typeof grant === "object" && grant !== null
    ? grant.previousSignature
    : null;
  const currentSignature = typeof message?.currentSignature === "string"
    ? message.currentSignature
    : null;
  const requestedGrantId = typeof message?.grantId === "string" ? message.grantId : null;
  const storedGrantId = typeof grant === "object" && grant !== null ? grant.grantId : null;
  const requestedCourseId = typeof message?.courseId === "string" && message.courseId.length > 0
    ? message.courseId
    : null;
  const storedCourseId = typeof grant === "object" && grant !== null ? grant.courseId ?? null : null;
  const settings = await readSettings();
  const matchesGrant = Boolean(requestedGrantId) && requestedGrantId === storedGrantId;
  if (matchesGrant) await chrome.storage.session.remove(key);

  return {
    allowed: matchesGrant
      && settings.autoNext
      && Number.isFinite(expiresAt)
      && expiresAt > Date.now()
      && Boolean(previousSignature)
      && Boolean(currentSignature)
      && currentSignature !== previousSignature
      && requestedCourseId === storedCourseId
  };
}

async function clearAutoplay(sender, message) {
  if (!isTargetSender(sender)) return { cleared: false };
  const key = autoplayStorageKey(sender.tab.id);
  const requestedGrantId = typeof message?.grantId === "string" ? message.grantId : null;
  if (!requestedGrantId) {
    await chrome.storage.session.remove(key);
    return { cleared: true };
  }
  const stored = await chrome.storage.session.get(key);
  const grant = stored[key];
  if (typeof grant === "object" && grant !== null && grant.grantId === requestedGrantId) {
    await chrome.storage.session.remove(key);
    return { cleared: true };
  }
  return { cleared: false };
}

async function handleVideoEnded(sender) {
  if (!isTargetSender(sender)) return { started: false, reason: "outside-target" };
  const settings = await readSettings();
  if (!settings.autoNext) return { started: false, reason: "disabled" };

  const response = await sendToTopFrame(sender.tab.id, { type: "begin-countdown" });
  return { started: response !== undefined, response };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return undefined;

  let operation;
  switch (message.type) {
    case "get-state":
      if (!isPopupSender(sender)) return undefined;
      operation = handleGetState();
      break;
    case "update-settings":
      if (!isPopupSender(sender)) return undefined;
      operation = handleUpdateSettings(message);
      break;
    case "status":
      operation = handleIncomingStatus(message, sender);
      break;
    case "video-ended":
      operation = handleVideoEnded(sender);
      break;
    case "arm-autoplay":
      operation = armAutoplay(sender, message);
      break;
    case "consume-autoplay":
      operation = consumeAutoplay(sender, message);
      break;
    case "clear-autoplay":
      operation = clearAutoplay(sender, message);
      break;
    case "settings-changed-locally":
      if (!isTargetSender(sender)) return undefined;
      operation = Promise.resolve({ accepted: true });
      break;
    default:
      return undefined;
  }

  operation
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.warn("成电课程播放助手：消息处理失败", error);
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEY]?.newValue) return;
  const settings = normaliseSettings(changes[STORAGE_KEY].newValue);
  void chrome.runtime.sendMessage({ type: "settings", settings }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" || (changeInfo.url && !isTargetUrl(changeInfo.url))) {
    statusByTab.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  statusByTab.delete(tabId);
  void chrome.storage.session.remove(autoplayStorageKey(tabId));
});

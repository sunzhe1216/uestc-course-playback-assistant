"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const targetUrl = "https://resource.uestc.edu.cn/learn/course/detail/spoc/courseWare/example?id=1";
const localStore = new Map();
const sessionStore = new Map();
const sentToTab = [];
const listeners = {};

const readStore = (store, key) => {
  if (typeof key === "string") return Promise.resolve({ [key]: store.get(key) });
  return Promise.resolve(Object.fromEntries([...store.entries()]));
};

const chrome = {
  storage: {
    local: {
      get: (key) => readStore(localStore, key),
      set: async (value) => {
        for (const [key, next] of Object.entries(value)) {
          const oldValue = localStore.get(key);
          localStore.set(key, next);
          listeners.storageChanged?.({ [key]: { oldValue, newValue: next } }, "local");
        }
      },
    },
    session: {
      get: (key) => readStore(sessionStore, key),
      set: async (value) => {
        for (const [key, next] of Object.entries(value)) sessionStore.set(key, next);
      },
      remove: async (key) => sessionStore.delete(key),
    },
    onChanged: { addListener: (listener) => { listeners.storageChanged = listener; } },
  },
  runtime: {
    getURL: (suffix) => `chrome-extension://test/${suffix}`,
    sendMessage: async () => undefined,
    onMessage: { addListener: (listener) => { listeners.message = listener; } },
    onInstalled: { addListener: (listener) => { listeners.installed = listener; } },
  },
  tabs: {
    query: async () => [{ id: 42, url: targetUrl }],
    sendMessage: async (tabId, message, options) => {
      sentToTab.push({ tabId, message, options });
      if (message.type === "get-content-status") {
        return { ok: true, status: { videoFound: true, message: "mock player" } };
      }
      return { ok: true };
    },
    onUpdated: { addListener: (listener) => { listeners.tabUpdated = listener; } },
    onRemoved: { addListener: (listener) => { listeners.tabRemoved = listener; } },
  },
};

const context = vm.createContext({
  chrome,
  URL,
  Map,
  Promise,
  Date,
  Number,
  Boolean,
  String,
  Object,
  console,
});
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
vm.runInContext(backgroundSource, context, { filename: "background.js" });

function dispatch(message, sender) {
  return new Promise((resolve, reject) => {
    const keepChannelOpen = listeners.message(message, sender, resolve);
    if (keepChannelOpen !== true) reject(new Error(`Message channel was not kept open for ${message.type}.`));
  });
}

const popupSender = { url: "chrome-extension://test/popup.html" };
const courseSender = { tab: { id: 42, url: targetUrl } };

(async () => {
  await listeners.installed();

  const initial = await dispatch({ type: "get-state" }, popupSender);
  assert.equal(initial.active, true);
  assert.equal(initial.settings.speed, 1);
  assert.equal(initial.settings.autoNext, false);

  const updated = await dispatch({ type: "update-settings", settings: { speed: 1.5, autoNext: true } }, popupSender);
  assert.equal(updated.settings.speed, 1.5);
  assert.equal(updated.settings.autoNext, true);
  assert(sentToTab.some(({ message }) => message.type === "settings-updated"));

  await dispatch({ type: "video-ended" }, courseSender);
  assert(sentToTab.some(({ message, options }) => message.type === "begin-countdown" && options.frameId === 0));

  const grantId = "transition-1";
  const previousSignature = "old-video|120";
  const currentSignature = "new-video|240";
  const armed = await dispatch({
    type: "arm-autoplay",
    ttl: 5_000,
    grantId,
    previousSignature,
  }, courseSender);
  assert.equal(armed.armed, true);

  const consumed = await dispatch({
    type: "consume-autoplay",
    grantId,
    previousSignature,
    currentSignature,
  }, courseSender);
  assert.equal(consumed.allowed, true);
  const consumedTwice = await dispatch({
    type: "consume-autoplay",
    grantId,
    previousSignature,
    currentSignature,
  }, courseSender);
  assert.equal(consumedTwice.allowed, false);

  await dispatch({ type: "arm-autoplay", ttl: 5_000, grantId: "transition-2", previousSignature }, courseSender);
  const wrongClear = await dispatch({ type: "clear-autoplay", grantId: "other-transition" }, courseSender);
  assert.equal(wrongClear.cleared, false);
  const rightClear = await dispatch({ type: "clear-autoplay", grantId: "transition-2" }, courseSender);
  assert.equal(rightClear.cleared, true);

  await dispatch({
    type: "arm-autoplay",
    ttl: 5_000,
    grantId: "transition-3",
    previousSignature,
    courseId: "course-a",
  }, courseSender);
  const wrongCourse = await dispatch({
    type: "consume-autoplay",
    grantId: "transition-3",
    previousSignature,
    currentSignature,
    courseId: "course-b",
  }, courseSender);
  assert.equal(wrongCourse.allowed, false);

  console.log("background smoke test: OK");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

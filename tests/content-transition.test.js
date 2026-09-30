"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const bootstrap = "  const assistant = new CoursePlaybackAssistant();\n  assistant.start();";
assert(source.includes(bootstrap), "content script bootstrap changed; update the test harness");

const pageWindow = { location: { href: "https://resource.uestc.edu.cn/learn/course/detail/spoc/courseWare/course?id=old" } };
pageWindow.top = pageWindow;
const context = vm.createContext({
  window: pageWindow,
  document: { visibilityState: "visible", querySelector: () => null },
  URL,
  console,
  HTMLMediaElement: { HAVE_METADATA: 1 },
});
vm.runInContext(source.replace(bootstrap, "  globalThis.TestAssistant = CoursePlaybackAssistant;"), context, {
  filename: "content.js",
});
const createAssistant = () => new context.TestAssistant();

test("chapter guard keeps both identifiers for the adjacent published video", async () => {
  const assistant = createAssistant();
  assistant.getVisibleChapterTitle = () => "上一节";
  assistant.fetchChapterTree = async () => [
    { info: { identification: "old-id", chapter_name: "上一节", resourse_type: "video", publish_status: 1 } },
    { info: { identification: "chapter-record-id", guid_: "url-resource-id", chapter_name: "下一节", resourse_type: "video", publish_status: 1 } },
  ];
  const guard = await assistant.getNextVideoGuard();
  assert.equal(guard.allowed, true);
  assert.deepEqual([...guard.entry.ids], ["chapter-record-id", "url-resource-id"]);
});

test("next-video identity accepts either ID from the same chapter record", async () => {
  const assistant = createAssistant();
  const record = {
    identification: "chapter-record-id",
    guid_: "url-resource-id",
    chapter_name: "下一节",
    resourse_type: "video",
  };
  assistant.getResourceIdFromUrl = () => "url-resource-id";
  assistant.getVisibleChapterTitle = () => "上一节";
  assistant.fetchChapterTree = async () => { throw new Error("URL ID should be sufficient"); };

  const transition = {
    previousUrlResourceId: "old-url-id",
    expectedNextId: record.identification,
    expectedNextIds: assistant.resourceIds(record),
    expectedNextTitle: record.chapter_name,
  };
  assert.equal(assistant.isExpectedTargetVisible(transition), true);
  assert.equal(await assistant.isExpectedTransitionTarget(transition), true);
  assert.equal(assistant.currentResourceId, "url-resource-id");
});

test("an unrelated resource with an unrelated title is not accepted", async () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "unrelated-id";
  assistant.getVisibleChapterTitle = () => "其他内容";
  const transition = {
    expectedNextId: "chapter-record-id",
    expectedNextIds: ["chapter-record-id", "url-resource-id"],
    expectedNextTitle: "下一节",
  };
  assert.equal(assistant.isExpectedTargetVisible(transition), false);
  assert.equal(await assistant.isExpectedTransitionTarget(transition), false);
});

test("timeout diagnosis distinguishes an identity mismatch from media readiness", () => {
  const assistant = createAssistant();
  assistant.isUsableVideo = () => true;
  assistant.hasBlockingDialog = () => false;
  const transition = {
    previousSignature: "old-signature",
    expectedNextIds: ["chapter-record-id", "url-resource-id"],
    expectedNextTitle: "下一节",
  };
  const video = { currentSrc: "blob:next", src: "", ended: false, readyState: 4 };
  assert.match(assistant.describeAutoplayWait(transition, video), /未匹配目录/);

  assistant.getResourceIdFromUrl = () => "url-resource-id";
  video.readyState = 0;
  assert.match(assistant.describeAutoplayWait(transition, video), /元数据尚未就绪/);
});

const courseTree = [
  { info: { identification: "old-id", guid_: "old-url-id", chapter_name: "上一节", resourse_type: "video", publish_status: 1 } },
  { info: { identification: "next-id", guid_: "next-url-id", chapter_name: "下一节", resourse_type: "video", publish_status: 1 } },
];
const sameUrlTransition = {
  previousUrlResourceId: "old-url-id",
  previousMediaSource: "blob:old-video",
  previousSignature: "old-signature",
  expectedNextId: "next-id",
  expectedNextIds: ["next-id", "next-url-id"],
  expectedNextTitle: "下一节",
};

test("the heading takes priority over a stale directory highlight", () => {
  const assistant = createAssistant();
  const originalQuerySelector = context.document.querySelector;
  context.document.querySelector = (selector) => (
    selector.includes(".course_title") ? { textContent: " 下一节 " } : null
  );
  assistant.getCurrentChapterTreeEntry = () => ({ title: "上一节" });
  try {
    assert.equal(assistant.getVisibleChapterTitle(), "下一节");
  } finally {
    context.document.querySelector = originalQuerySelector;
  }
});

test("same URL, stale highlight, new heading and new media identify the next lesson", async () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "old-url-id";
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.fetchChapterTree = async () => courseTree;
  assert.equal(assistant.isExpectedTargetVisible(sameUrlTransition), true);
  assert.equal(await assistant.isExpectedTransitionTarget(sameUrlTransition), true);
  assert.equal(assistant.currentResourceId, "next-id");
  assert.equal(assistant.hasNewMediaSource(sameUrlTransition, { currentSrc: "blob:new-video" }), true);
});

test("new heading cannot authorize playback while the old media remains loaded", () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "old-url-id";
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.isUsableVideo = () => true;
  assistant.hasBlockingDialog = () => false;
  const video = { currentSrc: "blob:old-video", src: "", ended: false, readyState: 4 };
  assert.equal(assistant.hasNewMediaSource(sameUrlTransition, video), false);
  assert.match(assistant.describeAutoplayWait(sameUrlTransition, video), /上一节的视频地址/);
});

test("pending autoplay waits for a changed media source before consuming its permit", async () => {
  const assistant = createAssistant();
  const transition = { ...sameUrlTransition, id: "transition-1", courseId: "course", permitArmed: true };
  const video = { currentSrc: "blob:old-video", src: "", paused: true };
  assistant.transition = transition;
  assistant.activeVideo = video;
  assistant.canContinueAutoplay = () => true;
  await assistant.tryPendingAutoplay(transition);
  assert.equal(transition.autoplayAttempted, undefined);
  assert.match(transition.lastWaitReason, /上一节的视频地址/);
});

test("same-URL next lesson reaches the playback routine after identity and source checks", async () => {
  const assistant = createAssistant();
  const transition = { ...sameUrlTransition, id: "transition-2", courseId: "course", permitArmed: true };
  const video = { currentSrc: "blob:new-video", src: "", paused: true };
  const previousChrome = context.chrome;
  let playbackCalls = 0;
  let statusMessage;
  context.chrome = { runtime: { sendMessage: async (request) => ({ allowed: request.type === "consume-autoplay" }) } };
  assistant.transition = transition;
  assistant.activeVideo = video;
  assistant.canContinueAutoplay = () => true;
  assistant.getCourseScopeId = () => "course";
  assistant.getResourceIdFromUrl = () => "old-url-id";
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.fetchChapterTree = async () => courseTree;
  assistant.videoSignature = () => "new-signature";
  assistant.startVerifiedNextVideo = async () => {
    playbackCalls += 1;
    return { started: true, usedPlayerControl: false, usedMutedAutoplay: false, keptMuted: false };
  };
  assistant.clearTransition = async () => { assistant.transition = null; };
  assistant.setStatus = (value) => { statusMessage = value.message; };
  try {
    await assistant.tryPendingAutoplay(transition);
    assert.equal(playbackCalls, 1);
    assert.equal(transition.autoplayAttempted, true);
    assert.match(statusMessage, /已开始播放下一节/);
  } finally {
    context.chrome = previousChrome;
  }
});

test("a changed URL matching the next record is sufficient despite a stale heading", async () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "next-url-id";
  assistant.getVisibleChapterTitle = () => "上一节";
  assistant.fetchChapterTree = async () => { throw new Error("A matching new URL should not need the API"); };
  assert.equal(assistant.isExpectedTargetVisible(sameUrlTransition), true);
  assert.equal(await assistant.isExpectedTransitionTarget(sameUrlTransition), true);
});

test("a changed URL pointing to a different record is rejected even if its heading matches", async () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "other-url-id";
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.fetchChapterTree = async () => courseTree;
  assert.equal(assistant.isExpectedTargetVisible(sameUrlTransition), false);
  assert.equal(await assistant.isExpectedTransitionTarget(sameUrlTransition), false);
});

test("same URL without API confirmation cannot authorize the next lesson", async () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "old-url-id";
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.fetchChapterTree = async () => null;
  assert.equal(await assistant.isExpectedTransitionTarget(sameUrlTransition), false);
});

test("duplicate next records do not provide unique identity", async () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "old-url-id";
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.fetchChapterTree = async () => [courseTree[0], courseTree[1], courseTree[1]];
  assert.equal(await assistant.isExpectedTransitionTarget(sameUrlTransition), false);
});

test("the following cycle resolves the new lesson by heading rather than stale URL", () => {
  const assistant = createAssistant();
  assistant.getResourceIdFromUrl = () => "old-url-id";
  assistant.getVisibleChapterTitle = () => "下一节";
  const resources = courseTree.map((node) => node.info);
  assert.equal(assistant.resolveCurrentResourceId(resources), "next-id");
});

test("DOM fallback uses visible heading rather than stale tree highlight", () => {
  const assistant = createAssistant();
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.getChapterTreeEntries = () => [
    { title: "上一节", type: "video", isCurrent: true },
    { title: "下一节", type: "video", isCurrent: false },
    { title: "第三节", type: "video", isCurrent: false },
  ];
  const guard = assistant.getNextVideoGuardFromDom();
  assert.equal(guard.allowed, true);
  assert.equal(guard.entry.title, "第三节");
});

test("DOM fallback stops when the visible heading is ambiguous", () => {
  const assistant = createAssistant();
  assistant.getVisibleChapterTitle = () => "下一节";
  assistant.getChapterTreeEntries = () => [
    { title: "下一节", type: "video", isCurrent: true },
    { title: "下一节", type: "video", isCurrent: false },
    { title: "第三节", type: "video", isCurrent: false },
  ];
  assert.equal(assistant.getNextVideoGuardFromDom().allowed, false);
});

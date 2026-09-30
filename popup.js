(() => {
  "use strict";

  const TARGET_HOST = "resource.uestc.edu.cn";
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const DEFAULT_SETTINGS = Object.freeze({ speed: 1, autoNext: false });

  const elements = {
    autoNext: document.querySelector("#auto-next"),
    connectionStatus: document.querySelector("#connection-status"),
    settingsMessage: document.querySelector("#settings-message"),
    speedButtons: [...document.querySelectorAll(".speed-button")],
    speedValue: document.querySelector("#speed-value"),
    statusDot: document.querySelector("#status-dot"),
    videoTitle: document.querySelector("#video-title")
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let isTargetTab = false;
  let currentTabId = null;
  let saveSequence = 0;

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function normaliseSettings(settings) {
    const requestedSpeed = Number(settings?.speed);
    const speed = SPEEDS.includes(requestedSpeed) ? requestedSpeed : DEFAULT_SETTINGS.speed;
    return {
      speed,
      autoNext: typeof settings?.autoNext === "boolean" ? settings.autoNext : DEFAULT_SETTINGS.autoNext
    };
  }

  function formatSpeed(speed) {
    return `${Number(speed).toFixed(2).replace(/0$/, "")}×`;
  }

  function setSettingsMessage(message = "", isError = false) {
    elements.settingsMessage.textContent = message;
    elements.settingsMessage.classList.toggle("is-error", isError);
  }

  function renderSettings(settings) {
    currentSettings = normaliseSettings(settings);
    elements.autoNext.checked = currentSettings.autoNext;
    elements.speedValue.value = formatSpeed(currentSettings.speed);
    elements.speedValue.textContent = formatSpeed(currentSettings.speed);

    for (const button of elements.speedButtons) {
      const isSelected = Number(button.dataset.speed) === currentSettings.speed;
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    }
  }

  function setStatus(kind, message, title = "") {
    elements.statusDot.className = `status-dot is-${kind}`;
    elements.connectionStatus.textContent = message;
    elements.videoTitle.textContent = title;
    elements.videoTitle.hidden = !title;
  }

  function statusTitle(status) {
    const candidate = status?.videoTitle ?? status?.title ?? status?.name ?? "";
    return typeof candidate === "string" ? candidate.trim() : "";
  }

  function countDownSeconds(status) {
    const candidate = status?.countdownSeconds ?? status?.countdown ?? status?.remainingSeconds;
    const seconds = Number(candidate);
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
  }

  function renderStatus(status, target = isTargetTab) {
    if (!target) {
      setStatus("warning", `请打开 ${TARGET_HOST} 的课程页面`, "");
      return;
    }

    if (!status) {
      setStatus("checking", "正在等待课程播放器…", "");
      return;
    }

    const title = statusTitle(status);
    const explicitMessage = typeof status.message === "string" ? status.message.trim() : "";
    const countdown = countDownSeconds(status);

    if (status.error) {
      setStatus("error", explicitMessage || "播放器暂时不可用，请刷新课程页面后重试。", title);
      return;
    }

    if (status.videoFound === false || status.hasVideo === false) {
      setStatus("warning", explicitMessage || "尚未检测到可控制的视频。", title);
      return;
    }

    if (countdown !== null) {
      setStatus("ready", `将在 ${countdown} 秒后进入下一节，可在页面取消。`, title);
      return;
    }

    if (status.playing === true || status.isPlaying === true) {
      setStatus("ready", explicitMessage || "已连接，正在播放。", title);
      return;
    }

    if (status.videoFound === true || status.hasVideo === true || status.ready === true) {
      setStatus("ready", explicitMessage || "已连接到当前播放器。", title);
      return;
    }

    setStatus("checking", explicitMessage || "正在等待课程播放器…", title);
  }

  async function persistSettings(partialSettings) {
    const previousSettings = currentSettings;
    const nextSettings = normaliseSettings({ ...currentSettings, ...partialSettings });
    const thisSave = ++saveSequence;
    renderSettings(nextSettings);
    setSettingsMessage("正在保存设置…");

    try {
      const response = await sendRuntimeMessage({
        type: "update-settings",
        settings: partialSettings
      });

      if (response?.ok === false) {
        throw new Error(response.error || "后台未接受该设置。");
      }

      if (thisSave !== saveSequence) return;

      if (response?.settings) renderSettings(response.settings);
      if (typeof response?.active === "boolean") isTargetTab = response.active;
      if (Number.isInteger(response?.tabId)) currentTabId = response.tabId;
      if (response?.status) renderStatus(response.status, isTargetTab);

      if (response?.delivered === false && isTargetTab) {
        setSettingsMessage("设置已保存；播放器加载完成后会自动应用。");
      } else if (!isTargetTab) {
        setSettingsMessage("设置已保存，下次打开课程页会自动应用。");
      } else {
        setSettingsMessage("设置已应用到当前课程。");
      }
    } catch (error) {
      if (thisSave !== saveSequence) return;
      renderSettings(previousSettings);
      setSettingsMessage(`无法保存设置：${error.message}`, true);
    }
  }

  async function loadState() {
    try {
      const response = await sendRuntimeMessage({ type: "get-state" });
      if (response?.ok === false) {
        throw new Error(response.error || "后台未返回课程状态。");
      }
      renderSettings(response?.settings ?? DEFAULT_SETTINGS);
      isTargetTab = response?.active === true;
      currentTabId = Number.isInteger(response?.tabId) ? response.tabId : null;
      renderStatus(response?.status, isTargetTab);
    } catch (error) {
      setStatus("error", `无法连接扩展后台：${error.message}`);
      setSettingsMessage("请重新加载扩展后重试。", true);
    }
  }

  for (const button of elements.speedButtons) {
    button.addEventListener("click", () => {
      const speed = Number(button.dataset.speed);
      if (SPEEDS.includes(speed) && speed !== currentSettings.speed) {
        void persistSettings({ speed });
      }
    });
  }

  elements.autoNext.addEventListener("change", () => {
    void persistSettings({ autoNext: elements.autoNext.checked });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "status") {
      // Content scripts also use runtime messaging. Only accept the background's
      // tab-tagged relay, so another open course tab cannot overwrite this popup.
      if (message.tabId === currentTabId) renderStatus(message.status, true);
      return;
    }
    if (message.type === "settings" && message.settings) {
      renderSettings(message.settings);
      setSettingsMessage("设置已从课程页面同步。");
    }
  });

  void loadState();
})();

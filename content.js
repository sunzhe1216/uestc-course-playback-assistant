(() => {
  'use strict';

  const DEFAULT_SETTINGS = Object.freeze({
    speed: 1,
    autoNext: false,
  });

  const SPEED_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const AUTOPLAY_TTL_MS = 30_000;
  const PLAYER_START_GRACE_MS = 500;
  const PLAYER_START_TIMEOUT_MS = 5_000;
  const PLAYER_START_POLL_MS = 150;
  const PLAYER_CONTROL_RETRY_MS = 1_500;
  const MUTED_AUTOPLAY_TIMEOUT_MS = 1_200;
  const FRAME_IS_TOP = window.top === window;
  const TARGET_HOST = 'resource.uestc.edu.cn';
  const COURSE_PATH_PREFIX = '/learn/course/detail/spoc/courseWare/';

  const normalizeText = (value) => (value || '')
    .replace(/\s+/g, ' ')
    .replace(/[→›>]+/g, '')
    .trim();

  const isEditableTarget = (target) => {
    if (!(target instanceof Element)) return false;
    return target.matches('input, textarea, select, [contenteditable="true"], [role="textbox"]');
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  const isSupportedCoursePage = () => (
    window.location.protocol === 'https:'
    && window.location.hostname === TARGET_HOST
    && window.location.pathname.startsWith(COURSE_PATH_PREFIX)
  );

  class CoursePlaybackAssistant {
    constructor() {
      this.settings = { ...DEFAULT_SETTINGS };
      this.activeVideo = null;
      this.videoCleanup = [];
      this.domObserver = null;
      this.findTimer = null;
      this.countdown = null;
      this.countdownStarting = false;
      this.countdownToken = 0;
      this.status = {
        videoFound: false,
        autoNext: false,
        speed: 1,
        message: '正在寻找课程视频…',
      };
      this.lastVideoSignature = null;
      this.lastHandledEndedSignature = null;
      this.hasObservedPlayback = false;
      this.transition = null;
      this.currentResourceId = null;
      this.chapterTreeCache = { key: null, data: null, expiresAt: 0, request: null };
      this.started = false;
    }

    async start() {
      if (this.started) return;
      if (!isSupportedCoursePage()) return;
      this.started = true;
      this.currentResourceId = this.getResourceIdFromUrl();
      this.settings = await this.readSettings();
      this.installMessageListener();
      this.installStorageListener();
      this.installKeyboardShortcuts();
      this.observePage();
      this.findAndBindVideo();
      this.reportStatus();
    }

    async readSettings() {
      try {
        const { settings } = await chrome.storage.local.get('settings');
        return { ...DEFAULT_SETTINGS, ...(settings || {}) };
      } catch (error) {
        console.warn('[UESTC Playback Assistant] Could not read settings.', error);
        return { ...DEFAULT_SETTINGS };
      }
    }

    installMessageListener() {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!message || typeof message.type !== 'string') return undefined;

        if (message.type === 'settings-updated') {
          this.settings = { ...this.settings, ...(message.settings || {}) };
          this.handleSettingsChanged();
          sendResponse({ ok: true, status: this.status });
          return undefined;
        }

        if (message.type === 'get-content-status' || message.type === 'get-state') {
          sendResponse({ ok: true, status: this.status, isTopFrame: FRAME_IS_TOP });
          return undefined;
        }

        if (message.type === 'begin-countdown' && FRAME_IS_TOP) {
          void this.beginCountdown();
          sendResponse({ ok: true });
          return undefined;
        }

        if (message.type === 'cancel-countdown' && FRAME_IS_TOP) {
          this.cancelCountdown('已取消本次自动跳转。');
          sendResponse({ ok: true });
          return undefined;
        }

        if (message.type === 'attempt-pending-autoplay') {
          void this.tryPendingAutoplay();
          sendResponse({ ok: true });
          return undefined;
        }

        return undefined;
      });
    }

    installStorageListener() {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes.settings) return;
        this.settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
        this.handleSettingsChanged();
      });
    }

    installKeyboardShortcuts() {
      window.addEventListener('keydown', (event) => {
        if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) {
          return;
        }

        if (event.key === '.' || event.code === 'Period') {
          event.preventDefault();
          this.changeSpeed(1);
        } else if (event.key === ',' || event.code === 'Comma') {
          event.preventDefault();
          this.changeSpeed(-1);
        } else if (event.key.toLowerCase() === 'n') {
          event.preventDefault();
          this.updateSettings({ autoNext: !this.settings.autoNext });
        }
      }, true);
    }

    observePage() {
      const scheduleScan = (records = []) => {
        window.clearTimeout(this.findTimer);
        this.findTimer = window.setTimeout(() => {
          const requiresVideoScan = !this.activeVideo
            || !this.activeVideo.isConnected
            || !this.isUsableVideo(this.activeVideo)
            || this.mutationsMayChangeVideo(records);
          if (requiresVideoScan) this.findAndBindVideo();
          this.detectXgPlayerEnded();
        }, 220);
      };

      this.domObserver = new MutationObserver(scheduleScan);
      this.domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'class'],
      });

      window.addEventListener('pagehide', () => this.dispose(), { once: true });
    }

    mutationsMayChangeVideo(records) {
      return records.some((record) => {
        if (record.type !== 'childList') return false;
        return [...record.addedNodes, ...record.removedNodes].some((node) => {
          if (!(node instanceof Element)) return false;
          return node.matches('video, #h5player, .course_ware_container')
            || Boolean(node.querySelector('video, #h5player, .course_ware_container'));
        });
      });
    }

    findAndBindVideo() {
      const candidate = this.pickVideo();
      if (!candidate) {
        if (this.activeVideo && (!this.activeVideo.isConnected || !this.isUsableVideo(this.activeVideo))) {
          this.unbindVideo();
        }
        if (!this.activeVideo) {
          this.setStatus({
            videoFound: false,
            message: '当前学习内容不是可控制的视频，或播放器尚未加载。',
          });
        }
        return;
      }

      if (candidate !== this.activeVideo) {
        this.bindVideo(candidate);
      }
    }

    pickVideo() {
      const courseRoot = this.getCourseRoot();
      if (!courseRoot) return null;
      const selectors = [
        '#h5player video',
        '.course_ware_container .video_box video',
        '.preview_content .xgplayer video',
        'video',
      ];
      const videos = selectors.flatMap((selector) => Array.from(courseRoot.querySelectorAll(selector)))
        .filter((video, index, all) => all.indexOf(video) === index);
      const visibleVideos = videos.filter((video) => this.isUsableVideo(video));
      if (!visibleVideos.length) return null;

      return visibleVideos.sort((a, b) => this.videoScore(b) - this.videoScore(a))[0];
    }

    getCourseRoot() {
      return document.querySelector('.content_box.course_ware')
        || document.querySelector('.course_ware_container')
        || document.querySelector('#h5player');
    }

    getCourseScope() {
      const pageCourseScope = this.activeVideo?.closest('.content_box.course_ware');
      const playerContainer = this.activeVideo?.closest('.course_ware_container');
      return pageCourseScope || playerContainer || this.getCourseRoot();
    }

    getCourseScopeId() {
      try {
        const match = new URL(window.location.href).pathname.match(/\/courseWare\/([^/?#]+)/);
        return match?.[1] || null;
      } catch (_) {
        return null;
      }
    }

    getResourceIdFromUrl() {
      try {
        return new URL(window.location.href).searchParams.get('id') || null;
      } catch (_) {
        return null;
      }
    }

    getVisibleChapterTitle() {
      // The site's "next" control updates the heading and media source but can
      // leave the tree's is-current class on the previous lesson. The heading
      // is the content actually shown in the player, so prefer it.
      const selectors = [
        '.content_box.course_ware .course_title .course_name',
        '.course_ware_container .course_title .course_name',
        '.course_title > .course_name',
      ];
      for (const selector of selectors) {
        const title = normalizeText(document.querySelector(selector)?.textContent);
        if (title) return title;
      }
      return normalizeText(this.getCurrentChapterTreeEntry()?.title);
    }

    flattenChapterTree(nodes, resources = []) {
      for (const node of Array.isArray(nodes) ? nodes : []) {
        const info = node?.info;
        if (info?.resourse_type && info.resourse_type !== 'chapter') resources.push(info);
        this.flattenChapterTree(node?.childInfo, resources);
      }
      return resources;
    }

    resourceIds(item) {
      return [item?.identification, item?.guid_]
        .filter((id, index, all) => typeof id === 'string' && id.length > 0 && all.indexOf(id) === index);
    }

    async fetchChapterTree() {
      const courseId = this.getCourseScopeId();
      if (!courseId) return null;
      const url = new URL(window.location.href);
      const type = url.searchParams.get('type') || '';
      const semester = url.searchParams.get('semester') || '';
      const cacheKey = `${courseId}|${type}|${semester}`;
      if (this.chapterTreeCache.key === cacheKey
        && this.chapterTreeCache.data
        && this.chapterTreeCache.expiresAt > Date.now()) {
        return this.chapterTreeCache.data;
      }
      if (this.chapterTreeCache.key === cacheKey && this.chapterTreeCache.request) {
        return this.chapterTreeCache.request;
      }

      const endpoint = new URL('/learn/v1/homepage/chapter/info', window.location.origin);
      endpoint.searchParams.set('courseId', courseId);
      endpoint.searchParams.set('type', type);
      endpoint.searchParams.set('semester', semester);
      endpoint.searchParams.set('metadataType', 'chapter_contents');
      const request = fetch(endpoint, { credentials: 'same-origin', cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) return null;
          const payload = await response.json();
          return Array.isArray(payload?.data) ? payload.data : null;
        })
        .catch(() => null)
        .then((data) => {
          if (data) {
            this.chapterTreeCache = {
              key: cacheKey,
              data,
              expiresAt: Date.now() + 30_000,
              request: null,
            };
          } else if (this.chapterTreeCache.key === cacheKey) {
            this.chapterTreeCache.request = null;
          }
          return data;
        });
      this.chapterTreeCache = { key: cacheKey, data: null, expiresAt: 0, request };
      return request;
    }

    resolveCurrentResourceId(resources) {
      const visibleTitle = this.getVisibleChapterTitle();
      if (visibleTitle) {
        const sameTitle = resources.filter((item) => (
          normalizeText(item.chapter_name) === visibleTitle
        ));
        if (sameTitle.length !== 1) return null;
        const id = this.resourceIds(sameTitle[0])[0];
        if (id) {
          this.currentResourceId = id;
          return id;
        }
        return null;
      }

      const candidates = [];
      const urlResourceId = this.getResourceIdFromUrl();
      if (urlResourceId) candidates.push(urlResourceId);
      if (this.currentResourceId) candidates.push(this.currentResourceId);

      for (const candidate of candidates) {
        if (resources.some((item) => this.resourceIds(item).includes(candidate))) {
          this.currentResourceId = candidate;
          return candidate;
        }
      }
      return null;
    }

    getChapterTreeEntries() {
      const tree = document.querySelector('.chapter_tree');
      if (!tree) return [];

      return Array.from(tree.querySelectorAll('.el-tree-node'))
        .map((node) => {
          const content = Array.from(node.children)
            .find((child) => child.classList?.contains('el-tree-node__content'));
          const item = content?.querySelector('.section_item');
          if (!(item instanceof HTMLElement)) return null;

          const iconSource = item.querySelector('img[src]')?.getAttribute('src')?.toLowerCase() || '';
          const declaredType = item.getAttribute('data-resource-type')
            || node.getAttribute('data-resource-type')
            || '';
          let type = declaredType.toLowerCase();
          if (!type) {
            if (iconSource.includes('video-icon.svg')) type = 'video';
            else if (iconSource.includes('audio-icon.svg')) type = 'audio';
            else if (iconSource.includes('doc-icon.svg')) type = 'document';
            else if (iconSource.includes('homework-icon.svg')) type = 'homework';
            else if (iconSource.includes('hyperlink-icon.svg')) type = 'hyperlink';
            else if (iconSource.includes('course_map.svg')) type = 'virtual_simulation';
            else if (iconSource.includes('img-icon.svg')) type = 'picture';
            else if (iconSource.includes('material-icon.svg')) type = 'material';
          }

          return {
            node,
            item,
            key: node.getAttribute('data-key') || item.getAttribute('data-key') || null,
            type: type || 'unknown',
            isCurrent: node.classList.contains('is-current') || content?.classList.contains('is-current'),
            title: item.querySelector('.course_name')?.textContent?.trim() || '',
          };
        })
        .filter(Boolean);
    }

    getNextVideoGuardFromDom() {
      const entries = this.getChapterTreeEntries();
      const visibleTitle = this.getVisibleChapterTitle();
      const matchingIndices = entries.flatMap((entry, index) => (
        normalizeText(entry.title) === visibleTitle ? [index] : []
      ));
      // The platform can leave is-current on the previous row after moving
      // forward. Prefer the title shown above the actual player, but fail
      // closed when the title cannot uniquely identify a directory entry.
      const currentIndex = visibleTitle && matchingIndices.length === 1
        ? matchingIndices[0]
        : -1;
      if (currentIndex < 0) {
        return { allowed: false, reason: '未能从课程标题唯一确认目录中的当前视频。' };
      }
      const next = entries[currentIndex + 1];
      const current = entries[currentIndex];
      if (current.type !== 'video') {
        return { allowed: false, reason: '当前学习内容未被目录识别为视频。' };
      }
      if (!next) return { allowed: false, reason: '当前视频已是课程目录中的最后一项。' };
      if (next.type !== 'video') {
        return {
          allowed: false,
          reason: `下一学习内容${next.title ? `“${next.title}”` : ''}不是视频。`,
        };
      }
      if (!next.title) {
        return { allowed: false, reason: '无法确认下一视频的名称。' };
      }
      return {
        allowed: true,
        entry: { id: null, title: next.title, type: 'video' },
      };
    }

    async getNextVideoGuard() {
      const tree = await this.fetchChapterTree();
      if (tree !== null) {
        const resources = this.flattenChapterTree(tree);
        const currentId = this.resolveCurrentResourceId(resources);
        const currentIndex = resources.findIndex((item) => (
          this.resourceIds(item).includes(currentId)
        ));
        if (currentIndex >= 0) {
          const current = resources[currentIndex];
          if (current.resourse_type !== 'video' || Number(current.publish_status) !== 1) {
            return { allowed: false, reason: '当前学习内容未被目录识别为可播放视频。' };
          }
          const next = resources[currentIndex + 1];
          if (!next) return { allowed: false, reason: '当前视频已是课程目录中的最后一项。' };
          if (next.resourse_type !== 'video' || Number(next.publish_status) !== 1) {
            return {
              allowed: false,
              reason: `下一学习内容${next.chapter_name ? `“${next.chapter_name}”` : ''}不是可播放视频。`,
            };
          }
          return {
            allowed: true,
            entry: {
              id: next.identification || next.guid_,
              ids: this.resourceIds(next),
              title: next.chapter_name || '',
              type: 'video',
            },
          };
        }
        return { allowed: false, reason: '无法从课程目录确认当前学习内容。' };
      }
      return this.getNextVideoGuardFromDom();
    }

    async isExpectedTransitionTarget(transition) {
      const expectedIds = transition.expectedNextIds?.length
        ? transition.expectedNextIds
        : [transition.expectedNextId].filter(Boolean);
      const expectedTitle = normalizeText(transition.expectedNextTitle);
      if (!expectedIds.length) {
        return Boolean(expectedTitle && this.getVisibleChapterTitle() === expectedTitle);
      }

      const urlResourceId = this.getResourceIdFromUrl();
      if (urlResourceId && urlResourceId !== transition.previousUrlResourceId) {
        if (!expectedIds.includes(urlResourceId)) return false;
        this.currentResourceId = urlResourceId;
        return true;
      }
      if (!expectedTitle || this.getVisibleChapterTitle() !== expectedTitle) return false;

      const tree = await this.fetchChapterTree();
      if (tree === null) return false;
      const matches = this.flattenChapterTree(tree).filter((item) => (
        normalizeText(item.chapter_name) === expectedTitle
          && this.resourceIds(item).some((id) => expectedIds.includes(id))
      ));
      if (matches.length !== 1) return false;

      this.currentResourceId = this.resourceIds(matches[0])[0];
      return true;
    }

    isExpectedTargetVisible(transition) {
      const urlResourceId = this.getResourceIdFromUrl();
      const expectedIds = transition.expectedNextIds?.length
        ? transition.expectedNextIds
        : [transition.expectedNextId].filter(Boolean);
      if (urlResourceId && urlResourceId !== transition.previousUrlResourceId && expectedIds.length) {
        return expectedIds.includes(urlResourceId);
      }
      const expectedTitle = normalizeText(transition.expectedNextTitle);
      return Boolean(expectedTitle && this.getVisibleChapterTitle() === expectedTitle);
    }

    hasNewMediaSource(transition, video) {
      const source = video?.currentSrc || video?.src;
      return Boolean(source && source !== transition.previousMediaSource);
    }

    describeAutoplayWait(transition, video) {
      if (!video) return '未找到可见的课程视频';
      if (document.visibilityState !== 'visible') return '课程页不在前台';
      if (!this.isUsableVideo(video)) return '播放器视频元素不可见';
      if (video.ended) return '播放器仍停留在上一节的结束状态';
      if (!video.currentSrc && !video.src) return '新视频地址尚未加载';
      if (!this.hasNewMediaSource(transition, video)) {
        return '播放器仍加载上一节的视频地址';
      }
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
        return `新视频元数据尚未就绪（readyState=${video.readyState}）`;
      }
      if (this.hasBlockingDialog()) return '页面有平台弹窗或互动内容';
      if (!this.isExpectedTargetVisible(transition)) {
        return '页面资源编号和章节标题均未匹配目录中的下一视频';
      }
      if (this.videoSignature(video) === transition.previousSignature) {
        return '播放器的视频标识仍与上一节相同';
      }
      return '新视频已就绪，但目录身份核验尚未通过';
    }

    getCurrentChapterTreeEntry() {
      return this.getChapterTreeEntries().find((entry) => entry.isCurrent) || null;
    }

    isUsableVideo(video) {
      if (!(video instanceof HTMLVideoElement) || !video.isConnected) return false;
      const rect = video.getBoundingClientRect();
      const style = window.getComputedStyle(video);
      return rect.width > 120
        && rect.height > 80
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0;
    }

    videoScore(video) {
      const rect = video.getBoundingClientRect();
      const isPlaying = !video.paused && !video.ended ? 1_000_000 : 0;
      const isXgPlayerVideo = video.closest('#h5player, .xgplayer') ? 100_000 : 0;
      const hasSource = video.currentSrc || video.src ? 10_000 : 0;
      return isPlaying + isXgPlayerVideo + hasSource + rect.width * rect.height;
    }

    bindVideo(video) {
      this.unbindVideo();
      this.activeVideo = video;
      this.lastVideoSignature = this.videoSignature(video);
      this.lastHandledEndedSignature = null;
      this.hasObservedPlayback = !video.paused && !video.ended;
      this.applySpeed(video);

      const onEnded = () => this.handleVideoEnded();
      const onLoadStart = () => {
        this.lastHandledEndedSignature = null;
        this.hasObservedPlayback = false;
        // XGPlayer can reuse the same <video> element for the next resource.
        // Refresh the signature and retry here instead of waiting for a new
        // element to be discovered by the mutation observer.
        this.lastVideoSignature = this.videoSignature(video);
        this.clearCountdown();
        void this.tryPendingAutoplay();
      };
      const onLoadedMetadata = () => {
        this.lastVideoSignature = this.videoSignature(video);
        this.applySpeed(video);
        void this.tryPendingAutoplay();
      };
      const onPlayerCanPlay = () => {
        this.lastVideoSignature = this.videoSignature(video);
        this.applySpeed(video);
        void this.tryPendingAutoplay();
      };
      const onDurationChange = () => {
        this.lastVideoSignature = this.videoSignature(video);
        this.applySpeed(video);
        void this.tryPendingAutoplay();
      };
      const onPlay = () => {
        if (video.currentTime < video.duration) this.lastHandledEndedSignature = null;
        this.hasObservedPlayback = true;
        this.cancelCountdown('检测到视频开始播放，已取消本次自动跳转。');
      };
      const onTimeUpdate = () => {
        if (video.currentTime > 0) this.hasObservedPlayback = true;
      };
      const onError = () => this.setStatus({ message: '视频播放器报告错误，未执行自动跳转。' });
      const onRateChange = () => {
        this.setStatus({ speed: video.playbackRate, message: `当前播放速度：${this.formatSpeed(video.playbackRate)}。` });
      };

      video.addEventListener('ended', onEnded);
      video.addEventListener('loadstart', onLoadStart);
      video.addEventListener('loadedmetadata', onLoadedMetadata);
      video.addEventListener('loadeddata', onPlayerCanPlay);
      video.addEventListener('canplay', onPlayerCanPlay);
      video.addEventListener('durationchange', onDurationChange);
      video.addEventListener('play', onPlay);
      video.addEventListener('timeupdate', onTimeUpdate);
      video.addEventListener('error', onError);
      video.addEventListener('ratechange', onRateChange);
      this.videoCleanup.push(
        () => video.removeEventListener('ended', onEnded),
        () => video.removeEventListener('loadstart', onLoadStart),
        () => video.removeEventListener('loadedmetadata', onLoadedMetadata),
        () => video.removeEventListener('loadeddata', onPlayerCanPlay),
        () => video.removeEventListener('canplay', onPlayerCanPlay),
        () => video.removeEventListener('durationchange', onDurationChange),
        () => video.removeEventListener('play', onPlay),
        () => video.removeEventListener('timeupdate', onTimeUpdate),
        () => video.removeEventListener('error', onError),
        () => video.removeEventListener('ratechange', onRateChange),
      );

      this.setStatus({
        videoFound: true,
        speed: video.playbackRate,
        message: FRAME_IS_TOP ? '已连接到课程视频。' : '已连接到嵌入式课程视频。',
      });

      // A fresh document may already have metadata before this script starts.
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        void this.tryPendingAutoplay();
      }
    }

    unbindVideo() {
      this.videoCleanup.forEach((cleanup) => cleanup());
      this.videoCleanup = [];
      this.activeVideo = null;
    }

    videoSignature(video) {
      const pageResourceId = this.getResourceIdFromUrl() || '';
      const chapterTitle = this.getVisibleChapterTitle();
      const source = [pageResourceId, chapterTitle, video.currentSrc, video.src, video.poster]
        .filter((value) => typeof value === 'string' && value.length > 0)
        .join('|');
      if (source) return source;
      return `duration:${Number.isFinite(video.duration) ? video.duration : 'unknown'}`;
    }

    detectXgPlayerEnded() {
      const video = this.activeVideo;
      if (!video || video.ended || !this.hasObservedPlayback) return;
      const player = video.closest('#h5player, .xgplayer');
      if (player?.classList.contains('xgplayer-ended')) {
        void this.handleVideoEnded();
      }
    }

    isEndedPlayback(video) {
      if (!(video instanceof HTMLVideoElement)) return false;
      if (video.ended) return true;
      return this.hasObservedPlayback
        && Boolean(video.closest('#h5player, .xgplayer')?.classList.contains('xgplayer-ended'));
    }

    isPlayableNextVideo(video) {
      return this.isUsableVideo(video)
        && Boolean(video.currentSrc || video.src)
        && Number.isFinite(video.duration)
        && video.duration > 0
        && video.duration !== Infinity;
    }

    isAutoplayCandidate(video) {
      // Do not require a finite duration here. With this XGPlayer instance the
      // central play control is visible while metadata is still settling, and
      // requiring duration > 0 prevents the code from ever clicking it.
      return this.isUsableVideo(video)
        && Boolean(video.currentSrc || video.src)
        && !video.ended
        && video.readyState >= HTMLMediaElement.HAVE_METADATA;
    }

    canContinueAutoplay(video) {
      return this.settings.autoNext
        && document.visibilityState === 'visible'
        && this.activeVideo === video
        && !video.ended
        && this.isAutoplayCandidate(video)
        // XGPlayer may expose the first frame with HAVE_METADATA while its
        // media pipeline is still buffering. Do not drop the transition here;
        // startVerifiedNextVideo will keep polling until the player is ready.
        && !this.hasBlockingDialog()
        && !(document.fullscreenElement instanceof HTMLVideoElement);
    }

    isTransitionPlaybackEligible(transition, video, signature) {
      return this.transition?.id === transition.id
        && transition.permitArmed
        && this.canContinueAutoplay(video)
        && this.videoSignature(video) === signature;
    }

    findCentralPlayerStartControl(video) {
      const playerRoot = video.closest('.xgplayer') || video.closest('#h5player');
      if (!(playerRoot instanceof HTMLElement)
        || playerRoot.classList.contains('xgplayer-playing')
        || playerRoot.classList.contains('xgplayer-is-error')) return null;

      const startControl = Array.from(playerRoot.querySelectorAll('.xgplayer-start'))
        .find((element) => element instanceof HTMLElement
          && !element.classList.contains('xgplayer-start-hide')
          && element.isConnected);
      return startControl || null;
    }

    async waitForPlaybackStart(transition, video, signature, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!this.isTransitionPlaybackEligible(transition, video, signature)) return false;
        if (!video.paused && !video.ended) return true;
        await sleep(PLAYER_START_POLL_MS);
      }
      return this.isTransitionPlaybackEligible(transition, video, signature)
        && !video.paused
        && !video.ended;
    }

    async tryMutedAutoplay(transition, video, signature) {
      if (!this.isTransitionPlaybackEligible(transition, video, signature)) {
        return { started: false, usedMutedAutoplay: false, keptMuted: false };
      }

      const wasMuted = Boolean(video.muted);
      let playError = null;
      try {
        // Chrome permits muted media autoplay in cases where audible playback is
        // rejected. This is a one-shot fallback for the verified next video.
        video.muted = true;
        const result = video.play();
        if (result && typeof result.catch === 'function') {
          void result.catch((error) => {
            playError = error;
          });
        }
      } catch (error) {
        playError = error;
      }

      if (!await this.waitForPlaybackStart(transition, video, signature, MUTED_AUTOPLAY_TIMEOUT_MS)) {
        video.muted = wasMuted;
        if (playError) console.info('[UESTC Playback Assistant] Muted autoplay was rejected.', playError);
        return { started: false, usedMutedAutoplay: true, keptMuted: false };
      }

      let keptMuted = false;
      if (!wasMuted) {
        try {
          video.muted = false;
          await sleep(120);
          if (video.paused && !video.ended && this.isTransitionPlaybackEligible(transition, video, signature)) {
            keptMuted = true;
            video.muted = true;
            const resume = video.play();
            if (resume && typeof resume.catch === 'function') void resume.catch(() => {});
            await this.waitForPlaybackStart(transition, video, signature, PLAYER_START_GRACE_MS);
          }
        } catch (_) {
          keptMuted = true;
          video.muted = true;
        }
      }

      return {
        started: this.isTransitionPlaybackEligible(transition, video, signature)
          && !video.paused
          && !video.ended,
        usedMutedAutoplay: true,
        keptMuted,
      };
    }

    async startVerifiedNextVideo(transition, video, signature) {
      if (!this.isTransitionPlaybackEligible(transition, video, signature)) {
        return { started: false, usedPlayerControl: false };
      }

      this.applySpeed(video);
      let nativePlayError = null;
      try {
        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          const result = video.play();
          if (result && typeof result.catch === 'function') {
            void result.catch((error) => {
              nativePlayError = error;
            });
          }
        }
      } catch (error) {
        nativePlayError = error;
      }

      if (await this.waitForPlaybackStart(transition, video, signature, PLAYER_START_GRACE_MS)) {
        return { started: true, usedPlayerControl: false, usedMutedAutoplay: false, keptMuted: false };
      }

      let usedPlayerControl = false;
      let startControlClicks = 0;
      let lastStartControlClickAt = 0;
      const initialStartControl = this.findCentralPlayerStartControl(video);
      if (initialStartControl) {
        usedPlayerControl = true;
        try {
          initialStartControl.click();
          startControlClicks = 1;
          lastStartControlClickAt = Date.now();
          this.setStatus({ message: '正在通过播放器播放控件启动下一节。' });
        } catch (error) {
          console.info('[UESTC Playback Assistant] Could not activate the player start control.', error);
        }
      }

      if (await this.waitForPlaybackStart(transition, video, signature, PLAYER_START_GRACE_MS)) {
        return { started: true, usedPlayerControl, usedMutedAutoplay: false, keptMuted: false };
      }

      const mutedPlayback = await this.tryMutedAutoplay(transition, video, signature);
      if (mutedPlayback.started) {
        return { ...mutedPlayback, usedPlayerControl };
      }

      const deadline = Date.now() + PLAYER_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (!this.isTransitionPlaybackEligible(transition, video, signature)) {
          return { started: false, usedPlayerControl, usedMutedAutoplay: true, keptMuted: false };
        }
        if (!video.paused && !video.ended) {
          return { started: true, usedPlayerControl, usedMutedAutoplay: false, keptMuted: false };
        }

        if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
          try {
            const result = video.play();
            if (result && typeof result.catch === 'function') {
              void result.catch((error) => {
                nativePlayError = error;
              });
            }
          } catch (error) {
            nativePlayError = error;
          }
        }

        const startControl = this.findCentralPlayerStartControl(video);
        if (startControl
          && startControlClicks < 2
          && Date.now() - lastStartControlClickAt >= PLAYER_CONTROL_RETRY_MS) {
          usedPlayerControl = true;
          try {
            startControl.click();
            startControlClicks += 1;
            lastStartControlClickAt = Date.now();
            this.setStatus({ message: '正在通过播放器播放控件启动下一节。' });
          } catch (error) {
            console.info('[UESTC Playback Assistant] Could not activate the player start control.', error);
          }
        }
        await sleep(PLAYER_START_POLL_MS);
      }

      if (nativePlayError) {
        console.info('[UESTC Playback Assistant] Native autoplay was rejected.', nativePlayError);
      }
      return {
        started: this.isTransitionPlaybackEligible(transition, video, signature)
          && !video.paused
          && !video.ended,
        usedPlayerControl,
        usedMutedAutoplay: true,
        keptMuted: false,
      };
    }

    hasBlockingDialog() {
      const dialogs = document.querySelectorAll(
        '[role="dialog"], .el-dialog__wrapper, .el-message-box__wrapper, .el-popover',
      );
      return Array.from(dialogs).some((dialog) => {
        if (!(dialog instanceof HTMLElement)) return false;
        if (dialog.id.startsWith('uestc-playback-assistant-')) return false;
        const rect = dialog.getBoundingClientRect();
        const style = window.getComputedStyle(dialog);
        return rect.width > 0
          && rect.height > 0
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || 1) > 0;
      });
    }

    async handleVideoEnded() {
      const endedSignature = this.activeVideo ? this.videoSignature(this.activeVideo) : this.lastVideoSignature;
      if (endedSignature && endedSignature === this.lastHandledEndedSignature) return;
      this.lastHandledEndedSignature = endedSignature;

      if (!this.settings.autoNext) {
        this.setStatus({ message: '本视频已结束；连续播放当前处于关闭状态。' });
        return;
      }

      if (document.visibilityState !== 'visible') {
        this.setStatus({ message: '页面不在前台，未执行自动下一节。' });
        return;
      }

      if (document.fullscreenElement instanceof HTMLVideoElement) {
        this.setStatus({ message: '原生视频全屏时无法显示取消控件，未自动跳转。' });
        return;
      }

      try {
        await chrome.runtime.sendMessage({ type: 'video-ended' });
      } catch (error) {
        // The top page is still useful when the service worker was restarted.
        if (FRAME_IS_TOP) void this.beginCountdown();
        else this.setStatus({ message: '无法向课程页发送结束通知。' });
        console.warn('[UESTC Playback Assistant] Could not relay ended event.', error);
      }
    }

    async beginCountdown() {
      if (!this.settings.autoNext || this.countdown || this.countdownStarting) return;
      if (document.visibilityState !== 'visible') {
        this.setStatus({ message: '页面不在前台，未执行自动下一节。' });
        return;
      }

      if (this.hasBlockingDialog()) {
        this.setStatus({ message: '检测到平台弹窗或互动内容，未自动跳转。' });
        return;
      }

      const token = ++this.countdownToken;
      const endingVideo = this.activeVideo;
      const endingSignature = endingVideo ? this.videoSignature(endingVideo) : this.lastVideoSignature;
      this.countdownStarting = true;
      try {
        const nextVideo = await this.getNextVideoGuard();
        if (token !== this.countdownToken
          || !this.settings.autoNext
          || this.countdown
          || document.visibilityState !== 'visible'
          || this.hasBlockingDialog()
          || !endingVideo
          || this.activeVideo !== endingVideo
          || !this.isEndedPlayback(endingVideo)
          || (endingSignature && this.videoSignature(endingVideo) !== endingSignature)) {
          return;
        }
        if (!nextVideo.allowed) {
          const message = `${nextVideo.reason} 未自动跳转。`;
          this.setStatus({ message });
          this.showNotice(message);
          return;
        }

        if (!this.findNextControl()) {
          this.setStatus({ message: '未找到页面中的“下一个”按钮，未自动跳转。' });
          this.showNotice('视频已结束，但未找到“下一个”按钮。');
          return;
        }

        let remaining = 5;
        const overlay = this.createCountdownOverlay({
          onCancel: () => this.cancelCountdown('已取消本次自动跳转。'),
          onNextNow: async () => {
            this.clearCountdown();
            await this.openNextLesson();
          },
          onDisable: () => this.updateSettings({ autoNext: false }),
        });
        const number = overlay.querySelector('[data-role="seconds"]');
        const updateNumber = () => {
          if (number) number.textContent = String(remaining);
        };
        updateNumber();
        this.setStatus({
          countdownSeconds: remaining,
          message: `视频已结束，将在 ${remaining} 秒后打开下一节。`,
        });

        const timer = window.setInterval(async () => {
          remaining -= 1;
          updateNumber();
          if (remaining > 0) {
            this.setStatus({
              countdownSeconds: remaining,
              message: `视频已结束，将在 ${remaining} 秒后打开下一节。`,
            });
            return;
          }

          this.clearCountdown();
          await this.openNextLesson();
        }, 1_000);

        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            this.cancelCountdown('已取消本次自动跳转。');
          }
        };
        const onDocumentClick = (event) => {
          if (!overlay.contains(event.target)) {
            this.cancelCountdown('检测到手动操作，已取消本次自动跳转。');
          }
        };
        const onVisibilityChange = () => {
          if (document.visibilityState !== 'visible') {
            this.cancelCountdown('页面切换到后台，已取消本次自动跳转。');
          }
        };
        const onFullscreenChange = () => {
          if (document.fullscreenElement instanceof HTMLVideoElement) {
            this.cancelCountdown('进入原生视频全屏，已取消本次自动跳转。');
          }
        };
        document.addEventListener('keydown', onKeyDown, true);
        document.addEventListener('click', onDocumentClick, true);
        document.addEventListener('visibilitychange', onVisibilityChange);
        document.addEventListener('fullscreenchange', onFullscreenChange);
        this.countdown = {
          timer,
          overlay,
          cleanup: () => {
            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('click', onDocumentClick, true);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            document.removeEventListener('fullscreenchange', onFullscreenChange);
          },
        };
      } finally {
        if (token === this.countdownToken) this.countdownStarting = false;
      }
    }

    createCountdownOverlay({ onCancel, onNextNow, onDisable }) {
      const old = document.getElementById('uestc-playback-assistant-countdown');
      old?.remove();

      const overlay = document.createElement('section');
      overlay.id = 'uestc-playback-assistant-countdown';
      overlay.className = 'uestc-playback-assistant-countdown';
      overlay.setAttribute('role', 'status');
      overlay.innerHTML = `
        <div class="uestc-playback-assistant-countdown__title">本视频已播放结束</div>
        <div class="uestc-playback-assistant-countdown__body">
          <strong data-role="seconds">5</strong><span> 秒后打开下一节</span>
        </div>
        <div class="uestc-playback-assistant-countdown__actions">
          <button type="button" data-action="next" class="uestc-playback-assistant-countdown__primary">立即下一节</button>
          <button type="button" data-action="cancel" class="uestc-playback-assistant-countdown__cancel">取消本次</button>
          <button type="button" data-action="disable" class="uestc-playback-assistant-countdown__disable">关闭连续播放</button>
        </div>
      `;
      overlay.querySelector('[data-action="next"]')?.addEventListener('click', onNextNow, { once: true });
      overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', onCancel, { once: true });
      overlay.querySelector('[data-action="disable"]')?.addEventListener('click', onDisable, { once: true });
      const host = document.fullscreenElement instanceof HTMLElement
        && !(document.fullscreenElement instanceof HTMLVideoElement)
        ? document.fullscreenElement
        : (document.body || document.documentElement);
      host.appendChild(overlay);
      return overlay;
    }

    cancelCountdown(message) {
      const wasPending = Boolean(this.countdown || this.countdownStarting);
      this.clearCountdown();
      if (wasPending) this.setStatus({ countdownSeconds: null, message });
    }

    clearCountdown() {
      this.countdownToken += 1;
      this.countdownStarting = false;
      if (!this.countdown) return;
      window.clearInterval(this.countdown.timer);
      this.countdown.cleanup?.();
      this.countdown.overlay.remove();
      this.countdown = null;
    }

    findNextControl() {
      const scope = this.getCourseScope();
      if (!scope) return null;

      const playerRoot = this.activeVideo?.closest('#h5player, .xgplayer');
      const playerSelectors = [
        '.xgplayer-ended .next_video_btn',
        '.xgplayer-replay .next_video_btn',
      ];
      if (playerRoot) {
        for (const selector of playerSelectors) {
          const candidate = Array.from(playerRoot.querySelectorAll(selector))
            .find((element) => this.isActionable(element, scope));
          if (candidate) return candidate;
        }
      }

      const pageSelectors = [
        '.chapter_switch_bar .next_btn',
        '.switch_btn.next_btn',
      ];
      for (const selector of pageSelectors) {
        const candidate = Array.from(scope.querySelectorAll(selector))
          .find((element) => this.isActionable(element, scope));
        if (candidate) return candidate;
      }

      const exactText = /^(下一个|下一节|下一课|下一视频|下一个视频)$/;
      const likelyNext = /(下一个|下一节|下一课|下一视频|next)/i;
      const selector = [
        'button',
        'a',
        '[role="button"]',
        '[class*="next" i]',
        '[data-action*="next" i]',
        '[aria-label*="下一个"]',
        '[title*="下一个"]',
      ].join(',');

      const candidates = Array.from(scope.querySelectorAll(selector))
        .filter((element) => this.isActionable(element, scope))
        .map((element) => {
          const text = normalizeText(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent);
          const className = String(element.className || '');
          let score = 0;
          if (exactText.test(text)) score += 100;
          else if (likelyNext.test(text)) score += 50;
          if (element.matches('button, a, [role="button"]')) score += 20;
          if (/next/i.test(className)) score += 10;
          const rect = element.getBoundingClientRect();
          if (rect.top > window.innerHeight * 0.45) score += 5;
          return { element, text, score };
        })
        .filter(({ score }) => score >= 50)
        .sort((a, b) => b.score - a.score);

      return candidates[0]?.element || null;
    }

    isActionable(element, scope = this.getCourseScope()) {
      if (!(element instanceof HTMLElement)) return false;
      if (scope && !scope.contains(element)) return false;
      if (element.hasAttribute('disabled')
        || element.getAttribute('aria-disabled') === 'true'
        || element.classList.contains('is-disabled')
        || element.classList.contains('disabled')) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0
        || rect.height <= 0
        || rect.bottom < 0
        || rect.top > window.innerHeight
        || rect.right < 0
        || rect.left > window.innerWidth) return false;

      for (let node = element; node && node !== scope?.parentElement; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none'
          || style.visibility === 'hidden'
          || style.pointerEvents === 'none'
          || Number(style.opacity || 1) <= 0
          || node.getAttribute('aria-hidden') === 'true'
          || node.classList.contains('is-disabled')
          || node.classList.contains('disabled')) return false;
      }
      return true;
    }

    startTransition(previousSignature, expectedNext) {
      this.transition?.cleanup?.();
      this.transition = null;
      const transition = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        previousSignature,
        previousUrlResourceId: this.getResourceIdFromUrl(),
        previousMediaSource: this.activeVideo?.currentSrc || this.activeVideo?.src || null,
        courseId: this.getCourseScopeId(),
        expectedNextId: expectedNext?.id || null,
        expectedNextIds: expectedNext?.ids?.length
          ? [...new Set(expectedNext.ids)]
          : [expectedNext?.id].filter(Boolean),
        expectedNextTitle: expectedNext?.title || null,
        startedAt: Date.now(),
        permitArmed: false,
        autoplayAttempted: false,
        lastWaitReason: '等待下一节页面和播放器切换',
        cleanup: null,
      };
      const cancelForManualInput = (event) => {
        if (event.isTrusted) {
          void this.clearTransition('检测到手动操作，已停止自动续播。');
        }
      };
      const cancelForBackground = () => {
        if (document.visibilityState !== 'visible') {
          void this.clearTransition('页面切换到后台，已停止自动续播。');
        }
      };
      const cancelForHistoryNavigation = () => {
        void this.clearTransition('检测到页面导航，已停止自动续播。');
      };
      document.addEventListener('click', cancelForManualInput, true);
      document.addEventListener('keydown', cancelForManualInput, true);
      document.addEventListener('visibilitychange', cancelForBackground);
      window.addEventListener('popstate', cancelForHistoryNavigation);
      window.addEventListener('hashchange', cancelForHistoryNavigation);
      transition.cleanup = () => {
        document.removeEventListener('click', cancelForManualInput, true);
        document.removeEventListener('keydown', cancelForManualInput, true);
        document.removeEventListener('visibilitychange', cancelForBackground);
        window.removeEventListener('popstate', cancelForHistoryNavigation);
        window.removeEventListener('hashchange', cancelForHistoryNavigation);
      };
      this.transition = transition;
      return transition;
    }

    async clearTransition(message, { revokePermit = true } = {}) {
      const transition = this.transition;
      this.transition = null;
      transition?.cleanup?.();
      if (revokePermit) {
        try {
          await chrome.runtime.sendMessage({
            type: 'clear-autoplay',
            ...(transition?.id ? { grantId: transition.id } : {}),
          });
        } catch (_) {
          // The permit has a short TTL and is also checked against the video signature.
        }
      }
      if (message) this.setStatus({ countdownSeconds: null, message });
    }

    async openNextLesson() {
      if (!this.settings.autoNext || this.hasBlockingDialog()) {
        this.setStatus({ message: '检测到平台弹窗、互动内容或连续播放已关闭，未自动跳转。' });
        return;
      }
      const currentSignature = this.activeVideo ? this.videoSignature(this.activeVideo) : this.lastVideoSignature;
      if (!currentSignature || !this.activeVideo) {
        this.setStatus({ message: '未确认当前课程视频，未自动跳转。' });
        return;
      }

      const nextVideo = await this.getNextVideoGuard();
      if (!nextVideo.allowed) {
        this.setStatus({ message: `${nextVideo.reason} 未自动跳转。` });
        return;
      }

      if (!this.settings.autoNext
        || this.hasBlockingDialog()
        || !this.activeVideo
        || this.videoSignature(this.activeVideo) !== currentSignature) {
        this.setStatus({ message: '当前页面状态已变化，未自动跳转。' });
        return;
      }
      const nextControl = this.findNextControl();
      if (!nextControl) {
        this.setStatus({ message: '未找到页面中的“下一个”按钮，未自动跳转。' });
        return;
      }

      await this.clearTransition(null);
      const transition = this.startTransition(currentSignature, nextVideo.entry);
      try {
        const permit = await chrome.runtime.sendMessage({
          type: 'arm-autoplay',
          ttl: AUTOPLAY_TTL_MS,
          previousSignature: currentSignature,
          grantId: transition.id,
          courseId: transition.courseId,
        });
        if (!permit?.armed) {
          await this.clearTransition('自动续播授权未建立，未打开下一节。');
          return;
        }
        transition.permitArmed = true;
      } catch (error) {
        await this.clearTransition('下一节已打开，但无法建立自动续播授权。');
        console.warn('[UESTC Playback Assistant] Could not arm auto-play.', error);
        return;
      }

      if (this.transition?.id !== transition.id) {
        try {
          await chrome.runtime.sendMessage({ type: 'clear-autoplay', grantId: transition.id });
        } catch (_) {
          // The short grant will expire and cannot be consumed without its matching id.
        }
        return;
      }

      try {
        nextControl.click();
      } catch (error) {
        await this.clearTransition('无法点击“下一个”按钮；未继续播放。');
        console.warn('[UESTC Playback Assistant] Could not activate next control.', error);
        return;
      }

      this.setStatus({ message: '已请求打开下一节；仅在识别到新的课程视频后继续播放。' });
      void this.tryPendingAutoplay(transition);
      void this.waitForVideoChange(transition);
    }

    async waitForVideoChange(transition) {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (this.transition?.id !== transition.id) return;
        await sleep(400);
        const candidate = this.pickVideo();
        transition.lastWaitReason = this.describeAutoplayWait(transition, candidate);
        if (!candidate) continue;
        const signature = this.videoSignature(candidate);
        const targetIsLocallyVisible = this.isExpectedTargetVisible(transition);
        if (signature === transition.previousSignature && !targetIsLocallyVisible) continue;

        if (candidate !== this.activeVideo) this.bindVideo(candidate);
        if (this.isAutoplayCandidate(candidate)) {
          await this.tryPendingAutoplay(transition);
          if (this.transition?.id !== transition.id) return;
        }
      }

      if (this.transition?.id === transition.id) {
        await this.clearTransition(`下一节未自动续播：${transition.lastWaitReason}。`);
      }
    }

    async tryPendingAutoplay(expectedTransition = this.transition) {
      const transition = expectedTransition;
      const video = this.activeVideo;
      if (!transition
        || this.transition?.id !== transition.id
        || !transition.permitArmed
        || transition.autoplayAttempted
        || !video
        || !this.canContinueAutoplay(video)) return;

      if (!this.hasNewMediaSource(transition, video)) {
        transition.lastWaitReason = '播放器仍加载上一节的视频地址';
        return;
      }

      const currentSignature = this.videoSignature(video);
      const targetIsLocallyVisible = this.isExpectedTargetVisible(transition);
      if (currentSignature === transition.previousSignature && !targetIsLocallyVisible) return;
      if (this.getCourseScopeId() !== transition.courseId) {
        await this.clearTransition('课程上下文已变化，已停止自动续播。');
        return;
      }
      const targetConfirmed = await this.isExpectedTransitionTarget(transition);
      if (!targetConfirmed
        || this.transition?.id !== transition.id
        || transition.autoplayAttempted
        || !this.canContinueAutoplay(video)
        || this.videoSignature(video) !== currentSignature) {
        if (this.transition?.id === transition.id && !targetConfirmed) {
          transition.lastWaitReason = '新视频已就绪，但目录身份核验尚未通过';
        }
        return;
      }
      if (!video.paused) {
        await this.clearTransition(null);
        this.setStatus({ message: '下一节已由平台开始播放。' });
        return;
      }

      transition.autoplayAttempted = true;
      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: 'consume-autoplay',
          previousSignature: transition.previousSignature,
          currentSignature,
          grantId: transition.id,
          courseId: transition.courseId,
        });
      } catch (_) {
        await this.clearTransition('自动续播授权已失效；请手动点击播放。', { revokePermit: false });
        return;
      }
      if (this.transition?.id !== transition.id) return;
      if (!response?.allowed) {
        await this.clearTransition('自动续播授权已失效；请手动点击播放。', { revokePermit: false });
        return;
      }

      const playback = await this.startVerifiedNextVideo(transition, video, currentSignature);
      if (this.transition?.id !== transition.id) return;
      if (!playback.started) {
        const message = playback.usedPlayerControl
          ? '播放器未能自动开始下一节，请手动点击中央播放按钮。'
          : '浏览器阻止了自动播放，请手动点击播放。';
        await this.clearTransition(message, { revokePermit: false });
        return;
      }

      await this.clearTransition(null, { revokePermit: false });
      this.setStatus({
        message: playback.keptMuted
          ? '已静音自动开始下一节；如需声音请点击播放器。'
          : playback.usedMutedAutoplay
            ? '已自动开始播放下一节。'
            : playback.usedPlayerControl
              ? '已通过播放器中央控件开始播放下一节。'
              : '已开始播放下一节。',
      });
    }

    async handleSettingsChanged() {
      this.clearCountdown();
      if (!this.settings.autoNext) void this.clearTransition(null);
      this.applySpeed(this.activeVideo);
      this.setStatus({
        autoNext: Boolean(this.settings.autoNext),
        speed: this.activeVideo?.playbackRate || this.settings.speed,
        countdownSeconds: null,
        message: this.settings.autoNext ? '连续播放已开启。' : '连续播放已关闭。',
      });
    }

    applySpeed(video) {
      if (!(video instanceof HTMLVideoElement)) return;
      const speed = Number(this.settings.speed);
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) return;
      try {
        video.playbackRate = speed;
        video.defaultPlaybackRate = speed;
        if (Math.abs(video.playbackRate - speed) > 0.01) {
          this.setStatus({ message: `播放器未接受 ${this.formatSpeed(speed)} 设置。` });
        }
      } catch (error) {
        this.setStatus({ message: `播放器不支持 ${this.formatSpeed(speed)} 设置。` });
        console.warn('[UESTC Playback Assistant] Could not set playback rate.', error);
      }
    }

    async changeSpeed(direction) {
      const current = Number(this.settings.speed) || 1;
      const index = SPEED_STEPS.reduce((closest, value, valueIndex) => (
        Math.abs(value - current) < Math.abs(SPEED_STEPS[closest] - current) ? valueIndex : closest
      ), 0);
      const nextIndex = Math.max(0, Math.min(SPEED_STEPS.length - 1, index + direction));
      await this.updateSettings({ speed: SPEED_STEPS[nextIndex] });
    }

    async updateSettings(patch) {
      this.settings = { ...this.settings, ...patch };
      try {
        const { settings = {} } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...settings, ...patch } });
      } catch (error) {
        console.warn('[UESTC Playback Assistant] Could not persist settings.', error);
      }
      this.handleSettingsChanged();
      try {
        await chrome.runtime.sendMessage({ type: 'settings-changed-locally', settings: patch });
      } catch (_) {
        // The setting still affects the current page.
      }
    }

    formatSpeed(speed) {
      return `${Number(speed).toFixed(2).replace(/\.00$/, '')}×`;
    }

    showNotice(message) {
      const old = document.getElementById('uestc-playback-assistant-notice');
      old?.remove();
      const notice = document.createElement('div');
      notice.id = 'uestc-playback-assistant-notice';
      notice.className = 'uestc-playback-assistant-notice';
      notice.textContent = message;
      document.documentElement.appendChild(notice);
      window.setTimeout(() => notice.remove(), 5_000);
    }

    setStatus(patch) {
      this.status = {
        ...this.status,
        ...patch,
        autoNext: Boolean(this.settings.autoNext),
        speed: patch.speed ?? this.activeVideo?.playbackRate ?? this.settings.speed,
      };
      this.reportStatus();
    }

    reportStatus() {
      // Content scripts can briefly outlive a service-worker restart. In MV3
      // sendMessage returns a Promise, so a synchronous try/catch is not enough.
      void chrome.runtime
        .sendMessage({ type: 'status', status: this.status, isTopFrame: FRAME_IS_TOP })
        .catch(() => {});
    }

    dispose() {
      this.clearCountdown();
      this.domObserver?.disconnect();
      this.unbindVideo();
    }
  }

  const assistant = new CoursePlaybackAssistant();
  assistant.start();
})();

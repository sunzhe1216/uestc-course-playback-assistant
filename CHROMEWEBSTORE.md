# Chrome Web Store Listing — 成电课程播放助手

> Last Updated: 2026-10-06

## Store Listing

**Extension Name**：成电课程播放助手

**Short Description**：为 resource.uestc.edu.cn 的课程视频提供倍速和连续播放辅助。

**Detailed Description**：

成电课程播放助手为成电教学资源管理平台的课程视频提供倍速与连续播放辅助，减少真实观看课程时重复点击下一节的操作。

支持 0.5× 至 2× 的预设播放速度，自动记住倍速和连续播放开关。
启用连续播放后，视频自然结束时显示 5 秒倒计时。倒计时可取消，也可立即进入下一节。
只有紧邻的下一项能够被确认为已发布的视频时才继续播放；进入文档、音频、超链接或互动内容时会停止并提示，不会自动跳过。
切换到下一视频后尝试自动开始播放。如果浏览器不允许有声自动播放，会尝试静音起播并提示用户恢复声音；若仍无法起播，则提示手动点击播放器。
提供提速、降速和连续播放开关的快捷键。

使用方法：安装后打开 resource.uestc.edu.cn 的课程播放页，点击工具栏中的扩展图标，选择倍速并手动开启连续播放。连续播放默认关闭。

本扩展是个人开源项目，并非学校或课程平台官方产品。不伪造学习记录，不自动答题，不绕过验证码、签到或平台校验，不保证倍速观看会被平台计入指定学习时长。

设置只保存到当前浏览器本地。扩展读取当前课程页和课程平台的只读目录，以识别播放器与下一项；不向开发者或第三方服务器上传账号、课程内容或播放记录。

支持与反馈：https://github.com/sunzhe1216/uestc-course-playback-assistant/issues

**Category**：Productivity（生产力工具；提交时核对后台可选项）

**Single Purpose**：为 resource.uestc.edu.cn 指定课程页的真实视频观看提供倍速和可取消的连续播放辅助。

**Primary Language**：简体中文

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|------------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | 待提供或制作 | 未提供 |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | 待制作并确认与实际版本一致 | 未提供 |
| Small Promo Tile [RECOMMENDED] | 440×280 | 未制作 | 未提供 |

运行清单目前没有引用 PNG 图标，因此不存在缺失图标文件的问题；商店展示图标和截图仍需单独补齐。截图应展示实际视频播放页、倍速选择或倒计时，不得展示尚未实现的非视频自动阅读功能。

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| storage | permissions | 在浏览器本地保存用户选择的倍速与连续播放开关，并在浏览器会话内保存短期、一次性的下一视频续播许可；不使用云同步。 |
| tabs | permissions | 在弹窗打开时识别当前标签页是否为目标课程播放页，并将设置和播放器状态关联到正确标签页。仅使用当前目标页的信息，不收集或保存浏览历史。 |
| https://resource.uestc.edu.cn/learn/course/detail/spoc/courseWare/* | host_permissions | 仅在指定课程播放页识别并控制正常视频播放、显示可取消倒计时、点击平台已有的下一节入口。不会在其他网站注入脚本。 |

目录请求由目标课程页向同源平台发送，只读查询，不需要新增全站或外站权限。

## Privacy & Data Use

**Does the extension collect user data?**：不向开发者收集或上报数据；存在为核心功能所需的本地处理和平台同源目录请求。提交表单时应依据其实际字段准确披露，不得将本扩展描述为“完全不访问任何页面信息”。

| Data Type | Handled Locally? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------------|------------------------|---------|---------------------------|
| Personally identifiable info | 不主动读取 | 不向开发者上传 | 无 | 否 |
| Health / financial info | 否 | 否 | 无 | 否 |
| Authentication info | 不提取或存储凭据 | 同源目录请求使用平台已有登录会话 | 正常访问当前课程目录 | 不另行共享 |
| Personal communications / location | 否 | 否 | 无 | 否 |
| Web history | 不收集浏览历史；即时判断当前课程页地址 | 不向开发者上传 | 判断当前页是否受支持 | 否 |
| User activity | 短暂处理当前播放状态与本地偏好 | 不向开发者上传 | 正常倍速与续播控制 | 否 |
| Website content | 短暂处理当前标题、目录和媒体地址 | 只向原课程平台发起目录读取请求 | 确认当前视频与紧邻的下一项 | 不向第三方共享 |

### Data Use Certification

- [x] Data is NOT sold to third parties.
- [x] Data is NOT used for purposes unrelated to the extension's core functionality.
- [x] Data is NOT used for creditworthiness or lending purposes.

## Privacy Policy

**Privacy Policy URL**：https://github.com/sunzhe1216/uestc-course-playback-assistant/blob/main/PRIVACY.md

对应本仓库 `PRIVACY.md`。需在推送后确认公开访问成功，再填入后台。

## Distribution

**Visibility**：后台未核对，不更改既有设置；如首次上架，需确认分发设置。

**Regions**：后台未核对，不更改既有设置。

## Developer Info

**Publisher Name**：使用后台现有发布者身份，尚未核对。

**Contact Email**：待用户确认或核对后台已有公开支持邮箱；不从本机 Git 配置或登录账号擅自提取并公开邮箱。

**Support URL**：https://github.com/sunzhe1216/uestc-course-playback-assistant/issues

**Homepage URL**：https://github.com/sunzhe1216/uestc-course-playback-assistant

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.2 | 2026-10-06 | 核对已有视频倍速与续播代码；补充发布、隐私说明及打包脚本。扩展运行代码和版本号未改变，不包含非视频资源临时测试脚本。 | Draft；商店是否存在旧条目尚未核对 |

## Review Notes

### Known Issues / Limitations

- 仅支持指定课程视频页；文档、音频、超链接、互动内容及外站自动滚动尚未实现。
- 浏览器或平台限制可能使下一视频只能静音起播或需要手动点击。
- 视频自然播放结束时可能因页面不在前台、全屏、平台弹窗、目录类型不明或到达最后一节而停止连续播放。
- 课程平台账号和课程访问权限由平台管理；扩展不提供测试账号、不绕过访问控制。
- 当前未取得 Chrome 商店条目编号或已发布版本。没有上传或提交审核的成功证据，不能将 Draft 标记为 Submitted 或 Published。

### Package & Checks

在仓库根目录执行：

```powershell
node --check content.js
node --check background.js
node --check popup.js
node --test tests/background-smoke.test.js tests/content-transition.test.js
./scripts/package-extension.ps1
```

输出：`dist/uestc-course-playback-assistant-v1.0.2.zip`，根目录包含 manifest 与运行文件，以及 MIT 许可；不包含 `.git`、测试、发布说明、README、截图或私密配置。打包脚本输出 SHA256，且不会覆盖同名旧包。

2026-10-06：三份脚本语法检查与 17 项自动化测试通过；本地与 GitHub 原有运行代码一致。最近一次真实课程视频续播已由用户验证，非视频原型测试不代表正式功能。商店上线仍需后台身份、版本、展示素材和隐私字段核对。

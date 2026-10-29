# Official connector icons

The user supplied these official asset URLs on 2026-10-09. The downloaded files are preserved
unchanged and bundled for offline rendering. `src/renderer/modules/icons.js` registers them through
`uiIconHtml`; fixed square CSS image viewports select the recognizable mark without raster resampling.
The connector card keeps its existing 32px slot and 6px padding.

| Connector | Original source | Selected mark | Square viewport |
| --- | --- | --- | --- |
| NetEase 163 | [Official sprite](https://mimg.127.net/p/js6/theme/build/lightblue/img/314d19b1d75dc1e4e8bc4229018559944b322ad5.png) | Red `163` digits, excluding the adjacent text and other sprite rows | `412 -31 124 124` |
| QQ Mail | [Official logo](https://res.wx.qq.com/t/webmail/webmail/res/images/logo-theme-default.eb00ccc.png) | Multicolor circular mark, excluding the letters and wordmark | `138 29 60 60` |
| Tencent Meeting | [Official logo](https://cdn.meeting.tencent.com/pro/Y2JmNmM1ODYtNGFmYS00MzNkLWFhNDItOWJkOGUzODc5M2Ri.svg) | Blue folded mark at the left, excluding the Chinese wordmark | `0 -8.5 40 40` |
| Tencent Survey | [Official logo](https://wj-assets.gtimg.com/logo.png) | Green check and blue folded base | `0 0 160 160` |
| Feishu | [User-supplied logo](https://p1-hera.feishucdn.com/tos-cn-i-jbbdkfciu3/eff71c9398c04ebd8452d748646fc1e8.png~tplv-jbbdkfciu3-png:0:0.png) | Green and blue bird, excluding the wordmark | `0 -7 62 62` |
| WeCom | [User-supplied official sprite](https://wwcdn.weixin.qq.com/node/wwnl/wwnl/style/images/officialImages$h66b2153.svg) | Blue speech outline and four-color detail, selecting the standalone mark at `96 240` | `96 237.5 31 31` |
| DingTalk | [User-supplied logo](https://img.alicdn.com/imgextra/i1/O1CN01jLpUMhpVLQF0ShUI_!!6000000004768-2-tps-228-126.png) | Dark wing/lightning mark, excluding the wordmark | `14 14 84 84` |
| Tencent Docs | [User-supplied open-platform logo](https://docs.gtimg.com/open/image/logo_docs_open_48-4732d25a1d.svg) | Blue document with cyan fold and white symbol, excluding the wordmark | `0 -3.5 55 55` |
| WPS cloud documents | [User-supplied KDocs logo](https://volcengine-kdocs-cache.wpscdn.cn/s1/static/images/d42a7af3100b01a49b8c.svg) | Full blue geometric mark | `0 0 24 24` |

The enterprise mail connector retains the shared `mail` icon. These files are included by the
existing `src/resources/icons/**/*` packaging rule; rendering never fetches a remote icon.

# 馆际档案交接柜

这个服务保存交付袋的人工收件、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。当前没有自动来源接入接口。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。演示同时覆盖人工收件与薄袋补件验收全流程（含来源首次 503 后的补件重试）。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `bagId, payloads, verification`，其中 `bagId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口不推断自动采集是否完整；新增来源接入可以扩展领域状态，但应保留这些已用接口。

`fixtures/manual.json` 是可用的人工收件样例。`npm run demo` 实际启动两个本地服务，执行人工提交、重复收件和原始依据回查；它只展示现有产品，不展示尚未提供的自动采集结果。新增自动流程之后，可继续使用本地来源完成端到端验证，不用外部网络。

## 薄袋补件与验收

针对只在 `fetch.txt` 列出大文件的 BagIt 薄袋，收件柜提供登记、补件与验收能力，避免“目录和清单都在就点接收、正文却没送到”。登记后立即给出三态结论：`incomplete`（缺件）、`failed`（内容校验失败或结构不合规）、`ready`（具备交接条件）。payload 清单与 tagmanifest 分别验收、互不替代；同一正文在多个算法清单中的结论独立保留，冲突显式上报而不被后读清单覆盖。补件只从获准地址下载，先落独立暂存区，长度与全部算法摘要校验通过后才提升进袋目录；失败字节留在暂存区作为证据，合作方原件只读不回填。每次验收都把当时依据的清单摘要写入报告，补件重试后可复核历史结论。完整规则与接口见 `docs/bag-intake.md`。

主要接口：`POST /api/bags` 登记薄袋；`POST /api/bags/:bagId/complete` 按 `fetch.txt` 补件并重新验收（可重试）；`GET /api/bags`、`GET /api/bags/:bagId`、`GET /api/bags/:bagId/reports` 查询状态与历次报告；`GET /api/bags/:bagId/file/<袋内相对路径>` 取回袋内文件。补件获准来源可用 `ALLOWED_FETCH_ORIGINS`（逗号分隔的 origin）追加，单个补件大小上限为 `MAX_FETCH_BYTES`（默认 256 MiB）。

## 容器

```sh
docker build -t archive-bags-intake .
docker run --rm --network none archive-bags-intake npm test
docker run --rm --network none archive-bags-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。

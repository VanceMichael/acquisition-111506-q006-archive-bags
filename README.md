# 馆际档案交接柜

这个服务保存交付袋的人工收件、自动补件验收、历史版本和原始依据。重复提交相同业务内容与依据返回原收件；内容变化形成历史版本，原始字节用内容摘要回查。合作来源运行在本机，具体交互见 `docs/source-contract.md`。

## 运行环境

需要 Node.js 22.22.1 至 22.x，使用内置模块，没有第三方依赖。依赖锁文件随代码保存；`npm ci --offline --ignore-scripts --no-audit --no-fund` 不会下载包。数据目录默认是 `var`，可用 `DATA_DIR` 指定；不可让两个进程同时写同一目录。来源和收件服务默认只监听回环地址，不使用真实机构账号或外网数据。

## 开发与运行

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
npm run build
npm test
npm run demo
```

`npm start` 启动收件服务，默认端口4310；另一终端用 `npm run source` 启动来源端，默认端口4311。可分别通过 `PORT`、`SOURCE_PORT` 修改端口。测试和演示使用系统分配的端口，结束时关闭服务并删除临时收件数据，不需要固定等待时间。

## 已有收件接口

`GET /health` 查看状态；`POST /api/manual` 接收 `record` 和 `evidence`。业务内容需要 `bagId, payloads, verification`，其中 `bagId` 是已有人工收件标识。每份依据包含来源 `source`、原始字节 `bytesBase64`，可选 `mediaType` 和需要核对的 `sha256`。`GET /api/records` 返回当前版本，`GET /api/history?key=...` 返回单个业务标识的历史，`GET /api/evidence/摘要` 返回原始字节。人工入口不推断自动采集是否完整；自动层在同一业务键上增加 payload 状态和 tag 验证记录，已用接口保持不变。

`fixtures/manual.json` 是可用的人工收件样例。`npm run demo` 实际启动两个本地服务，执行人工提交、重复收件、原始依据回查，以及自动补件验收、交接状态查询和正文回查，全程只用本地来源，不用外部网络。

## 自动交接接口

`POST /api/collect` 按 BagIt 1.0（RFC 8493）从合作来源接收薄袋。请求体可带 `source`（默认 `SOURCE_URL`，否则 `http://127.0.0.1:4311`）和 `bagPath`（默认 `/bags/demo`）。接收过程：下载目录清单中的标签文件与已在袋内的 payload；解析 payload manifest、tagmanifest 和 fetch.txt；只从获准地址补齐 fetch.txt 列出的缺件（默认限来源自身来源域，可用环境变量 `FETCH_ALLOWED_ORIGINS` 逗号分隔扩展；只允许 http/https，不跟随重定向），暂时失败会重试。下载先写入独立暂存目录（`staging/`），校验通过才移入交付目录（`bags/` 下按业务标识散列命名），暂存目录在结束后清理，接收过程的临时文件不会混同真正交付内容。

验收把 payload 清单和 tagmanifest 分开报告，两者证明的对象不同，任何一类通过都不能代替整袋通过。每个算法各自核对、各自记录：同一正文出现在多个算法清单时，任一算法失败即失败，不会被后读的清单覆盖；同一清单内同路径摘要冲突、目录与 fetch.txt 的同名对象、编码等价（NFC）路径都会被检测为冲突而不是静默合并。fetch.txt 的袋内路径只按规范解码一次，拒绝 `..`、绝对路径、反斜线和控制字符，下载不会写出袋目录。整体状态有三种：`incomplete`（缺件，正文尚未补齐）、`failed`（内容校验失败，含摘要不符、清单冲突、路径问题等）、`complete`（具备交接条件）。每次接收把当时依据的清单（manifest、tagmanifest、fetch.txt 等标签文件）作为原始依据保存，合作方原件不被修改；补件重试形成新的历史版本，之前版本依据的清单仍可按摘要回查复核。

`GET /api/bags/status?key=...` 返回该业务标识最近一次自动交接的状态，含中文状态说明（缺件 / 内容校验失败 / 具备交接条件）、payload 与 tag 分项结果和依据清单摘要；`GET /api/bags/files?key=...` 列出已交付文件，`GET /api/bags/files?key=...&path=...` 取回单个交付文件字节，缺件返回 404。

## 容器

```sh
docker build -t archive-bags-intake .
docker run --rm --network none archive-bags-intake npm test
docker run --rm --network none archive-bags-intake npm run demo
```

镜像内容由 Dockerfile 的 SHA256 摘要固定；Node.js 22 主版本标签与 package.json 的 >=22.22.1 <23 兼容范围对应，验证环境可使用该范围内的补丁版本。构建需要本地已有该基础镜像；正式运行、测试和演示不安装系统包、不下载模型或数据。服务默认数据放在容器内临时目录，持久运行时可挂载单独卷。演示完整输出可在90秒内展示，不播放预先保存的日志。

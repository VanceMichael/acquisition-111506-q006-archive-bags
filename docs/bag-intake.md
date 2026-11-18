# 薄袋补件与验收说明

本文说明交接柜对 BagIt 1.0（RFC 8493）薄袋的登记、补件与验收。薄袋把大文件只写在 `fetch.txt`，
袋目录里没有正文；交接柜不再因为“目录和清单都在”就点接收，而是显式区分三种状态：

| 状态 | 含义 | 能否交接 |
| --- | --- | --- |
| `incomplete` | 缺件：仍有 payload 或标签文件未补齐 | 否 |
| `failed` | 内容校验失败或结构不合规（摘要不符、长度不符、路径冲突等） | 否 |
| `ready` | payload 清单与 tagmanifest 分别验收通过 | 是 |

## 两类证明分别验收，互不替代

- `manifest-<算法>.txt` 是 **payload manifest**，只证明 `data/` 下的正文。
- `tagmanifest-<算法>.txt` 只证明标签文件（`bagit.txt`、`bag-info.txt`、payload manifest、`fetch.txt` 等），
  不证明任何正文。
- 因此 tagmanifest 全部通过、但正文缺失时，整袋仍是 `incomplete`；正文齐全但标签证明不符时，整袋 `failed`。
  报告里 `payload` 与 `tag.manifests` 两段分别列出每个条目的 `ok / missing / mismatch`。
- 同一正文出现在多个算法清单时，按 `(算法, 路径)` 独立保留结论，任一算法不通过即整袋不通过；
  若不同算法给出互相矛盾的结论，会在 `structural` 中记录 `manifestConflict`，不会被最后读取的清单覆盖。

## 路径按交接格式解释

- 清单与 `fetch.txt` 的袋内路径只对 LF、CR、百分号本身做 RFC 8493 转义反转义；
  普通百分号序列（如 `%2F`、`%41`）保持字面，不做 URL 解码，也不会反复解码。
- 袋内路径必须是相对路径，拒绝绝对路径、反斜杠、空段、`.`、`..` 与 NUL；落盘前再用目录包含检查兜底，
  任何下载或读取都不能写出袋目录。
- 字面不同但 NFC 归一化后相同的路径（编码差异造成的同名对象）会触发 `encodingCollision`，
  不会被静默合并或覆盖。

## 补件只走获准地址

- `fetch.txt` 每个条目的 URL 来源（origin）必须在登记时记录的获准清单内：默认是合作来源自身的 origin，
  可在登记请求里用 `allowedOrigins` 追加，也可用环境变量 `ALLOWED_FETCH_ORIGINS`（逗号分隔）放行。
- 未授权地址直接拒绝（422），不会发起任何下载请求；HTTP 重定向不跟随，避免被引到未授权来源。
- `fetch.txt` 列出的正文若在登记时就已内联在袋目录，会与所有 payload 清单核对：字节正确视为该正文已补齐，
  字节与任一清单不符则判 `fetchAndInlineConflict`（来源同时内联了错误正文）。

## 暂存与原件隔离

- 每个袋在数据目录下有独立的 `bag/`（合作方原件，只写一次、绝不覆盖）与 `staging/`（临时文件）。
- 下载先流式写入 `staging/fetch-*.part`，同时按所有相关算法计算摘要并做大小限额
  （`MAX_FETCH_BYTES`，默认 256 MiB）。
- 长度与 `fetch.txt` 声明不符、或任一算法摘要与 payload 清单不符：失败字节改名保留在
  `staging/failed-*.part` 作为证据，绝不提升进 `bag/`，整袋判 `failed`。
- 只有全部校验通过的暂存文件才会原子提升进 `bag/`，提升时若目标已存在则拒绝覆盖。
- 合作来源的袋目录始终只读，补件不会回填或修改来源端任何文件。

## 可复核的验收报告

- 每次登记、每次补件前后都会生成一份报告，顺序追加到 `bags/<袋标识>/bag-journal.jsonl`，历史报告不被覆盖。
- 每份报告的 `basis` 记录当时依据的每份 payload manifest、tagmanifest、`fetch.txt`、`bagit.txt` 的 SHA256，
  补件重试后仍可复核当时结论依据的是哪一版清单；原始字节同时进入内容寻址库 `blobs/`。
- `attempts` 记录每次补件尝试的地址、时间与结果（`promoted / fetch-failed / length-mismatch / digest-mismatch`）。

## HTTP 接口

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/bags` | 登记薄袋。请求体 `{ "sourceBaseUrl": "...", "bagPath": "bags/demo", "bagId": "可选", "allowedOrigins": [] }`，返回登记信息与首份验收报告 |
| `GET /api/bags` | 列出所有袋及最新状态 |
| `GET /api/bags/:bagId` | 单袋登记信息与最新报告 |
| `POST /api/bags/:bagId/complete` | 按 `fetch.txt` 补件并重新验收（可重试，请求体可带 `reason`） |
| `GET /api/bags/:bagId/reports` | 历次验收报告 |
| `GET /api/bags/:bagId/file/<袋内相对路径>` | 取回袋内文件（路径按交接格式解释，越界返回 422） |

已有的 `/api/manual`、`/api/records`、`/api/history`、`/api/evidence/*` 接口保持不变。

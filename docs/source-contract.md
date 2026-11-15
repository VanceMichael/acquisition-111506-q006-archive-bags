# 馆际档案交接柜：合作来源契约

起始点是`/bags/demo`，这里本地合成了BagIt 1.0薄袋。该入口返回版本及`files`文件名清单，清单中的每个文件都可以通过`GET /bags/demo/{袋内相对路径}`取得；尚未补齐的正文不在该清单中。`manifest-md5.txt`是payload manifest；`tagmanifest-md5.txt`与`tagmanifest-sha256.txt`只覆盖tag文件。`fetch.txt`遵循RFC8493，每行依次为下载URL、十进制字节长度或`-`、UTF-8袋内相对路径；URL使用URI编码规则，袋内路径仅将LF、CR、CRLF和百分号按规范转义，不能对普通斜线套用URL解码或反复解码。样例只列出需要远程补齐的`data/images/map.bin`，其余payload可从袋目录领取。来源按实际监听地址生成下载URL，不能假定端口固定。网络补件可以重试，目标未取得前袋不是完整状态；补件临时文件必须放独立暂存位置。

payload manifest覆盖`data/`内所有payload的MD5，两个tagmanifest分别覆盖所有非tagmanifest标签文件，包括payload manifest及实际返回的fetch.txt字节。接受时要分开报告两类验证；不得把tagmanifest通过解释成payload完整，多个tagmanifest也不能互相覆盖。来源同时展示两个tag算法。SHA256用于收件原文证据，不要求比较不同摘要算法数值。

路径以袋相对UTF-8路径解释，重名/编码等价路径要检测而不是写出覆盖。fetch端拒绝`..`。该合成来源将图片第一次请求返回503，之后可重取。袋目录本身不能被回填；完成状态和当时校验清单可另行保存。现有人工业务键是bagId，自动层允许增加payload状态和tag验证记录。

## 来源与支持范围

格式参考：`https://www.rfc-editor.org/rfc/rfc8493.html`。这里运行的是只含虚构资料的本地合作端，不是公网生产服务；只需支持本文明确给出的范围。来源实现和样例可以阅读，自动接入应使用声明的交互入口，不把服务内部对象或预先写好的采集结论当作数据来源。原始依据、结构化内容和完整性状态应能在收件端回查；新增自动接口的名称与内部设计由开发者决定。

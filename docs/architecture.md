# 模块及验收约定

## 阅读与位置

`ReaderAdapter` 管理一个 foliate-view 生命周期、串行导航、加载监听、原文选区、高亮和学习展示。`LocationAdapter` 对 CFI 生成和解析使用相同的节点过滤；解释节点有 `data-reader-ui` 标志。上游依赖不被修改。元素选区先转成文字边界，避免整个段落的 Element offset 被误认为文本 offset。

Locator 保存文件哈希、章节、CFI、原文引用和前后各 40 字符。引用/上下文不匹配时拒绝跳转，不按相似文字猜测位置。进度捕获原文中的折叠 Range，布局重排期间无效的临时位置不覆盖上次有效位置。

## 内容与搜索

`ContentService` 从未插入解释的章节文档提取段落，不读取界面 DOM。嵌套目录的无链接分组使用第一个可导航子项作为目标。章节按需读取并缓存文本，不为 AI 切换页面。

`SearchService` 管理独立 Worker 的请求及生命周期。传给 Worker 的是纯文本与可序列化位置。`PassageIndex` 使用 Intl.Segmenter 分词，MiniSearch 查询；分词策略在建立索引和查询时相同。书籍更换后关闭旧 Worker，不接受旧搜索结果。

共享接口：getOutline、searchBook、readPassage、readSection。读取片段最多扩展前后各三段；章节接口使用字符游标，可继续读取超长段落。navigateTo 仅由读者操作触发。

## 记录与备份

Dexie v1 四张表：books、progress、annotations、learning。个人记录独立于可重建检索索引。原文件哈希相同才关联；原始 EPUB 不改写。

备份格式标识 incremental-reader、version 1。先完整校验，再在同一事务合并三张个人数据表。相同位置保留较新记录，重复导入幂等，ID 跨位置冲突时整个事务回滚。无书籍本体时也保留记录，等待以后导入原始 EPUB。备份不包含会话模型设置。

## 模型与工具

`modelClient` 使用一次性 JSON Chat Completions 请求，拒绝带凭据/查询参数的 URL，禁止重定向，密钥只在内存。错误提示不显示提供商响应正文。解释结果完整返回且请求未取消后才保存。

`BookToolSession` 与读者共用 SearchService / ContentService。工具结果中的书籍文本作为不可信资料提供；工具没有导航、写记录或任意执行入口。所有返回给模型的搜索摘录和原文片段均计入 30,000 字符预算，最多执行八次工具调用。

只有实际 readPassage/readSection 返回的片段会生成 R 编号；最终回答中的未知编号被替换为未验证引用。引用卡片显示工具实际读取的原文，不把模型自己生成的引文当作来源。

## 已选择的取舍

- 非流式模型响应：解释完整返回后一次插入，减少重排。
- 底部选区操作面板：替代悬浮气泡，减少跨 iframe 坐标和遮挡问题。
- 索引仅内存/Worker 缓存，打开书籍时重建；个人数据持久化。
- 当前使用静态站点和本机服务；不包含同步、后台模型代理或离线安装。

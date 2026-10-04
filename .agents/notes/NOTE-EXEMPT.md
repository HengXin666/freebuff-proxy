note-exempt: 修改 `scripts/screenshot-mock-upstream.mjs` 用于重生成 README 截图.

它不是产品运行时代码:只在本地起一个假上游(mock),给截图脚本喂数据,
不参与真实请求链路,不影响运行行为,没有对外契约.

具体改动:给它补了 `/api/v1/freebuff/models` 目录端点(rows 含 displayName
与 legacyDigests),并把额度键改成目录 key(m-xxx)—— 目的是让**截图**能体现
[总览额度列显示模型名而非裸 key]这个修复.改的是演示数据形态,不是协议实现
(真实协议实现在 cli-bridge/ 与 src/upstream/,均已另有 note 覆盖).

同类先例:截图产物(docs/images)与生成脚本历来不写 note.
MSG
git add -A && git commit -q -F /tmp/mm.txt && git log --oneline -1 && git status --porcelain; echo "(clean)"
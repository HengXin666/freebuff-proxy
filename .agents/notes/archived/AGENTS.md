# AGENTS.md — Archived Agent Notes

这里的 note 是冻结的历史快照, **不是当前行为的权威**. 永不编辑、重排版、翻译、修补或删除任何一篇.
每篇的状态行下面带一行 `Archived: YYYY-MM-DD`, 字节被封存在 `manifest.json` 里;
任何漂移都会让门禁失败.

归档一篇 note 用 `node .agents/skills/hx-agent-notes/scripts/archive-note.ts .agents/notes/implemented/<class>/<file>.md`: 它会移动文件、盖上 seal 行、
报告入站链接, 并更新 manifest.

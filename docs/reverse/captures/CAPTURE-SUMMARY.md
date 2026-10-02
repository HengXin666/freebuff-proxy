# 抓包摘要（自动生成，勿手改）

源: `2026-10-03-official-client.jsonl`  
chat/completions 样本数: **8**

## 全部请求（按序）

- [0] HEAD / → None
- [1] GET /api/v1/freebuff/session → None
- [2] HEAD / → 200
- [3] GET /api/v1/freebuff/session → 200
- [4] GET /api/v1/freebuff/session → None
- [5] GET /api/v1/freebuff/session → None
- [6] GET /api/v1/freebuff/session → 200
- [7] GET /api/v1/freebuff/session → 200
- [8] POST /api/v1/freebuff/session/admission → None
- [9] POST /api/logs → None  (body 548 B)
- [10] POST /api/v1/freebuff/session/admission → 200
- [11] POST /api/v1/agent-runs → None  (body 75 B)
- [12] POST /api/logs → 200
- [13] POST /api/v1/agent-runs → 200

### [14] POST /api/v1/chat/completions → None  (19364 B)
- **layer**: manager(decide)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"auto"`
- provider: `{"allow_fallbacks": true}`
- tools (1): decide
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, llm_step_number, repo_snapshot, run_id, trace_session_id
- messages (2): system, user
- system 首 120 字符: `You are Buffy, the auto-run agent behind Freebuff Desktop. You decide what one tab does next.

The mission quoted at the…`
- [15] HEAD / → None
- [16] HEAD / → 200
- [17] GET /api/v1/freebuff/session → None
- [18] GET /api/v1/freebuff/session → 200
- [19] HEAD / → None
- [20] HEAD / → 200
- [21] GET /api/v1/ads/proposal?workspace=858b1d11-19e6-409b-9c40-fb295653c9b6&surface=desktop → None
- [22] GET /api/v1/ads/proposal?workspace=858b1d11-19e6-409b-9c40-fb295653c9b6&surface=desktop → 200
- [23] HEAD / → None
- [24] HEAD / → 200
- [25] POST /api/v1/chat/completions → 200

### [26] POST /api/v1/chat/completions → None  (21043 B)
- **layer**: manager(decide)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"auto"`
- provider: `{"allow_fallbacks": true}`
- tools (1): decide
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, llm_step_number, repo_snapshot, run_id, trace_session_id
- messages (4): system, user, assistant, user
- system 首 120 字符: `You are Buffy, the auto-run agent behind Freebuff Desktop. You decide what one tab does next.

The mission quoted at the…`
- [27] HEAD / → None
- [28] HEAD / → 200
- [29] GET /api/v1/freebuff/session → None
- [30] GET /api/v1/freebuff/session → 200
- [31] POST /api/v1/chat/completions → 200
- [32] POST /api/v1/agent-runs → None  (body 678 B)
- [33] POST /api/v1/agent-runs → 200
- [34] POST /api/v1/freebuff/session/admission → None
- [35] POST /api/v1/freebuff/session/admission → 200
- [36] POST /api/v1/agent-runs → None  (body 83 B)
- [37] POST /api/v1/agent-runs → 200

### [38] POST /api/v1/chat/completions → None  (79674 B)
- **layer**: worker(37 tools)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"auto"`
- provider: `{"data_collection": "deny"}`
- tools (37): read_files, str_replace, write_file, run_terminal_command, code_search, glob, list_directory, write_todos, run_file_change_hooks, end_turn, web_search, read_url, report_project_profile, suggest_prompts, ask_questions, read_thread_context, request_elevation, register_preview, preview_open, preview_status, preview_close, preview_press, preview_scroll, preview_wait, preview_resize, preview_set_color_scheme, preview_recording_start, preview_recording_stop, preview_snapshot, preview_screenshot, preview_click, preview_type, preview_navigate, preview_evaluate, preview_logs, browser_check, write_doc
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, freebuff_reasoning_effort, llm_step_number, repo_snapshot, run_id, trace_session_id
- **reasoning_effort**: `max`
- messages (23): system, user, assistant, user, assistant, tool, user, assistant, user, assistant, tool, assistant, tool, assistant, tool, user, assistant, tool, assistant, tool, assistant, tool, user
- system 首 120 字符: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding fun…`
- [39] POST /api/logs → None  (body 518 B)
- [40] POST /api/logs → 200
- [41] POST /api/v1/chat/completions → 200

### [42] POST /api/v1/chat/completions → None  (80464 B)
- **layer**: worker(37 tools)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"auto"`
- provider: `{"data_collection": "deny"}`
- tools (37): read_files, str_replace, write_file, run_terminal_command, code_search, glob, list_directory, write_todos, run_file_change_hooks, end_turn, web_search, read_url, report_project_profile, suggest_prompts, ask_questions, read_thread_context, request_elevation, register_preview, preview_open, preview_status, preview_close, preview_press, preview_scroll, preview_wait, preview_resize, preview_set_color_scheme, preview_recording_start, preview_recording_stop, preview_snapshot, preview_screenshot, preview_click, preview_type, preview_navigate, preview_evaluate, preview_logs, browser_check, write_doc
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, freebuff_reasoning_effort, llm_step_number, repo_snapshot, run_id, trace_session_id
- **reasoning_effort**: `max`
- messages (25): system, user, assistant, user, assistant, tool, user, assistant, user, assistant, tool, assistant, tool, assistant, tool, user, assistant, tool, assistant, tool, assistant, tool, user, assistant, tool
- system 首 120 字符: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding fun…`
- [43] POST /api/ads → None  (body 6052 B)
- [44] POST /api/v1/chat/completions → 200

### [45] POST /api/v1/chat/completions → None  (81168 B)
- **layer**: worker(37 tools)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"auto"`
- provider: `{"data_collection": "deny"}`
- tools (37): read_files, str_replace, write_file, run_terminal_command, code_search, glob, list_directory, write_todos, run_file_change_hooks, end_turn, web_search, read_url, report_project_profile, suggest_prompts, ask_questions, read_thread_context, request_elevation, register_preview, preview_open, preview_status, preview_close, preview_press, preview_scroll, preview_wait, preview_resize, preview_set_color_scheme, preview_recording_start, preview_recording_stop, preview_snapshot, preview_screenshot, preview_click, preview_type, preview_navigate, preview_evaluate, preview_logs, browser_check, write_doc
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, freebuff_reasoning_effort, llm_step_number, repo_snapshot, run_id, trace_session_id
- **reasoning_effort**: `max`
- messages (27): system, user, assistant, user, assistant, tool, user, assistant, user, assistant, tool, assistant, tool, assistant, tool, user, assistant, tool, assistant, tool, assistant, tool, user, assistant, tool, assistant, tool
- system 首 120 字符: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding fun…`
- [46] POST /api/ads → 200
- [47] POST /api/v1/ads/impression → None  (body 1437 B)
- [48] POST /api/v1/ads/impression → 200
- [49] HEAD / → None
- [50] HEAD / → 200
- [51] POST /api/v1/chat/completions → 200
- [52] GET /api/v1/project-profile?project_key=local%3A8b16bd640fa6dbe3855ba6e680fc2639 → None
- [53] POST /api/ads → None  (body 6545 B)
- [54] POST /api/v1/freebuff/session/admission → None
- [55] GET /api/v1/project-profile?project_key=local%3A8b16bd640fa6dbe3855ba6e680fc2639 → 200

### [56] POST /api/v1/chat/completions → None  (83970 B)
- **layer**: worker(37 tools)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"required"`
- provider: `{"data_collection": "deny"}`
- tools (37): read_files, str_replace, write_file, run_terminal_command, code_search, glob, list_directory, write_todos, run_file_change_hooks, end_turn, web_search, read_url, report_project_profile, suggest_prompts, ask_questions, read_thread_context, request_elevation, register_preview, preview_open, preview_status, preview_close, preview_press, preview_scroll, preview_wait, preview_resize, preview_set_color_scheme, preview_recording_start, preview_recording_stop, preview_snapshot, preview_screenshot, preview_click, preview_type, preview_navigate, preview_evaluate, preview_logs, browser_check, write_doc
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, freebuff_reasoning_effort, llm_step_number, repo_snapshot, run_id, trace_session_id
- **reasoning_effort**: `max`
- messages (30): system, user, assistant, user, assistant, tool, user, assistant, user, assistant, tool, assistant, tool, assistant, tool, user, assistant, tool, assistant, tool, assistant, tool, user, assistant, tool, assistant, tool, assistant, tool, user
- system 首 120 字符: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding fun…`
- [57] POST /api/v1/freebuff/session/admission → 200
- [58] POST /api/v1/agent-runs → None  (body 75 B)
- [59] POST /api/v1/agent-runs → 200

### [60] POST /api/v1/chat/completions → None  (24494 B)
- **layer**: manager(decide)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"auto"`
- provider: `{"allow_fallbacks": true}`
- tools (1): decide
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, llm_step_number, repo_snapshot, run_id, trace_session_id
- messages (8): system, user, assistant, user, assistant, tool, user, user
- system 首 120 字符: `You are Buffy, the auto-run agent behind Freebuff Desktop. You decide what one tab does next.

The mission quoted at the…`
- [61] POST /api/ads → 200
- [62] POST /api/logs → None  (body 1093 B)
- [63] POST /api/logs → 200
- [64] POST /api/v1/chat/completions → 200
- [65] POST /api/v1/agent-runs → None  (body 693 B)
- [66] POST /api/v1/agent-runs → 200
- [67] HEAD / → None
- [68] HEAD / → 200
- [69] GET /api/v1/ads/proposal?workspace=858b1d11-19e6-409b-9c40-fb295653c9b6&surface=desktop → None
- [70] GET /api/v1/ads/proposal?workspace=858b1d11-19e6-409b-9c40-fb295653c9b6&surface=desktop → 200
- [71] POST /api/v1/chat/completions → 200

### [72] POST /api/v1/chat/completions → None  (25559 B)
- **layer**: manager(decide)
- model: `fbm1.AAEAAUPkLF6HpwLlITJQIWXfH6yXQIb5Ev3g-OEM4_ddY…`
- stream: `True` | tool_choice: `"auto"`
- provider: `{"allow_fallbacks": true}`
- tools (1): decide
- metadata 键: client_id, cost_mode, freebuff_instance_id, freebuff_multi_session, llm_step_number, repo_snapshot, run_id, trace_session_id
- messages (10): system, user, assistant, user, assistant, tool, user, user, assistant, tool
- system 首 120 字符: `You are Buffy, the auto-run agent behind Freebuff Desktop. You decide what one tab does next.

The mission quoted at the…`
- [73] POST /api/v1/chat/completions → 200
- [74] POST /api/v1/agent-runs → None  (body 511 B)
- [75] POST /api/v1/agent-runs → 200
- [76] POST /api/logs → None  (body 1086 B)
- [77] POST /api/logs → 200
- [78] HEAD / → None
- [79] HEAD / → 200
- [80] POST /api/logs → None  (body 474 B)
- [81] POST /api/logs → 200
- [82] GET /api/v1/freebuff/session → None
- [83] GET /api/v1/freebuff/session → 200
- [84] HEAD / → None
- [85] HEAD / → 200
- [86] HEAD / → None
- [87] HEAD / → 200

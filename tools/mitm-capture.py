"""mitmproxy addon: 抓请求与响应，请求体用 request 钩子（一次性可读）。"""
import json, os
from mitmproxy import http

OUT = os.environ.get("CAPTURE_OUT", "/tmp/fbrev/capture.jsonl")
WANT = ("codebuff.com", "freebuff.com")


def _h(h):
    return {k: v for k, v in h.items()}


def _txt(content):
    if not content:
        return None
    try:
        return content.decode("utf-8", "replace")
    except Exception:
        return repr(content[:2000])


def request(flow: http.HTTPFlow):
    host = flow.request.pretty_host or ""
    if not any(w in host for w in WANT):
        return
    # 请求体在 request 阶段可读（一次性发送）
    try:
        raw = flow.request.get_content()
    except Exception:
        raw = flow.request.content
    rec = {
        "ts": flow.request.timestamp_start,
        "host": host,
        "method": flow.request.method,
        "path": flow.request.path,
        "req_headers": _h(flow.request.headers),
        "req_body": _txt(raw),
        "status": None,
        "resp_headers": {},
        "resp_body": None,
    }
    with open(OUT, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def response(flow: http.HTTPFlow):
    host = flow.request.pretty_host or ""
    if not any(w in host for w in WANT):
        return
    # 回填响应状态（流式 body 可能拿不到，但状态码与头有价值）
    rec = {
        "ts": flow.request.timestamp_start,
        "host": host,
        "method": flow.request.method,
        "path": flow.request.path,
        "req_headers": _h(flow.request.headers),
        "req_body": None,
        "status": flow.response.status_code if flow.response else None,
        "resp_headers": _h(flow.response.headers) if flow.response else {},
        "resp_body": None,
    }
    try:
        raw = flow.response.get_content()
        rec["resp_body"] = _txt(raw)
    except Exception:
        pass
    with open(OUT, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

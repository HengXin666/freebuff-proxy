# Agent Note: Tool-bearing requests fail closed by default

Status: implemented

## Problem

An upstream rejection of a tool-bearing request can be followed by a second request with `tools` removed. A successful text reply then looks like a successful agent turn, but it has no `tool_calls`. The response header only helps callers that explicitly inspect it. This changes the caller's requested capability without its consent.

## Decision

`stripToolsOnSchemaRejection` defaults to false. The proxy forwards the upstream rejection for tool-bearing requests unless the operator explicitly enables the existing text-only fallback in settings. The settings API and dashboard use the same explicit-true rule; persisted true values retain their chosen behavior. The opt-in fallback still marks responses with `x-freebuff-proxy-tools-stripped: 1`.

This changes only failure semantics. It does not claim to make the upstream accept third-party tool schemas. The opt-in fallback mechanism and its original rationale remain documented in [2026-09-18-tool-schema-rejection-strip.md](2026-09-18-tool-schema-rejection-strip.md).

## Alternatives considered

- Keep the existing default and rely on the response header: this preserves text availability and the original 502 workaround, but callers that require tools typically consume the response body rather than interpreting a proxy-specific header. They would still mistake a text reply for a tool-capable response.
- Remove the fallback entirely: this gives a simpler contract but removes the operator's deliberate text-only recovery path for clients that value an answer over tool calls.
- Do nothing: this avoids behavior changes for existing deployments, but leaves new installations silently changing the semantics of agent requests.

## Consequences

A newly configured tool client receives the upstream error instead of a text-only success when tools are rejected. Downstream bridges may transform that error; the proxy does not assert control over their behavior. Explicitly persisted true values continue to request fallback. This is error fidelity, not a protocol-level tool-call fix.

## Testing

The smoke test covers default rejection with one upstream attempt and explicit fallback with two attempts and the stripped-tools header. Settings defaults, API behavior, and dashboard rendering share explicit-true semantics.

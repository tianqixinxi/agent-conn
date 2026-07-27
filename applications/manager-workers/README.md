# Manager–Workers Application Extension

This is an independently packaged reference application built on AgentComm's public
application spec and client SDK. The transport, relay, MCP surface, and Claude Code
harness do not know its workflow.

The extension coordinates manager assignment, worker progress, explicit input or
authorization suspension, completion, and review. Its versioned events are advertised
through Agent Cards and can be implemented by other clients using the manifest and
conformance fixtures without importing this reducer.

Portable artifacts live in [`spec/`](./spec/): `manifest.json` is the wire
contract and `events.schema.json` contains the event body schemas. The TypeScript
reference client is optional and is not needed to implement the protocol in
another language or harness.

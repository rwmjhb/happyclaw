// Claude Code — SDK-based provider
export {
  ClaudeSDKProvider,
  ClaudeRemoteSession,
  ClaudeLocalSession,
} from './claude-sdk.js';

// Generic PTY — for CLI tools without a dedicated SDK (e.g., Gemini)
export {
  GenericPTYProvider,
  PTYRemoteSession,
  PTYLocalSession,
} from './generic-pty.js';

// Parser rules for PTY output
export type { ParserRuleSet } from './parser-rules.js';
export { GeminiParserRules } from './parser-rules.js';

// Codex — MCP bridge provider
export {
  CodexMCPProvider,
  CodexMCPSession,
  CodexLocalSession,
} from './codex-mcp.js';

// MCP bridge transport
export { McpStdioBridge } from './mcp-bridge.js';
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcNotification,
  JsonRpcMessage,
} from './mcp-bridge.js';

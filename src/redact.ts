/**
 * Sensitive data redaction for session output.
 *
 * Detects and masks secrets (API keys, tokens, passwords, etc.)
 * before they reach chat formatters or external consumers.
 *
 * Reference: Phase 4 — data redaction
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RedactionPattern {
  /** Regex to match sensitive content */
  pattern: RegExp;
  /** Replacement string (may use $1, $2 etc. for capture groups) */
  replacement: string;
}

export interface RedactionConfig {
  /** Additional patterns to apply alongside defaults */
  extraPatterns?: RedactionPattern[];
  /** Replace the default patterns entirely (default: false) */
  replaceDefaults?: boolean;
}

// ---------------------------------------------------------------------------
// Default patterns
// ---------------------------------------------------------------------------

const DEFAULT_PATTERNS: RedactionPattern[] = [
  // Bearer tokens
  {
    pattern: /Bearer\s+[A-Za-z0-9_.\-]+/g,
    replacement: 'Bearer [REDACTED]',
  },
  // API key prefixes: sk-, AKIA, ghp_, ghs_, glpat-, xoxb-, xoxp-
  {
    pattern: /\b(sk-|AKIA|ghp_|ghs_|glpat-|xoxb-|xoxp-)[A-Za-z0-9_\-]+/g,
    replacement: '$1[REDACTED]',
  },
  // Key-value pairs with sensitive key names (= or : or ":" delimiters)
  {
    pattern:
      /\b(password|secret|token|api_key|apikey|auth)(["']?\s*[:=]\s*["']?)([^\s"',;}{)]+)/gi,
    replacement: '$1$2[REDACTED]',
  },
  // Environment variable assignments: export FOO_SECRET=value or FOO_TOKEN=value
  {
    pattern:
      /\b(export\s+)?([A-Z_]*(?:SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)[A-Z_]*)\s*=\s*([^\s;]+)/g,
    replacement: '$1$2=[REDACTED]',
  },
  // Generic long hex/base64 strings (40+ chars) that look like secrets
  {
    pattern: /\b[A-Za-z0-9+/=]{40,}\b/g,
    replacement: '[REDACTED_SECRET]',
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redact sensitive data from text.
 *
 * Applies a series of regex patterns to detect and mask secrets.
 * Patterns are applied in order; the default set covers common
 * token formats, API keys, key-value pairs, env vars, and
 * long hex/base64 strings.
 */
export function redactSensitive(
  text: string,
  config?: RedactionConfig,
): string {
  const patterns = buildPatterns(config);
  let result = text;

  for (const { pattern, replacement } of patterns) {
    // Reset lastIndex for global regexes that may be reused
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPatterns(config?: RedactionConfig): RedactionPattern[] {
  if (!config) return DEFAULT_PATTERNS;

  const base = config.replaceDefaults ? [] : DEFAULT_PATTERNS;
  return [...base, ...(config.extraPatterns ?? [])];
}

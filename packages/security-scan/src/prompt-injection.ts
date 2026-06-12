/**
 * Detect prompt-injection attempts inside untrusted spec free-text (P6-2,
 * §16.2/§26.3). OpenAPI summaries/descriptions are attacker-controllable and are
 * fed (as data) to the LLM that authors tool descriptions. The LLM is already
 * instructed to treat them as data; this is the **defense-in-depth flag** so a
 * suspicious description is surfaced (audited) rather than passing silently.
 *
 * Pure + conservative: patterns require an instruction-like verb AND a
 * prompt/instruction/secret object, so ordinary API prose ("ignore deprecated
 * fields", "create a new issue") does not trip it.
 */

export interface InjectionFinding {
  category: string;
  excerpt: string;
}

export interface InjectionResult {
  suspicious: boolean;
  findings: InjectionFinding[];
}

interface Rule {
  category: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    // "ignore/disregard/forget (all) previous/above instructions/prompt/rules"
    category: "instruction-override",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|above|prior|earlier|all|the)\b[^.\n]{0,20}\b(?:instruction|prompt|context|rule|direction)s?\b/i,
  },
  {
    // role hijack: "you are now…", "act as…", "from now on you…"
    category: "role-injection",
    pattern:
      /\b(?:you are now|you're now|you will now|act as|pretend to be|from now on,? you|behave as)\b/i,
  },
  {
    // explicit injected-instruction headers / fake system turns
    category: "injected-instructions",
    pattern:
      /(?:\bnew instructions?\b\s*[:\-]|###\s*(?:instruction|system|task)|\b(?:system|assistant|developer)\s*(?:prompt|message|mode)\b)/i,
  },
  {
    // chat-template control tokens that try to open a new turn
    category: "control-tokens",
    pattern: /<\|im_(?:start|end)\|>|\[\/?(?:INST|SYS)\]|<\|(?:system|user|assistant)\|>/i,
  },
  {
    // exfiltration: reveal/print/send + secret/system-prompt
    category: "exfiltration",
    pattern:
      /\b(?:reveal|print|output|repeat|send|leak|exfiltrate|disclose)\b[^.\n]{0,40}\b(?:system prompt|instructions?|api[ _-]?key|secret|password|credential|token|env(?:ironment)? variable)s?\b/i,
  },
  {
    category: "jailbreak",
    pattern: /\b(?:jailbreak|do anything now|DAN mode|developer mode enabled)\b/i,
  },
];

const MAX_EXCERPT = 120;

/** Scan one untrusted text blob for injection signals. */
export function detectPromptInjection(text: string): InjectionResult {
  const findings: InjectionFinding[] = [];
  if (!text) return { suspicious: false, findings };

  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      const excerpt = match[0].slice(0, MAX_EXCERPT).replace(/\s+/g, " ").trim();
      findings.push({ category: rule.category, excerpt });
    }
  }
  return { suspicious: findings.length > 0, findings };
}

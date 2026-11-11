export const STRONG_RE =
  /deepseek[ _-]?harness|@deepseek-ai\/|\bdsh[ _-]plugins?\b|dsh-run\b|dsh\.ya?ml|~\/\.dsh|\.dsh\/|\bcordis\b|dsh headless|dsh-app-boot|dsh 插件|DSH插件/i;
export const MEDIUM_RE = /\bdsh\b|deepseek/i;
export const ECO_RE =
  /\bmcp\b|model context protocol|\bagents?\b|\bskills?\b|plugin|插件|技能|智能体|\bllm\b|claude|codex|copilot|opencode/i;
export const SPAM_RE =
  /download .{0,40}(installer|setup|crack|keygen)|free download|mirror links?|activation key|license key generator|\bcracked?\b|\bkeygen\b|torrent/i;
export const README_SIGNAL_PATTERNS = Object.freeze({ STRONG_RE, MEDIUM_RE, ECO_RE, SPAM_RE });

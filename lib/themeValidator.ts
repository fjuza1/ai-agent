export const PRESET_NAMES = [
  "Cozy Nordic Holiday",
  "Playful Pop Boutique",
  "Warm Artisan Apothecary",
  "Crisp Modern Wellness",
  "Festive Candy Shop",
] as const;

const THEME_KEYS = [
  "name",
  "bg_primary",
  "bg_card",
  "text_primary",
  "text_muted",
  "accent_primary",
  "accent_secondary",
  "text_on_accent",
  "badge_bg",
  "text_on_badge",
  "border_color",
  "radius_card",
  "shadow_card",
  "font_display",
  "animation_style",
] as const;

const SHADOWS = new Set([
  "0 8px 24px rgba(37, 33, 28, 0.10)",
  "0 8px 24px rgba(41, 27, 42, 0.10)",
  "0 8px 24px rgba(48, 35, 28, 0.10)",
  "0 8px 24px rgba(26, 38, 51, 0.09)",
  "0 8px 24px rgba(57, 22, 36, 0.10)",
]);
const FONTS = new Set([
  "Georgia, serif",
  "Trebuchet MS, sans-serif",
  "system-ui, sans-serif",
]);
const ANIMATIONS = new Set([
  "cubic-bezier(0.2, 0.8, 0.2, 1)",
  "cubic-bezier(0.34, 1.56, 0.64, 1)",
  "ease-out",
]);
const SENSITIVE_QUERY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "client_secret",
  "credential",
  "password",
  "secret",
  "signature",
  "token",
]);
const HEX = /^#[\da-fA-F]{6}$/;

type Theme = Record<(typeof THEME_KEYS)[number], string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => {
      const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function isValidTheme(value: unknown): value is Theme {
  if (!isRecord(value) || Object.keys(value).length !== THEME_KEYS.length ||
      !THEME_KEYS.every((key) => key in value)) return false;
  if (typeof value.name !== "string" || !value.name.trim()) return false;

  const colorKeys = [
    "bg_primary",
    "bg_card",
    "text_primary",
    "text_muted",
    "accent_primary",
    "accent_secondary",
    "text_on_accent",
    "badge_bg",
    "text_on_badge",
    "border_color",
  ] as const;
  if (!colorKeys.every((key) => typeof value[key] === "string" && HEX.test(value[key]))) return false;
  if (typeof value.radius_card !== "string" || !/^(?:0|[1-9]\d?)px$/.test(value.radius_card) ||
      Number.parseInt(value.radius_card, 10) > 24) return false;
  if (typeof value.shadow_card !== "string" || !SHADOWS.has(value.shadow_card)) return false;
  if (typeof value.font_display !== "string" || !FONTS.has(value.font_display)) return false;
  if (typeof value.animation_style !== "string" || !ANIMATIONS.has(value.animation_style)) return false;

  return contrastRatio(value.text_primary as string, value.bg_primary as string) >= 4.5 &&
    contrastRatio(value.text_primary as string, value.bg_card as string) >= 4.5 &&
    contrastRatio(value.text_muted as string, value.bg_primary as string) >= 4.5 &&
    contrastRatio(value.text_muted as string, value.bg_card as string) >= 4.5 &&
    contrastRatio(value.accent_secondary as string, value.bg_primary as string) >= 4.5 &&
    contrastRatio(value.accent_secondary as string, value.bg_card as string) >= 4.5 &&
    contrastRatio(value.text_on_accent as string, value.accent_primary as string) >= 4.5 &&
    contrastRatio(value.text_on_accent as string, value.accent_secondary as string) >= 4.5 &&
    contrastRatio(value.text_on_badge as string, value.badge_bg as string) >= 4.5;
}

export function isValidThemeDocument(value: unknown): boolean {
  if (!isRecord(value) ||
      Object.keys(value).sort().join(",") !== "active,presets,schema_version,trend,updated_at" ||
      value.schema_version !== 1 ||
      typeof value.updated_at !== "string" ||
      !Number.isFinite(Date.parse(value.updated_at)) ||
      !isValidTheme(value.active) ||
      !Array.isArray(value.presets) ||
      value.presets.length !== PRESET_NAMES.length ||
      !isRecord(value.trend)) return false;

  const presets = value.presets;
  const names = new Set<string>();
  for (const preset of presets) {
    if (!isRecord(preset) ||
        Object.keys(preset).sort().join(",") !== "quality_score,theme" ||
        typeof preset.quality_score !== "number" ||
        preset.quality_score < 0 ||
        preset.quality_score > 1 ||
        !isValidTheme(preset.theme) ||
        names.has(preset.theme.name)) return false;
    names.add(preset.theme.name);
  }
  if (!PRESET_NAMES.every((name) => names.has(name))) return false;

  const trend = value.trend;
  if (Object.keys(trend).sort().join(",") !== "observations,observed_at,provider,signal_status,sources,summary" ||
      !["fallback", "feed_observed", "llm_synthesized", "feed_unavailable"].includes(String(trend.signal_status)) ||
      typeof trend.provider !== "string" ||
      !Number.isFinite(Date.parse(String(trend.observed_at))) ||
      typeof trend.summary !== "string" ||
      !Array.isArray(trend.sources) ||
      !trend.sources.every((source) => {
        if (typeof source !== "string") return false;
        try {
          const url = new URL(source);
          let safeQuery = true;
          url.searchParams.forEach((_value, key) => {
            if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) safeQuery = false;
          });
          return url.protocol === "https:" && !url.username && !url.password && safeQuery;
        } catch {
          return false;
        }
      }) ||
      !Array.isArray(trend.observations) ||
      trend.observations.length > 10) return false;
  return trend.observations.every((observation) => {
    if (!isRecord(observation) ||
        Object.keys(observation).sort().join(",") !== "aesthetic,domain,rank,shop,visits" ||
        typeof observation.shop !== "string" ||
        typeof observation.domain !== "string" ||
        typeof observation.aesthetic !== "string" ||
        (observation.rank !== null && (typeof observation.rank !== "number" || !Number.isSafeInteger(observation.rank) || observation.rank < 1)) ||
        (observation.visits !== null && (typeof observation.visits !== "number" || !Number.isFinite(observation.visits) || observation.visits < 0))) return false;
    return Boolean(observation.shop.trim() || observation.domain.trim());
  });
}

export function assertValidThemeDocument(value: unknown): asserts value {
  if (!isValidThemeDocument(value)) throw new Error("Invalid daily visual theme document.");
}

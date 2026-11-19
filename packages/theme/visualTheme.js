import themeData from "../../data/daily_visual_theme.json";
import { assertValidThemeDocument } from "../../lib/themeValidator.ts";

assertValidThemeDocument(themeData);

const active = themeData.active;

export const activeThemeStyle = {
  "--bg-primary": active.bg_primary,
  "--bg-card": active.bg_card,
  "--text-primary": active.text_primary,
  "--text-muted": active.text_muted,
  "--accent-primary": active.accent_primary,
  "--accent-secondary": active.accent_secondary,
  "--text-on-accent": active.text_on_accent,
  "--badge-bg": active.badge_bg,
  "--text-on-badge": active.text_on_badge,
  "--border-color": active.border_color,
  "--radius-card": active.radius_card,
  "--shadow-card": active.shadow_card,
  "--font-display": active.font_display,
  "--animation-style": active.animation_style,
};

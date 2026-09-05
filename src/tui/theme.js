/**
 * @file theme.js
 * @description Semantic light/dark palette, auto theme detection, and shared TUI colour helpers.
 *
 * @functions
 *   → `detectActiveTheme` — resolve the live theme from user preference or terminal/OS signals
 *   → `getTheme` — return the currently active resolved theme (`dark` or `light`)
 *   → `cycleThemeSetting` — rotate persisted theme preference (`auto` → `dark` → `light`)
 *   → `getThemeStatusLabel` — format the settings/help label for the current theme mode
 *   → `getProviderRgb` — return the provider accent colour for the active theme
 *   → `getTierRgb` — return the tier accent colour for the active theme
 *
 * @exports { THEME_OPTIONS, detectActiveTheme, getTheme, cycleThemeSetting, getThemeStatusLabel, getReadableTextRgb, getProviderRgb, getTierRgb, themeColors }
 *
 * @see src/render-table.js
 * @see src/overlays.js
 * @see src/tier-colors.js
 */

import chalk from 'chalk'
import { execSync } from 'child_process'

export const THEME_OPTIONS = ['auto', 'dark', 'light']

let activeTheme = 'dark'

const PALETTES = {
  dark: {
    text: [234, 239, 248],
    textStrong: [255, 255, 255],
    muted: [149, 160, 182],
    soft: [178, 190, 210],
    accent: [110, 214, 255],
    accentStrong: [72, 198, 255],
    info: [129, 210, 255],
    success: [112, 231, 181],
    successStrong: [139, 239, 176],
    warning: [255, 208, 102],
    warningStrong: [255, 221, 140],
    danger: [255, 129, 129],
    dangerStrong: [255, 166, 166],
    hotkey: [255, 214, 102],
    link: [149, 205, 255],
    border: [111, 125, 149],
    footerLove: [255, 168, 209],
    footerCoffee: [255, 209, 134],
    footerDiscord: [207, 179, 255],
    overlayFg: [234, 239, 248],
    overlayBg: {
      settings: [7, 13, 24],
      help: [9, 18, 31],
      recommend: [8, 21, 20],
      feedback: [31, 13, 20],
      changelog: [12, 24, 44],
      commandPalette: [14, 20, 36],
      playground: [10, 22, 18],
    },
    cursor: {
      defaultBg: [39, 55, 90],
      defaultFg: [255, 255, 255],
      installBg: [22, 60, 69],
      installFg: [255, 255, 255],
      settingsBg: [26, 54, 34],
      settingsFg: [255, 255, 255],
      legacyBg: [67, 31, 69],
      legacyFg: [255, 255, 255],
      modelBg: [62, 73, 115],
      modelFg: [255, 255, 255],
      recommendedBg: [20, 51, 33],
      recommendedFg: [234, 239, 248],
      favoriteBg: [76, 55, 17],
      favoriteFg: [255, 244, 220],
    },
    // 📖 Extra semantic tokens for elements that need distinct dark/light variants
    headerLogoBg: [0, 0, 0],
    headerLogoGreen: [118, 185, 0],
    headerLogoWhite: [255, 255, 255],
    cmdPalette: [57, 255, 20],
    twitterLink: [255, 168, 209],
    releaseDate: [255, 182, 193],
    ctxGold: [200, 180, 50],
    ctxGreen: [100, 200, 80],
    ctxTeal: [0, 255, 200],
    ctxCyan: [0, 255, 255],
    rowDimBg: [60, 15, 15],
    rowDimFg: [180, 130, 130],
    badgeSpeedTestBg: [0, 60, 0],
    badgeSpeedTestFg: [57, 255, 20],
    badgeBenchmarkBg: [180, 0, 255],
    badgeBenchmarkFg: [255, 255, 255],
    updateBannerBg: [57, 255, 20],
    updateBannerFg: [0, 0, 0],
    updateBannerErrorBg: [196, 30, 30],
    updateBannerErrorFg: [255, 255, 255],
  },
  light: {
    text: [28, 36, 51],
    textStrong: [8, 12, 20],
    muted: [95, 109, 129],
    soft: [76, 89, 109],
    accent: [0, 120, 186],
    accentStrong: [0, 99, 163],
    info: [0, 109, 168],
    success: [0, 118, 68],
    successStrong: [0, 96, 56],
    warning: [146, 90, 0],
    warningStrong: [171, 102, 0],
    danger: [177, 53, 53],
    dangerStrong: [147, 35, 48],
    hotkey: [171, 98, 0],
    link: [0, 94, 170],
    border: [151, 166, 188],
    footerLove: [176, 79, 128],
    footerCoffee: [170, 102, 0],
    footerDiscord: [104, 83, 190],
    overlayFg: [28, 36, 51],
    overlayBg: {
      settings: [248, 250, 255],
      help: [246, 250, 255],
      recommend: [246, 252, 248],
      feedback: [255, 247, 248],
      changelog: [244, 248, 255],
      commandPalette: [242, 247, 255],
      playground: [244, 252, 246],
    },
    cursor: {
      defaultBg: [217, 231, 255],
      defaultFg: [9, 18, 35],
      installBg: [218, 242, 236],
      installFg: [12, 33, 26],
      settingsBg: [225, 244, 229],
      settingsFg: [14, 43, 27],
      legacyBg: [248, 228, 244],
      legacyFg: [76, 28, 73],
      modelBg: [209, 223, 255],
      modelFg: [9, 18, 35],
      recommendedBg: [221, 245, 229],
      recommendedFg: [17, 47, 28],
      favoriteBg: [255, 241, 208],
      favoriteFg: [79, 53, 0],
    },
    // 📖 Light-mode variants — more muted, higher contrast on white bg
    headerLogoBg: [255, 255, 255],
    headerLogoGreen: [0, 120, 40],
    headerLogoWhite: [20, 30, 45],
    cmdPalette: [0, 130, 35],
    twitterLink: [185, 45, 110],
    releaseDate: [185, 45, 85],
    ctxGold: [140, 120, 0],
    ctxGreen: [35, 120, 25],
    ctxTeal: [0, 135, 110],
    ctxCyan: [0, 125, 125],
    rowDimBg: [255, 230, 230],
    rowDimFg: [185, 55, 55],
    badgeSpeedTestBg: [200, 235, 200],
    badgeSpeedTestFg: [0, 95, 0],
    badgeBenchmarkBg: [230, 205, 250],
    badgeBenchmarkFg: [80, 0, 130],
    updateBannerBg: [30, 180, 30],
    updateBannerFg: [0, 0, 0],
    updateBannerErrorBg: [196, 30, 30],
    updateBannerErrorFg: [255, 255, 255],
  },
}

const PROVIDER_PALETTES = {
  dark: {
    nvidia: [132, 235, 168],
    groq: [255, 191, 144],
    cerebras: [153, 215, 255],
    sambanova: [255, 215, 142],
    openrouter: [228, 191, 239],
    'github-models': [183, 201, 255],
    mistral: [255, 196, 120],
    huggingface: [255, 235, 122],
    replicate: [166, 212, 255],
    deepinfra: [146, 222, 213],
    fireworks: [255, 184, 194],
    codestral: [245, 175, 212],
    hyperbolic: [255, 160, 127],
    scaleway: [115, 209, 255],
    googleai: [166, 210, 255],
    siliconflow: [145, 232, 243],
    together: [255, 232, 98],
    cloudflare: [255, 191, 118],
    perplexity: [243, 157, 195],
    qwen: [255, 213, 128],
    zai: [150, 208, 255],
    iflow: [211, 229, 101],
    'opencode-zen': [185, 146, 255],
    kilo: [120, 255, 190],
    llm7: [180, 255, 140],
    routeway: [130, 210, 255],
    novita: [255, 185, 120],
    pollinations: [255, 105, 180],
    requesty: [100, 149, 255],
    orcarouter: [255, 138, 64],
    'vercel-gateway': [170, 190, 230],
    'ollama-cloud': [230, 230, 230],
  },
  light: {
    nvidia: [0, 126, 73],
    groq: [171, 86, 22],
    cerebras: [0, 102, 177],
    sambanova: [165, 94, 0],
    openrouter: [122, 65, 156],
    'github-models': [52, 83, 166],
    mistral: [166, 96, 29],
    huggingface: [135, 104, 0],
    replicate: [0, 94, 163],
    deepinfra: [0, 122, 117],
    fireworks: [183, 55, 72],
    codestral: [157, 61, 110],
    hyperbolic: [178, 68, 27],
    scaleway: [0, 113, 189],
    googleai: [0, 111, 168],
    siliconflow: [0, 115, 138],
    together: [122, 101, 0],
    cloudflare: [176, 92, 0],
    perplexity: [171, 62, 121],
    qwen: [132, 89, 0],
    zai: [0, 104, 171],
    iflow: [107, 130, 0],
    'opencode-zen': [108, 58, 183],
    kilo: [0, 130, 82],
    llm7: [73, 130, 0],
    routeway: [0, 105, 180],
    novita: [173, 84, 0],
    pollinations: [170, 45, 110],
    requesty: [0, 72, 170],
    orcarouter: [170, 74, 0],
    'vercel-gateway': [60, 80, 130],
    'ollama-cloud': [88, 88, 88],
  },
}

const TIER_PALETTES = {
  dark: {
    'S+': [111, 255, 164],
    'S': [147, 241, 101],
    'A+': [201, 233, 104],
    'A': [255, 211, 101],
    'A-': [255, 178, 100],
    'B+': [255, 145, 112],
    'B': [255, 113, 113],
    'C': [255, 139, 164],
  },
  light: {
    'S+': [0, 122, 58],
    'S': [54, 122, 0],
    'A+': [95, 113, 0],
    'A': [128, 92, 0],
    'A-': [156, 80, 0],
    'B+': [171, 69, 0],
    'B': [168, 44, 44],
    'C': [123, 35, 75],
  },
}

export function currentPalette() {
  return PALETTES[activeTheme] ?? PALETTES.dark
}

function themeLabel(theme) {
  return theme.charAt(0).toUpperCase() + theme.slice(1)
}

function buildStyle({ fgRgb = null, bgRgb = null, bold = false, italic = false } = {}) {
  let style = chalk
  if (bgRgb) style = style.bgRgb(...bgRgb)
  if (fgRgb) style = style.rgb(...fgRgb)
  if (bold) style = style.bold
  if (italic) style = style.italic
  return style
}

export function getReadableTextRgb(bgRgb) {
  const [r, g, b] = bgRgb
  const yiq = (r * 299 + g * 587 + b * 114) / 1000
  return yiq >= 150 ? [10, 16, 28] : [248, 251, 255]
}

export function detectActiveTheme(configTheme = 'auto') {
  if (configTheme === 'dark' || configTheme === 'light') {
    activeTheme = configTheme
    return activeTheme
  }

  const fgbg = process.env.COLORFGBG || ''
  if (fgbg.includes(';15') || fgbg.includes(';7') || fgbg.includes(';base03')) {
    activeTheme = 'light'
    return activeTheme
  }
  if (fgbg) {
    activeTheme = 'dark'
    return activeTheme
  }

  if (process.platform === 'darwin') {
    try {
      const style = execSync('defaults read -g AppleInterfaceStyle 2>/dev/null', { timeout: 100 }).toString().trim()
      activeTheme = style === 'Dark' ? 'dark' : 'light'
    } catch {
      activeTheme = 'light'
    }
    return activeTheme
  }

  activeTheme = 'dark'
  return activeTheme
}

export function getTheme() {
  return activeTheme
}

export function cycleThemeSetting(currentTheme = 'auto') {
  const currentIdx = THEME_OPTIONS.indexOf(currentTheme)
  const nextIdx = currentIdx === -1 ? 0 : (currentIdx + 1) % THEME_OPTIONS.length
  return THEME_OPTIONS[nextIdx]
}

export function getThemeStatusLabel(setting = 'auto') {
  if (setting === 'auto') return `Auto → ${themeLabel(activeTheme)}`
  return themeLabel(setting)
}

export function getProviderRgb(providerKey) {
  const palette = PROVIDER_PALETTES[activeTheme] ?? PROVIDER_PALETTES.dark
  return palette[providerKey] ?? currentPalette().accent
}

export function getTierRgb(tier) {
  const palette = TIER_PALETTES[activeTheme] ?? TIER_PALETTES.dark
  return palette[tier] ?? currentPalette().textStrong
}

function paintRgb(rgb, text, options = {}) {
  return buildStyle({ fgRgb: rgb, ...options })(text)
}

function paintBg(bgRgb, text, fgRgb = null, options = {}) {
  return buildStyle({ bgRgb, fgRgb: fgRgb ?? getReadableTextRgb(bgRgb), ...options })(text)
}

// 📖 Background fill colours — used to force the terminal background to match
// 📖 the active theme. Light mode → solid white, dark mode → solid dark.
export const THEME_BG_RGB = {
  dark: [7, 13, 24],
  light: [255, 255, 255],
}

export const themeColors = {
  text: (text) => paintRgb(currentPalette().text, text),
  textBold: (text) => paintRgb(currentPalette().textStrong, text, { bold: true }),
  headerBold: (text) => paintRgb([142, 200, 255], text, { bold: true }),
  dim: (text) => paintRgb(currentPalette().muted, text),
  soft: (text) => paintRgb(currentPalette().soft, text),
  accent: (text) => paintRgb(currentPalette().accent, text),
  accentBold: (text) => paintRgb(currentPalette().accentStrong, text, { bold: true }),
  info: (text) => paintRgb(currentPalette().info, text),
  infoBold: (text) => paintRgb([100, 180, 255], text, { bold: true }),
  success: (text) => paintRgb(currentPalette().success, text),
  successBold: (text) => paintRgb(currentPalette().successStrong, text, { bold: true }),
  warning: (text) => paintRgb(currentPalette().warning, text),
  warningBold: (text) => paintRgb(currentPalette().warningStrong, text, { bold: true }),
  error: (text) => paintRgb(currentPalette().danger, text),
  errorBold: (text) => paintRgb(currentPalette().dangerStrong, text, { bold: true }),
  hotkey: (text) => paintRgb(currentPalette().hotkey, text, { bold: true }),
  link: (text) => paintRgb(currentPalette().link, text),
  border: (text) => paintRgb(currentPalette().border, text),
  footerLove: (text) => paintRgb(currentPalette().footerLove, text),
  footerCoffee: (text) => paintRgb(currentPalette().footerCoffee, text),
  footerDiscord: (text) => paintRgb(currentPalette().footerDiscord, text),
  metricGood: (text) => paintRgb(currentPalette().successStrong, text),
  metricOk: (text) => paintRgb(currentPalette().info, text),
  metricWarn: (text) => paintRgb(currentPalette().warning, text),
  metricBad: (text) => paintRgb(currentPalette().danger, text),
  provider: (providerKey, text, { bold = false } = {}) => paintRgb(getProviderRgb(providerKey), text, { bold }),
  tier: (tier, text, { bold = true } = {}) => paintRgb(getTierRgb(tier), text, { bold }),
  badge: (text, bgRgb, fgRgb = null) => paintBg(bgRgb, ` ${text} `, fgRgb, { bold: true }),
  bgCursor: (text) => paintBg(currentPalette().cursor.defaultBg, text, currentPalette().cursor.defaultFg),
  bgCursorInstall: (text) => paintBg(currentPalette().cursor.installBg, text, currentPalette().cursor.installFg),
  bgCursorSettingsList: (text) => paintBg(currentPalette().cursor.settingsBg, text, currentPalette().cursor.settingsFg),
  bgCursorLegacy: (text) => paintBg(currentPalette().cursor.legacyBg, text, currentPalette().cursor.legacyFg),
  bgModelCursor: (text) => paintBg(currentPalette().cursor.modelBg, text, currentPalette().cursor.modelFg),
  bgModelRecommended: (text) => paintBg(currentPalette().cursor.recommendedBg, text, currentPalette().cursor.recommendedFg),
  bgModelFavorite: (text) => paintBg(currentPalette().cursor.favoriteBg, text, currentPalette().cursor.favoriteFg),
  overlayBgSettings: (text) => paintBg(currentPalette().overlayBg.settings, text, currentPalette().overlayFg),
  overlayBgHelp: (text) => paintBg(currentPalette().overlayBg.help, text, currentPalette().overlayFg),
  overlayBgRecommend: (text) => paintBg(currentPalette().overlayBg.recommend, text, currentPalette().overlayFg),
  overlayBgFeedback: (text) => paintBg(currentPalette().overlayBg.feedback, text, currentPalette().overlayFg),
  overlayBgChangelog: (text) => paintBg(currentPalette().overlayBg.changelog, text, currentPalette().overlayFg),
  overlayBgPlayground: (text) => paintBg(currentPalette().overlayBg.playground, text, currentPalette().overlayFg),
  overlayBgCommandPalette: (text) => paintBg(currentPalette().overlayBg.commandPalette, text, currentPalette().overlayFg),
  /**
   * 📖 Returns the active theme's background RGB array.
   * 📖 Use this to paint lines with a forced background so the TUI looks correct
   * 📖 regardless of the terminal's native dark/light mode.
   */
  bgFill: () => THEME_BG_RGB[activeTheme] ?? THEME_BG_RGB.dark,
}

/**
 * 📖 Patch every \x1b[49m (bg reset) in an ANSI string by immediately
 * 📖 re-applying the current theme's background colour. Chalk emits
 * 📖 \x1b[49m after every bgRgb() call, which undoes our forced theme bg.
 *
 * 📖 Also handles \x1b[0m (full reset) which includes a bg reset.
 */
export function patchThemeBg(raw, bgRgb = null) {
  const color = bgRgb ?? THEME_BG_RGB[activeTheme] ?? THEME_BG_RGB.dark
  const BG_SET = `\x1b[48;2;${color[0]};${color[1]};${color[2]}m`
  return raw
    .replace(/\x1b\[0m/g, `\x1b[0m${BG_SET}`)
    .replace(/\x1b\[49m/g, `\x1b[49m${BG_SET}`)
}

/** Visual theme for the Pattern D animation. */

/** Canvas background and base text colors. */
export const palette = {
    bg: '#0B1220',
    bgGradientTop: '#0F172A',
    bgGradientBottom: '#020617',
    text: '#F8FAFC',
    textDim: '#94A3B8',
    cardBorder: 'rgba(148, 163, 184, 0.25)',
    cardBg: 'rgba(15, 23, 42, 0.7)',
    cardBgActive: 'rgba(56, 189, 248, 0.15)',
    pathDim: 'rgba(148, 163, 184, 0.35)',
    pathActive: '#38BDF8',
    pathGlow: 'rgba(56, 189, 248, 0.55)',
    vpcBorder: 'rgba(56, 189, 248, 0.45)',
    vpcFill: 'rgba(56, 189, 248, 0.06)',
    vpcLabel: '#7DD3FC',
} as const;

/** AWS-inspired accent color per service category. */
export const accent = {
    client: '#10B981',
    edge: '#FF9900',
    apiGw: '#8C4FFF',
    compute: '#FF9900',
    storage: '#3FB34F',
    identity: '#DD344C',
    audit: '#F59E0B',
    waf: '#FF6B35',
} as const;

/** Typography. */
export const fonts = {
    sans: '"Inter", "SF Pro Display", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Menlo", monospace',
} as const;

/** Card sizes (px). */
export const sizes = {
    cardWidth: 300,
    cardHeight: 110,
    cardWidthSmall: 230,
    cardHeightSmall: 80,
    cardRadius: 14,
    packetRadius: 12,
} as const;

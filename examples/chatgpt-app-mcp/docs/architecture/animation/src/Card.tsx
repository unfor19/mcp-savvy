/** Architecture component card. Used for every node on the canvas. */

import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { palette, sizes, fonts } from './theme';
import type { Node } from './layout';

/** Card visual props. */
export interface CardProps {
    /** Spatial node from `layout.ts`. */
    readonly node: Node;
    /** Title shown in the card header. */
    readonly title: string;
    /** One-line subtitle / details. */
    readonly subtitle?: string;
    /** Tag label (top-right corner). */
    readonly tag?: string;
    /** Accent colour for the left bar + tag chip + icon. */
    readonly accentColor: string;
    /** Frame at which the card pops in (spring). Earlier frames render hidden. */
    readonly enterAt: number;
    /** When true, the card pulses bright (e.g. while a packet is in transit through it). */
    readonly active?: boolean;
    /** Optional left-side icon (rendered with `accentColor`). */
    readonly icon?: React.ReactNode;
}

/** Single architecture component card. Springs in, optionally pulses while active. */
export const Card: React.FC<CardProps> = ({
    node,
    title,
    subtitle,
    tag,
    accentColor,
    enterAt,
    active = false,
    icon,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const w = node.w ?? sizes.cardWidth;
    const h = node.h ?? sizes.cardHeight;
    const compact = h < 100;

    const enter = spring({ frame: frame - enterAt, fps, config: { damping: 14, mass: 0.6 } });
    const opacity = interpolate(enter, [0, 1], [0, 1]);
    const translateY = interpolate(enter, [0, 1], [16, 0]);
    const scale = interpolate(enter, [0, 1], [0.92, 1]);
    const pulse = active
        ? 0.5 + 0.5 * Math.sin((frame / fps) * Math.PI * 2 * 1.2)
        : 0;
    const glow = interpolate(pulse, [0, 1], [0, 22]);
    const border = active ? accentColor : palette.cardBorder;
    const bg = active ? palette.cardBgActive : palette.cardBg;

    const titleSize = compact ? 17 : 22;
    const subtitleSize = compact ? 12 : 14;
    const tagSize = compact ? 10 : 11;
    const padding = compact ? '14px 16px' : '16px 18px';
    const gap = compact ? 12 : 14;

    return (
        <div
            style={{
                position: 'absolute',
                left: node.cx - w / 2,
                top: node.cy - h / 2,
                width: w,
                height: h,
                background: bg,
                border: `1px solid ${border}`,
                borderRadius: sizes.cardRadius,
                opacity,
                transform: `translateY(${translateY}px) scale(${scale})`,
                boxShadow: active
                    ? `0 0 ${glow}px ${accentColor}80, 0 8px 24px rgba(0,0,0,0.35)`
                    : '0 8px 24px rgba(0,0,0,0.35)',
                color: palette.text,
                fontFamily: fonts.sans,
                padding,
                boxSizing: 'border-box',
                backdropFilter: 'blur(6px)',
                display: 'flex',
                alignItems: 'center',
                gap,
            }}
        >
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 4,
                    background: accentColor,
                    borderTopLeftRadius: sizes.cardRadius,
                    borderBottomLeftRadius: sizes.cardRadius,
                }}
            />
            {tag && (
                <span
                    style={{
                        position: 'absolute',
                        top: 10,
                        right: 12,
                        fontSize: tagSize,
                        fontWeight: 600,
                        color: accentColor,
                        background: `${accentColor}22`,
                        padding: '3px 8px',
                        borderRadius: 6,
                        letterSpacing: 0.5,
                        textTransform: 'uppercase',
                        fontFamily: fonts.mono,
                    }}
                >
                    {tag}
                </span>
            )}
            {icon && (
                <div
                    style={{
                        flexShrink: 0,
                        width: compact ? 36 : 44,
                        height: compact ? 36 : 44,
                        borderRadius: 10,
                        background: `${accentColor}1F`,
                        border: `1px solid ${accentColor}55`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    {icon}
                </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
                <div
                    style={{
                        fontSize: titleSize,
                        fontWeight: 700,
                        letterSpacing: -0.3,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                    }}
                >
                    {title}
                </div>
                {subtitle && (
                    <div
                        style={{
                            fontSize: subtitleSize,
                            color: palette.textDim,
                            lineHeight: 1.35,
                            marginTop: 3,
                            whiteSpace: 'pre-line',
                        }}
                    >
                        {subtitle}
                    </div>
                )}
            </div>
        </div>
    );
};

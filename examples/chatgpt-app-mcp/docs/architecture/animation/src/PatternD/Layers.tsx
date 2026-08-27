/** Background, VPC backdrop / labels, and static paths. */

import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { palette, fonts } from '../theme';
import { paths, STATIC_PATH_IDS, svgPath, vpcBox } from '../layout';
import { F } from './anchors';

/** Subtle dotted background grid. */
export const BackgroundGrid: React.FC = () => (
    <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
        <defs>
            <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill={palette.textDim} />
            </pattern>
        </defs>
        <rect width="1920" height="1080" fill="url(#grid)" />
    </svg>
);

/** VPC region — dashed boundary + tint. Renders BEHIND the flow paths. */
export const VpcBackdrop: React.FC = () => {
    const frame = useCurrentFrame();
    const reveal = interpolate(frame, [F.vpcRevealStart, F.vpcRevealEnd], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    return (
        <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity: reveal }}>
            <defs>
                <linearGradient id="vpcFill" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor={palette.vpcFill} />
                    <stop offset="100%" stopColor="rgba(56, 189, 248, 0.02)" />
                </linearGradient>
            </defs>
            <rect
                x={vpcBox.x}
                y={vpcBox.y}
                width={vpcBox.w}
                height={vpcBox.h}
                rx={28}
                ry={28}
                fill="url(#vpcFill)"
                stroke={palette.vpcBorder}
                strokeWidth={2}
                strokeDasharray="10 8"
            />
        </svg>
    );
};

/** VPC labels — HTML divs that render ABOVE the dashed flow paths. */
export const VpcLabels: React.FC = () => {
    const frame = useCurrentFrame();
    const reveal = interpolate(frame, [F.vpcRevealStart, F.vpcRevealEnd], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    return (
        <>
            <div
                style={{
                    position: 'absolute',
                    left: vpcBox.x + 24,
                    top: vpcBox.y - 18,
                    opacity: reveal,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    background: 'rgba(2, 6, 23, 0.95)',
                    border: `1px solid ${palette.vpcBorder}`,
                    borderRadius: 10,
                    padding: '8px 14px',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                }}
            >
                <div
                    style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: palette.vpcLabel,
                        boxShadow: `0 0 10px ${palette.vpcLabel}`,
                    }}
                />
                <div style={{ fontFamily: fonts.mono, fontSize: 14, fontWeight: 700, color: palette.vpcLabel, letterSpacing: 2 }}>
                    VPC
                </div>
                <div style={{ width: 1, height: 14, background: palette.cardBorder }} />
                <div style={{ fontFamily: fonts.mono, fontSize: 12, color: palette.textDim, letterSpacing: 0.6 }}>
                    private
                </div>
            </div>
            <div
                style={{
                    position: 'absolute',
                    left: vpcBox.x + 24,
                    top: vpcBox.y + vpcBox.h - 38,
                    opacity: reveal * 0.9,
                    background: 'rgba(2, 6, 23, 0.85)',
                    border: `1px solid ${palette.cardBorder}`,
                    borderRadius: 8,
                    padding: '6px 12px',
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    color: palette.textDim,
                    letterSpacing: 0.4,
                }}
            >
                DynamoDB Gateway VPCE
            </div>
        </>
    );
};

/** Always-visible dashed polylines connecting the cards. */
export const StaticPaths: React.FC = () => {
    const frame = useCurrentFrame();
    const reveal = interpolate(frame, [F.componentsBase + 30, F.componentsBase + 90], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    return (
        <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, opacity: reveal }}>
            {STATIC_PATH_IDS.map((id) => (
                <path
                    key={id}
                    d={svgPath(paths[id])}
                    fill="none"
                    stroke={palette.pathDim}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="3 9"
                />
            ))}
        </svg>
    );
};

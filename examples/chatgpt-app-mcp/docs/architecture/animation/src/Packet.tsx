/** Animated packet that travels along a polyline path. */

import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { palette, fonts, sizes } from './theme';
import { pointAt, svgPath, type Path } from './layout';

/** Inputs for the `<Packet/>` component. */
export interface PacketProps {
    /** The polyline path to travel. */
    readonly path: Path;
    /** Frame at which packet enters the path. */
    readonly startFrame: number;
    /** Frame at which packet exits (reaches the end). */
    readonly endFrame: number;
    /** Packet colour. */
    readonly color: string;
    /** Optional label shown over the packet while in flight. */
    readonly label?: string;
    /** Trail intensity (0..1). */
    readonly trail?: number;
}

/** A glowing circle that travels along `path` between `startFrame` and `endFrame`. */
export const Packet: React.FC<PacketProps> = ({ path, startFrame, endFrame, color, label, trail = 1 }) => {
    const frame = useCurrentFrame();
    if (frame < startFrame || frame > endFrame) return null;

    const t = interpolate(frame, [startFrame, endFrame], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
    });
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const [x, y] = pointAt(path, ease);
    const fadeIn = interpolate(frame, [startFrame, startFrame + 6], [0, 1], { extrapolateRight: 'clamp' });
    const fadeOut = interpolate(frame, [endFrame - 8, endFrame], [1, 0], { extrapolateLeft: 'clamp' });
    const opacity = Math.min(fadeIn, fadeOut);

    return (
        <>
            <svg
                width="1920"
                height="1080"
                style={{ position: 'absolute', inset: 0, opacity: trail * 0.85 * opacity }}
            >
                <path
                    d={svgPath(path)}
                    fill="none"
                    stroke={color}
                    strokeWidth={3}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeDasharray="6 12"
                />
            </svg>
            <div
                style={{
                    position: 'absolute',
                    left: x - sizes.packetRadius,
                    top: y - sizes.packetRadius,
                    width: sizes.packetRadius * 2,
                    height: sizes.packetRadius * 2,
                    borderRadius: '50%',
                    background: color,
                    boxShadow: `0 0 24px 8px ${color}99, 0 0 56px 16px ${color}55`,
                    opacity,
                }}
            />
            {label && (
                <div
                    style={{
                        position: 'absolute',
                        left: x + 22,
                        top: y - 14,
                        background: 'rgba(15, 23, 42, 0.85)',
                        color: palette.text,
                        border: `1px solid ${color}66`,
                        padding: '5px 11px',
                        borderRadius: 6,
                        fontFamily: fonts.mono,
                        fontSize: 13,
                        whiteSpace: 'nowrap',
                        opacity,
                        backdropFilter: 'blur(6px)',
                    }}
                >
                    {label}
                </div>
            )}
        </>
    );
};

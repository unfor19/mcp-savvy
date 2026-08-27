/** Title card, animated packets, narrator caption track, frame timecode, and footer. */

import React from 'react';
import { interpolate, Sequence, useCurrentFrame } from 'remotion';
import { palette, accent, fonts } from '../theme';
import { paths } from '../layout';
import { Packet } from '../Packet';
import { captions, F } from './anchors';

/** Title card with fade-in / fade-out. */
export const Title: React.FC = () => {
    const frame = useCurrentFrame();
    const opacity = interpolate(
        frame,
        [F.titleEnter, F.titleHold, F.titleExit, F.titleExit + 30],
        [0, 1, 1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    );
    if (opacity <= 0) return null;
    return (
        <Sequence from={F.titleEnter} durationInFrames={F.titleExit + 30}>
            <div
                style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity,
                    background: 'rgba(2, 6, 23, 0.55)',
                    backdropFilter: 'blur(8px)',
                }}
            >
                <div style={{ fontSize: 22, color: palette.textDim, letterSpacing: 4, textTransform: 'uppercase', fontFamily: fonts.mono }}>
                    Pattern D
                </div>
                <div style={{ fontSize: 84, fontWeight: 800, marginTop: 16, letterSpacing: -1.5 }}>
                    Public REST API → VPC Lambda
                </div>
                <div style={{ fontSize: 22, color: palette.textDim, marginTop: 18, fontFamily: fonts.mono }}>
                    app-only fields + host isolation
                </div>
            </div>
        </Sequence>
    );
};

/** Animated packets — full two-call lifecycle: first MCP call mints the ticket, second call redeems it. */
export const ActivePackets: React.FC = () => (
    <>
        <Packet path={paths.oauth} startFrame={F.oauthStart} endFrame={F.oauthEnd} color={accent.identity} label="OAuth → token" />
        <Packet path={paths.request} startFrame={F.requestStart} endFrame={F.requestEnd} color={palette.pathActive} label="POST /mcp + Bearer" />
        <Packet path={paths.jwks} startFrame={F.jwtStart} endFrame={F.jwtEnd} color={accent.identity} label="verify JWT (JWKS)" trail={0.5} />
        <Packet path={paths.forwardToLambda} startFrame={F.forwardStart} endFrame={F.forwardEnd} color="#34D399" label="✓ authenticated" />
        <Packet path={paths.refsMint} startFrame={F.refsMintStart} endFrame={F.refsMintEnd} color={accent.storage} label="mint ticket · 60s · single-use" />
        <Packet path={paths.auditWrite} startFrame={F.auditStart} endFrame={F.auditEnd} color={accent.audit} label="audit · status_requested" />
        <Packet path={paths.response} startFrame={F.responseStart} endFrame={F.responseEnd} color={accent.client} label="200 · { status, currency } + _meta.ticket" />
        <Packet path={paths.request} startFrame={F.widgetCallStart} endFrame={F.widgetCallEnd} color="#38BDF8" label="POST /widgets/balance + ticket" />
        <Packet path={paths.refsMint} startFrame={F.redeemStart} endFrame={F.redeemEnd} color={accent.storage} label="redeem · single-use (410 if reused)" />
        <Packet path={paths.ddbRead} startFrame={F.widgetReadStart} endFrame={F.widgetReadEnd} color={accent.storage} label="GetItem actual balance" />
        <Packet path={paths.auditWrite} startFrame={F.widgetAuditStart} endFrame={F.widgetAuditEnd} color={accent.audit} label="audit · widget_read_completed" />
        <Packet path={paths.response} startFrame={F.widgetBalanceStart} endFrame={F.widgetBalanceEnd} color="#38BDF8" label="balance via _meta · widget code only" />
    </>
);

/** Narrator caption — picks the active line from the `captions` schedule and fades it in/out. */
export const NarratorCaption: React.FC = () => {
    const frame = useCurrentFrame();
    const active = captions.find(([start, end]) => frame >= start && frame <= end);
    if (!active) return null;
    const [start, end, text] = active;
    const op = interpolate(
        frame,
        [start, start + 12, end - 12, end],
        [0, 1, 1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
    );
    return (
        <div
            style={{
                position: 'absolute',
                left: '50%',
                bottom: 70,
                transform: 'translateX(-50%)',
                background: 'rgba(2, 6, 23, 0.92)',
                border: `1px solid ${palette.cardBorder}`,
                borderRadius: 12,
                padding: '14px 26px',
                opacity: op,
                color: palette.text,
                fontFamily: fonts.sans,
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: -0.2,
                maxWidth: 1200,
                textAlign: 'center',
                boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
                backdropFilter: 'blur(6px)',
            }}
        >
            {text}
        </div>
    );
};

/** Frame counter (top-right) — handy when scrubbing in the studio. */
export const FrameTimecode: React.FC = () => {
    const frame = useCurrentFrame();
    return (
        <div
            style={{
                position: 'absolute',
                top: 24,
                right: 32,
                fontFamily: fonts.mono,
                fontSize: 13,
                color: palette.textDim,
                letterSpacing: 1.5,
            }}
        >
            f {String(frame).padStart(4, '0')}
        </div>
    );
};

/** Repository / pattern footer. */
export const Footer: React.FC = () => (
    <div
        style={{
            position: 'absolute',
            bottom: 24,
            left: 32,
            fontFamily: fonts.mono,
            fontSize: 13,
            color: palette.textDim,
            letterSpacing: 1.5,
        }}
    >
        mcp-savvy · chatgpt-app-mcp · Pattern D
    </div>
);

/** Specialised card for the API Gateway — WAF shield + three-stage auth pipeline. */

import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { palette, accent, sizes, fonts } from './theme';
import { nodes } from './layout';

/** Auth pipeline phases — used to drive per-row pulses inside the card. */
export interface AuthPhases {
    /** WAF stage active (managed rules + rate limit + body cap). */
    readonly waf: boolean;
    /** JWT verification active (calls JWKS at Cognito). */
    readonly jwt: boolean;
    /** JSON-RPC schema validation active. */
    readonly schema: boolean;
    /** "AUTHENTICATED" badge visible. */
    readonly authenticated: boolean;
}

/** API Gateway card — fixed at `nodes.apigw`; springs in at `enterAt`. */
export const ApiGatewayCard: React.FC<{ readonly enterAt: number; readonly phases: AuthPhases }> = ({
    enterAt,
    phases,
}) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    const node = nodes.apigw;
    const w = node.w!;
    const h = node.h!;
    const enter = spring({ frame: frame - enterAt, fps, config: { damping: 14, mass: 0.6 } });
    const opacity = interpolate(enter, [0, 1], [0, 1]);
    const translateY = interpolate(enter, [0, 1], [16, 0]);
    const scale = interpolate(enter, [0, 1], [0.92, 1]);
    const anyActive = phases.waf || phases.jwt || phases.schema || phases.authenticated;
    const pulse = anyActive ? 0.5 + 0.5 * Math.sin((frame / fps) * Math.PI * 2 * 1.2) : 0;
    const glow = interpolate(pulse, [0, 1], [0, 24]);

    return (
        <div
            style={{
                position: 'absolute',
                left: node.cx - w / 2,
                top: node.cy - h / 2,
                width: w,
                height: h,
                background: anyActive ? palette.cardBgActive : palette.cardBg,
                border: `1px solid ${anyActive ? accent.apiGw : palette.cardBorder}`,
                borderRadius: sizes.cardRadius,
                opacity,
                transform: `translateY(${translateY}px) scale(${scale})`,
                boxShadow: anyActive
                    ? `0 0 ${glow}px ${accent.apiGw}80, 0 8px 24px rgba(0,0,0,0.35)`
                    : '0 8px 24px rgba(0,0,0,0.35)',
                color: palette.text,
                fontFamily: fonts.sans,
                padding: '20px 22px 22px',
                boxSizing: 'border-box',
                backdropFilter: 'blur(6px)',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
            }}
        >
            <Stripe />
            <WafShield active={phases.waf} />
            <Header />
            <PipelineRow icon="🛡️" label="AWS WAF" detail="managed rules + rate limit" active={phases.waf} accent={accent.waf} />
            <PipelineRow icon="🔐" label="Cognito Authorizer" detail="JWT + scope balance.read" active={phases.jwt} accent={accent.identity} />
            <PipelineRow icon="📐" label="Request Validator" detail="JSON-RPC schema" active={phases.schema} accent={palette.pathActive} />
            <AuthenticatedBadge visible={phases.authenticated} />
        </div>
    );
};

/** Left accent stripe matching the API Gateway colour. */
const Stripe: React.FC = () => (
    <div
        style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            background: accent.apiGw,
            borderTopLeftRadius: sizes.cardRadius,
            borderBottomLeftRadius: sizes.cardRadius,
        }}
    />
);

/** Card title block. */
const Header: React.FC = () => (
    <>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 1.5, textTransform: 'uppercase', color: palette.textDim, fontFamily: fonts.mono }}>
            INGRESS
        </div>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.3, marginTop: -8 }}>
            API Gateway
        </div>
    </>
);

/** WAF shield decoration in the top-right corner. */
const WafShield: React.FC<{ readonly active: boolean }> = ({ active }) => (
    <div style={{ position: 'absolute', top: 14, right: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="34" height="40" viewBox="0 0 34 40" style={{ filter: active ? `drop-shadow(0 0 8px ${accent.waf})` : 'none' }}>
            <path
                d="M17 2 L31 7 V18 C31 27 24 35 17 38 C10 35 3 27 3 18 V7 Z"
                fill={active ? `${accent.waf}55` : `${accent.waf}22`}
                stroke={accent.waf}
                strokeWidth="1.6"
                strokeLinejoin="round"
            />
            <text x="17" y="22" textAnchor="middle" fontFamily={fonts.mono} fontSize="10" fontWeight="700" fill={accent.waf}>
                WAF
            </text>
        </svg>
    </div>
);

/** A single row in the auth pipeline. */
const PipelineRow: React.FC<{
    readonly icon: string;
    readonly label: string;
    readonly detail: string;
    readonly active: boolean;
    readonly accent: string;
}> = ({ icon, label, detail, active, accent: rowAccent }) => (
    <div
        style={{
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
            padding: '8px 12px',
            borderRadius: 8,
            background: active ? `${rowAccent}1F` : 'rgba(255,255,255,0.02)',
            border: `1px solid ${active ? rowAccent : 'rgba(148,163,184,0.18)'}`,
            transition: 'all 200ms ease',
        }}
    >
        <div style={{ fontSize: 18, lineHeight: 1, marginTop: 2 }}>{icon}</div>
        <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: active ? rowAccent : palette.text }}>{label}</div>
            <div style={{ fontSize: 11, color: palette.textDim, marginTop: 2, fontFamily: fonts.mono }}>{detail}</div>
        </div>
        {active && (
            <div
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: rowAccent,
                    boxShadow: `0 0 8px ${rowAccent}`,
                    marginTop: 6,
                }}
            />
        )}
    </div>
);

/** Bottom badge that lights up once all three pipeline steps have passed. */
const AuthenticatedBadge: React.FC<{ readonly visible: boolean }> = ({ visible }) => {
    const frame = useCurrentFrame();
    const op = visible ? Math.min(1, (frame % 1000) > 0 ? 1 : 1) : 0;
    return (
        <div
            style={{
                marginTop: 'auto',
                alignSelf: 'center',
                fontSize: 11,
                fontFamily: fonts.mono,
                fontWeight: 700,
                letterSpacing: 2,
                color: visible ? '#34D399' : 'transparent',
                background: visible ? 'rgba(52, 211, 153, 0.12)' : 'transparent',
                border: visible ? '1px solid rgba(52, 211, 153, 0.5)' : '1px solid transparent',
                borderRadius: 6,
                padding: '4px 10px',
                opacity: op,
                transition: 'opacity 200ms ease',
            }}
        >
            ✓ AUTHENTICATED → Lambda
        </div>
    );
};

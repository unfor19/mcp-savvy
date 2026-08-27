/** Inline SVG icons used by the architecture cards. */

import React from 'react';

/** Common icon props — colour + optional pixel size. */
export interface IconProps {
    /** Stroke / accent colour. */
    readonly color: string;
    /** Side length in px (defaults to 24). */
    readonly size?: number;
}

/** Chat bubble — used for the ChatGPT / MCP host card. */
export const ChatBubbleIcon: React.FC<IconProps> = ({ color, size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path
            d="M4.5 5.5C4.5 4.4 5.4 3.5 6.5 3.5H17.5C18.6 3.5 19.5 4.4 19.5 5.5V13.5C19.5 14.6 18.6 15.5 17.5 15.5H10L5.5 20V15.5C4.94 15.5 4.5 15.06 4.5 14.5Z"
            stroke={color}
            strokeWidth="1.6"
            strokeLinejoin="round"
        />
        <circle cx="9" cy="9.5" r="0.9" fill={color} />
        <circle cx="12" cy="9.5" r="0.9" fill={color} />
        <circle cx="15" cy="9.5" r="0.9" fill={color} />
    </svg>
);

/** Shield + checkmark — Cognito / identity provider. */
export const IdentityIcon: React.FC<IconProps> = ({ color, size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path
            d="M12 2.5L19.5 5.2V11.8C19.5 16.4 16 20.4 12 21.5C8 20.4 4.5 16.4 4.5 11.8V5.2Z"
            stroke={color}
            strokeWidth="1.6"
            strokeLinejoin="round"
        />
        <path
            d="M8.5 12L11 14.5L15.5 10"
            stroke={color}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

/** λ symbol in a rounded square — Lambda compute. */
export const LambdaIcon: React.FC<IconProps> = ({ color, size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="3.2" y="3.2" width="17.6" height="17.6" rx="3.4" stroke={color} strokeWidth="1.6" />
        <text
            x="12"
            y="17.5"
            textAnchor="middle"
            fontSize="15"
            fontWeight="800"
            fill={color}
            fontFamily="ui-monospace, 'JetBrains Mono', Menlo, monospace"
        >
            λ
        </text>
    </svg>
);

/** Three-disc cylinder — DynamoDB / database. */
export const DatabaseIcon: React.FC<IconProps> = ({ color, size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <ellipse cx="12" cy="5" rx="7.5" ry="2.5" stroke={color} strokeWidth="1.6" />
        <path
            d="M4.5 5V11.5C4.5 12.9 7.86 14 12 14C16.14 14 19.5 12.9 19.5 11.5V5"
            stroke={color}
            strokeWidth="1.6"
            strokeLinejoin="round"
        />
        <path
            d="M4.5 11.5V18C4.5 19.4 7.86 20.5 12 20.5C16.14 20.5 19.5 19.4 19.5 18V11.5"
            stroke={color}
            strokeWidth="1.6"
            strokeLinejoin="round"
        />
    </svg>
);

/** Append-only log document — audit_log. Looks like a database with a write arrow. */
export const AuditLogIcon: React.FC<IconProps> = ({ color, size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <ellipse cx="9" cy="5" rx="5.5" ry="2" stroke={color} strokeWidth="1.6" />
        <path d="M3.5 5V18C3.5 19.1 5.96 20 9 20C10.5 20 11.86 19.78 12.85 19.4" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M14.5 5V11" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M3.5 11.5C3.5 12.6 5.96 13.5 9 13.5C10.5 13.5 11.86 13.28 12.85 12.9" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
        <path d="M16 17H22" stroke={color} strokeWidth="1.8" strokeLinecap="round" />
        <path d="M19 14L22 17L19 20" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

/** Single-use ticket — secure_view_refs. */
export const TicketIcon: React.FC<IconProps> = ({ color, size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <ellipse cx="12" cy="5" rx="7.5" ry="2.5" stroke={color} strokeWidth="1.6" />
        <path d="M4.5 5V18C4.5 19.4 7.86 20.5 12 20.5C16.14 20.5 19.5 19.4 19.5 18V5" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M4.5 11.5C4.5 12.9 7.86 14 12 14C16.14 14 19.5 12.9 19.5 11.5" stroke={color} strokeWidth="1.6" />
        <circle cx="12" cy="17" r="1.5" stroke={color} strokeWidth="1.4" />
        <path d="M12 5.5V8" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
);

/** Browser/iframe frame — the widget channel. */
export const WidgetIcon: React.FC<IconProps> = ({ color, size = 24 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="3" y="5" width="18" height="14" rx="2" stroke={color} strokeWidth="1.6" />
        <line x1="3" y1="9.5" x2="21" y2="9.5" stroke={color} strokeWidth="1.6" />
        <circle cx="6" cy="7.3" r="0.7" fill={color} />
        <circle cx="8.4" cy="7.3" r="0.7" fill={color} />
        <circle cx="10.8" cy="7.3" r="0.7" fill={color} />
        <line x1="6.5" y1="13" x2="14" y2="13" stroke={color} strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
        <line x1="6.5" y1="15.5" x2="11.5" y2="15.5" stroke={color} strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
    </svg>
);

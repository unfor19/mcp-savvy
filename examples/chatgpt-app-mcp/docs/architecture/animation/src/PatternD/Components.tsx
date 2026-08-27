/** Architecture cards + their per-frame active states. */

import React from 'react';
import { useCurrentFrame } from 'remotion';
import { accent } from '../theme';
import { nodes } from '../layout';
import { Card } from '../Card';
import { ApiGatewayCard, type AuthPhases } from '../ApiGatewayCard';
import {
    AuditLogIcon,
    ChatBubbleIcon,
    DatabaseIcon,
    IdentityIcon,
    LambdaIcon,
    TicketIcon,
} from '../icons';
import { F } from './anchors';

const inRange = (frame: number, start: number, end: number): boolean =>
    frame >= start && frame <= end;

/** Cards stack: ChatGPT, Cognito, custom API Gateway, Lambda, three DDB tables. */
export const ComponentsLayer: React.FC = () => {
    const frame = useCurrentFrame();

    /* Auth pipeline pulses — first call uses staged WAF → JWT → schema; widget call lights all three briefly. */
    const widgetPipeline = inRange(frame, F.widgetPipelineStart, F.widgetPipelineEnd);
    const phases: AuthPhases = {
        waf: inRange(frame, F.wafStart, F.wafEnd) || widgetPipeline,
        jwt: inRange(frame, F.jwtStart, F.jwtEnd) || widgetPipeline,
        schema: inRange(frame, F.schemaStart, F.schemaEnd) || widgetPipeline,
        authenticated: frame >= F.authBadgeStart,
    };

    const chatGptActive =
        inRange(frame, F.oauthStart, F.oauthEnd) ||
        inRange(frame, F.responseStart, F.responseEnd) ||
        inRange(frame, F.widgetCallStart, F.widgetCallStart + 60) ||
        inRange(frame, F.widgetBalanceStart, F.widgetBalanceEnd);
    const cognitoActive =
        inRange(frame, F.oauthStart, F.oauthEnd) || inRange(frame, F.jwtStart, F.jwtEnd);
    const lambdaActive =
        inRange(frame, F.forwardEnd - 30, F.responseStart + 30) ||
        inRange(frame, F.widgetCallEnd - 30, F.widgetBalanceStart + 30);
    const ddbCustomerActive = inRange(frame, F.widgetReadStart, F.widgetReadEnd + 10);
    const ddbRefsActive =
        inRange(frame, F.refsMintStart, F.refsMintEnd + 10) ||
        inRange(frame, F.redeemStart, F.redeemEnd + 10);
    const ddbAuditActive =
        inRange(frame, F.auditStart, F.auditEnd + 10) ||
        inRange(frame, F.widgetAuditStart, F.widgetAuditEnd + 10);

    return (
        <>
            <Card
                node={nodes.client}
                title="ChatGPT"
                subtitle="model + widget iframe"
                tag="CLIENT"
                accentColor={accent.client}
                enterAt={F.componentsBase}
                active={chatGptActive}
                icon={<ChatBubbleIcon color={accent.client} />}
            />
            <Card
                node={nodes.cognito}
                title="Cognito"
                subtitle="MFA + PKCE"
                tag="IDENTITY"
                accentColor={accent.identity}
                enterAt={F.componentsBase + 20}
                active={cognitoActive}
                icon={<IdentityIcon color={accent.identity} />}
            />
            <ApiGatewayCard enterAt={F.componentsBase + 40} phases={phases} />
            <Card
                node={nodes.lambda}
                title="MCP Lambda"
                subtitle="in VPC"
                tag="COMPUTE"
                accentColor={accent.compute}
                enterAt={F.componentsBase + 60}
                active={lambdaActive}
                icon={<LambdaIcon color={accent.compute} />}
            />
            <Card
                node={nodes.ddbCustomer}
                title="customer_data"
                subtitle="real balance"
                tag="DDB"
                accentColor={accent.storage}
                enterAt={F.componentsBase + 80}
                active={ddbCustomerActive}
                icon={<DatabaseIcon color={accent.storage} />}
            />
            <Card
                node={nodes.ddbRefs}
                title="secure_view_refs"
                subtitle="60s · single-use ticket"
                tag="DDB"
                accentColor={accent.storage}
                enterAt={F.componentsBase + 90}
                active={ddbRefsActive}
                icon={<TicketIcon color={accent.storage} />}
            />
            <Card
                node={nodes.ddbAudit}
                title="audit_log"
                subtitle="append-only"
                tag="DDB"
                accentColor={accent.audit}
                enterAt={F.componentsBase + 100}
                active={ddbAuditActive}
                icon={<AuditLogIcon color={accent.audit} />}
            />
        </>
    );
};

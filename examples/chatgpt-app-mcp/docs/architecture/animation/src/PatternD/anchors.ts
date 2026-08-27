/** Frame anchors at 60 fps, paced for ~75 s wall-clock with explicit privacy-flow narration. */
export const F = {
    titleEnter: 0,
    titleHold: 78,
    titleExit: 195,
    componentsBase: 156,
    vpcRevealStart: 234,
    vpcRevealEnd: 468,

    /* Phase 1 — OAuth side-call */
    oauthStart: 624,
    oauthEnd: 936,

    /* Phase 2 — first MCP call (get_credit_balance_status) */
    requestStart: 988,
    requestEnd: 1222,
    wafStart: 1222,
    wafEnd: 1378,
    jwtStart: 1326,
    jwtEnd: 1560,
    schemaStart: 1508,
    schemaEnd: 1664,
    authBadgeStart: 1664,
    forwardStart: 1716,
    forwardEnd: 1976,

    /* Phase 3 — Lambda mints the single-use ticket */
    refsMintStart: 2028,
    refsMintEnd: 2236,
    auditStart: 2262,
    auditEnd: 2470,

    /* Phase 4 — response splits into two channels */
    responseStart: 2522,
    responseEnd: 2860,

    /* Phase 5 — widget redeems the ticket */
    widgetCallStart: 2980,
    widgetCallEnd: 3260,
    widgetPipelineStart: 3140,
    widgetPipelineEnd: 3260,
    redeemStart: 3320,
    redeemEnd: 3540,
    widgetReadStart: 3580,
    widgetReadEnd: 3800,
    widgetAuditStart: 3820,
    widgetAuditEnd: 4020,
    widgetBalanceStart: 4080,
    widgetBalanceEnd: 4400,

    end: 4560,
} as const;

/** Caption track — `[startFrame, endFrame, text]`. The narrator caption shows whichever entry contains the current frame. */
export const captions: ReadonlyArray<readonly [number, number, string]> = [
    [624, 936, "1 · ChatGPT signs in with Cognito (MFA + PKCE)"],
    [988, 1700, "2 · MCP request: API Gateway runs WAF → JWT → schema validation"],
    [1716, 1976, "3 · authenticated · API Gateway proxies to Lambda"],
    [2028, 2236, "4 · Lambda mints a 60-second single-use ticket in DynamoDB"],
    [2262, 2470, "5 · Lambda writes an audit event"],
    [2522, 2860, "6 · reply: { status, currency } visible to model · ticket only via _meta"],
    [2980, 3260, "7 · ChatGPT's widget code makes a second call with the ticket"],
    [3320, 3540, "8 · ticket is redeemed (atomic, single-use — second redeem returns 410 Gone)"],
    [3580, 3800, "9 · Lambda reads the actual balance from customer_data"],
    [4080, 4400, "10 · balance returns via _meta — model never saw the number"],
];

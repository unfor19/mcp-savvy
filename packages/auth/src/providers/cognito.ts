/**
 * Cognito preset on top of `OidcPkceProvider`.
 *
 * Cognito works fine with the generic OIDC provider — this wrapper
 * exists to compose the issuer URL from a region + user-pool ID, since
 * that's what most users have at hand from the AWS console / CDK
 * outputs.
 */

import { OidcPkceProvider, type OidcPkceProviderOptions } from './oidcPkce.js';

/**
 * Options for `CognitoProvider`. Either pass `issuer` directly OR
 * `region` + `userPoolId`; the latter composes the canonical issuer URL.
 */
export type CognitoProviderOptions =
    | (Omit<OidcPkceProviderOptions, 'issuer'> & {
        /** AWS region, e.g. 'us-east-1'. */
        region: string;
        /** Cognito user pool ID, e.g. 'us-east-1_AbCdEfGhI'. */
        userPoolId: string;
    })
    | OidcPkceProviderOptions;

/** Build the canonical issuer URL for a Cognito user pool. */
export function cognitoIssuer(region: string, userPoolId: string): string {
    return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
}

/** Cognito preset of `OidcPkceProvider` with a region/userPoolId helper. */
export class CognitoProvider extends OidcPkceProvider {
    constructor(opts: CognitoProviderOptions) {
        if ('region' in opts && 'userPoolId' in opts) {
            const { region, userPoolId, ...rest } = opts;
            super({
                ...rest,
                issuer: cognitoIssuer(region, userPoolId),
            });
        } else {
            super(opts);
        }
    }
}

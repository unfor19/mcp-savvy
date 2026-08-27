/** Synthesized security assertions for the regional WebACL. */

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildRegionalWebAcl } from './waf.js';

describe('buildRegionalWebAcl', () => {
    it('keeps metrics but disables credential-bearing request samples everywhere', () => {
        const stack = new Stack(new App(), 'WafTest');
        buildRegionalWebAcl(stack, 'Acl');
        const resources = Template.fromStack(stack).findResources('AWS::WAFv2::WebACL');
        const acl = Object.values(resources)[0] as {
            Properties: {
                VisibilityConfig: { CloudWatchMetricsEnabled: boolean; SampledRequestsEnabled: boolean };
                Rules: Array<{ VisibilityConfig: { CloudWatchMetricsEnabled: boolean; SampledRequestsEnabled: boolean } }>;
            };
        };
        const visibility = [acl.Properties.VisibilityConfig, ...acl.Properties.Rules.map((rule) => rule.VisibilityConfig)];
        expect(visibility).toHaveLength(5);
        expect(visibility.every((config) => config.CloudWatchMetricsEnabled)).toBe(true);
        expect(visibility.every((config) => !config.SampledRequestsEnabled)).toBe(true);
    });
});

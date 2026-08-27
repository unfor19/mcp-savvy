/**
 * Tests for the opt-in deploy-time legs of `BedrockKnowledgeBase`:
 * `corpus` (BucketDeployment upload) and `autoIngest` (the ingestion
 * custom resource). Kept separate from `index.test.ts` so each file
 * stays focused and within the file-size budget.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { BedrockKnowledgeBase } from './index.js';
import { freshStack } from '../testFixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Path to the tiny corpus fixture used by the deploy-time tests. */
const CORPUS_FIXTURE = path.resolve(HERE, '..', '..', 'test', 'fixtures', 'corpus');

describe('BedrockKnowledgeBase — deploy-time corpus + ingestion', () => {
    it('adds no ingestion custom resource or corpus deployment by default', () => {
        const stack = freshStack('KbNoAuto');
        const kb = new BedrockKnowledgeBase(stack, 'KB', {});
        const template = Template.fromStack(stack);
        expect(kb.ingestion).toBeUndefined();
        expect(kb.corpusDeployment).toBeUndefined();
        template.resourceCountIs('Custom::McpSavvyKbIngestion', 0);
    });

    it('delivers a corpus via BucketDeployment when `corpus` is set', () => {
        const stack = freshStack('KbCorpus');
        const kb = new BedrockKnowledgeBase(stack, 'KB', {
            corpus: { path: CORPUS_FIXTURE, keyPrefix: 'posts/' },
        });
        const template = Template.fromStack(stack);
        expect(kb.corpusDeployment).toBeDefined();
        // BucketDeployment surfaces as a Custom::CDKBucketDeployment.
        template.resourceCountIs('Custom::CDKBucketDeployment', 1);
        template.hasResourceProperties('Custom::CDKBucketDeployment', {
            DestinationBucketKeyPrefix: 'posts/',
            Prune: false,
        });
    });

    it('runs a deploy-time ingestion custom resource when `autoIngest` is set', () => {
        const stack = freshStack('KbIngest');
        const kb = new BedrockKnowledgeBase(stack, 'KB', { autoIngest: true });
        const template = Template.fromStack(stack);
        expect(kb.ingestion).toBeDefined();
        template.resourceCountIs('Custom::McpSavvyKbIngestion', 1);
        template.hasResourceProperties('Custom::McpSavvyKbIngestion', {
            Trigger: 'initial',
        });
    });

    it('defaults the ingestion trigger to the corpus content hash', () => {
        const stack = freshStack('KbIngestCorpus');
        new BedrockKnowledgeBase(stack, 'KB', {
            corpus: { path: CORPUS_FIXTURE },
            autoIngest: true,
        });
        const template = Template.fromStack(stack);
        const resources = template.findResources('Custom::McpSavvyKbIngestion');
        const triggers = Object.values(resources).map(
            (r) => r.Properties?.Trigger as string,
        );
        expect(triggers).toHaveLength(1);
        // Content hash, not the 'initial' fallback.
        expect(triggers[0]).not.toBe('initial');
        expect(triggers[0]).toMatch(/^[0-9a-f]{16,}$/);
    });

    it('honors an explicit ingestionTrigger override', () => {
        const stack = freshStack('KbIngestTrigger');
        new BedrockKnowledgeBase(stack, 'KB', {
            autoIngest: true,
            ingestionTrigger: 'rev-42',
        });
        const template = Template.fromStack(stack);
        template.hasResourceProperties('Custom::McpSavvyKbIngestion', {
            Trigger: 'rev-42',
        });
    });

    it('scopes the ingestion Lambda grants to the KB ARN', () => {
        const stack = freshStack('KbIngestIam');
        new BedrockKnowledgeBase(stack, 'KB', { autoIngest: true });
        const template = Template.fromStack(stack);
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: 'bedrock:StartIngestionJob',
                        Effect: 'Allow',
                    }),
                ]),
            },
        });
        template.hasResourceProperties('AWS::IAM::Policy', {
            PolicyDocument: {
                Statement: Match.arrayWith([
                    Match.objectLike({
                        Action: 'bedrock:GetIngestionJob',
                        Effect: 'Allow',
                    }),
                ]),
            },
        });
    });
});

describe('BedrockKnowledgeBase — deploy-time cdk-nag', () => {
    // Aspect-level check: Template.fromStack alone does NOT run
    // cdk-nag aspects, so construct-scoped suppressions can silently
    // miss stack-level singletons (the BucketDeployment uploader) and
    // the cr.Provider waiter Step Function. Applying AwsSolutionsChecks
    // here and asserting zero findings is what guards that gap — it
    // mirrors what `cdk synth --strict` does on a real deploy.
    function synthWithNag(): cdk.Stack {
        const stack = freshStack('KbNagFull');
        new BedrockKnowledgeBase(stack, 'KB', {
            corpus: { path: CORPUS_FIXTURE, keyPrefix: 'posts/' },
            autoIngest: true,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        cdk.Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
        return stack;
    }

    it('has no unsuppressed AwsSolutions errors with corpus + autoIngest', () => {
        const stack = synthWithNag();
        const errors = Annotations.fromStack(stack).findError(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        const ids = errors.map(
            (e) => `${e.id}: ${JSON.stringify(e.entry.data)}`,
        );
        expect(ids).toStrictEqual([]);
    });

    it('has no unsuppressed AwsSolutions warnings with corpus + autoIngest', () => {
        const stack = synthWithNag();
        const warnings = Annotations.fromStack(stack).findWarning(
            '*',
            Match.stringLikeRegexp('AwsSolutions-.*'),
        );
        expect(warnings.map((w) => w.id)).toStrictEqual([]);
    });
});

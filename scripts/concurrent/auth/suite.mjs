/** Runs the cross-process authentication fixture protocol and acceptance scenarios. */

import { runAuthReuseAcceptanceTests } from './acceptance.mjs';
import { verifyAuthFixtureProtocol } from './index.mjs';

/** Verify fixture capabilities, then execute all authentication reuse scenarios. */
export async function runAuthFixtureSuite(input) {
    process.stdout.write('Authentication fixture protocol:\n');
    const fixture = await verifyAuthFixtureProtocol({
        dataDir: input.dataDir,
        namespace: `${input.namespace}-protocol`,
    });
    process.stdout.write(
        `  ✓ ${fixture.capabilities.length} deterministic capabilities negotiated\n`,
    );
    process.stdout.write('Authentication reuse acceptance tests:\n');
    await runAuthReuseAcceptanceTests({
        dataDir: input.dataDir,
        namespace: `${input.namespace}-acceptance`,
    });
}

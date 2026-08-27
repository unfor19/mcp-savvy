/** Remotion composition registry for the chatgpt-app-mcp animations. */

import React from 'react';
import { Composition } from 'remotion';
import { PatternD } from './PatternD';

/** Root component — registers every composition rendered by `remotion render`. */
export const RemotionRoot: React.FC = () => (
    <>
        <Composition
            id="PatternD"
            component={PatternD}
            durationInFrames={4560}
            fps={60}
            width={1920}
            height={1080}
        />
    </>
);

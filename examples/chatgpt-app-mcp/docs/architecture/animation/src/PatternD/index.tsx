/** Pattern D animation — LTR request flow for the deployed chatgpt-app-mcp architecture. */

import React from 'react';
import { AbsoluteFill } from 'remotion';
import { palette, fonts } from '../theme';
import { BackgroundGrid, StaticPaths, VpcBackdrop, VpcLabels } from './Layers';
import { ComponentsLayer } from './Components';
import { ActivePackets, Footer, FrameTimecode, NarratorCaption, Title } from './Overlays';

/** Top-level composition. Layer order matters: backdrop → paths → labels → cards → packets → overlays. */
export const PatternD: React.FC = () => (
    <AbsoluteFill
        style={{
            background: `radial-gradient(ellipse at center, ${palette.bgGradientTop}, ${palette.bgGradientBottom})`,
            fontFamily: fonts.sans,
            color: palette.text,
        }}
    >
        <BackgroundGrid />
        <VpcBackdrop />
        <StaticPaths />
        <VpcLabels />
        <Title />
        <ComponentsLayer />
        <ActivePackets />
        <NarratorCaption />
        <FrameTimecode />
        <Footer />
    </AbsoluteFill>
);

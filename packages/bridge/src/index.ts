/**
 * Public surface of `@mcp-savvy/bridge`.
 */

export { StdioBridge } from './stdioBridge.js';
export type {
    StdioBridgeInternalOptions,
    StdioTransportFactory,
} from './stdioBridge.js';
export type { RemoteTransportFactory } from './remoteTransport.js';
export { BRIDGE_ERROR_CODES, categorizeBridgeError } from './bridgeErrors.js';
export type { BridgeErrorCategory } from './bridgeErrors.js';
export type { StdioBridgeOptions, TokenProvider } from './types.js';
export { passThroughInterceptor } from './interceptors/response.js';
export type {
    ResponseAction,
    ResponseInterceptor,
    ResponseInterceptorInput,
} from './interceptors/response.js';
export { passThroughRequestInterceptor } from './interceptors/request.js';
export type {
    RequestAction,
    RequestInterceptor,
    RequestInterceptorInput,
} from './interceptors/request.js';
export {
    composeRequestInterceptors,
    composeResponseInterceptors,
} from './interceptors/compose.js';
export {
    gatewaySessionInterceptor,
    URL_ELICITATION_REQUIRED,
} from './gatewaySessionInterceptor.js';
export type { GatewaySessionInterceptorInput } from './gatewaySessionInterceptor.js';
export { searchFirstInterceptors, DEFAULT_TOOL_PREFIX } from './searchFirst/index.js';
export type {
    SearchFirstMode,
    SearchFirstOptions,
    SearchFirstInterceptors,
    CachedTool,
} from './searchFirst/index.js';

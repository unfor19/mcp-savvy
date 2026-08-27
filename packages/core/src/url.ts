/** Security policy for endpoints that carry authentication material. */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', '::1', 'localhost']);

/** Return whether a URL uses HTTPS without embedded user information. */
export function isHttpsEndpointUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.username.length === 0 && url.password.length === 0;
    } catch {
        return false;
    }
}

/** Return whether a URL uses HTTPS or exact loopback HTTP without user info. */
export function isSecureEndpointUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.username.length > 0 || url.password.length > 0) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

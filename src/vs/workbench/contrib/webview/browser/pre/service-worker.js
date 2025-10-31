/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
//@ts-check
/// <reference lib="webworker" />

/** @type {ServiceWorkerGlobalScope} */
const sw = /** @type {any} */ (self);

const scriptUrl = new URL(sw.location.href);
const VERSION = scriptUrl.searchParams.get('v') ?? '0';

const resourceCacheName = `vscode-resource-cache-${VERSION}`;

const rootPath = sw.location.pathname.replace(/\/service-worker.js$/, '');

const searchParams = new URL(location.toString()).searchParams;

const remoteAuthority = searchParams.get('remoteAuthority');

/** @type {MessagePort|undefined} */
let outerIframeMessagePort;

/** @type {{ request: string, target: ResourceRequestUrlComponents } | undefined} */
let lastResourceDebug;

const DEBUG_LAST_RESOURCE_SEGMENT = '__debug__/last-resource';

const createLastResourceResponse = () => new Response(JSON.stringify(lastResourceDebug ?? null), {
	status: 200,
	headers: { 'Content-Type': 'application/json' }
});

/**
 * @param {FetchEvent} event
 */
const respondWithLastResource = (event) => event.respondWith(createLastResourceResponse());

/**
 * @param {string} segment
 */
const isDebugResourceSegment = (segment) => {
	const queryIndex = segment.indexOf('?');
	const withoutQuery = queryIndex === -1 ? segment : segment.slice(0, queryIndex);
	const trimmed = withoutQuery.replace(/^(\.\/)+/, '');
	return trimmed === DEBUG_LAST_RESOURCE_SEGMENT;
};

/**
 * Origin used for resources
 */
const resourceBaseAuthority = searchParams.get('vscode-resource-base-authority');
const FALLBACK_RESOURCE_SCHEME = 'https';
const resourceBaseScheme = (searchParams.get('vscode-resource-base-scheme') ?? FALLBACK_RESOURCE_SCHEME).toLowerCase() || FALLBACK_RESOURCE_SCHEME;

const log = (...args) => {
	try {
		console.log('[WebviewSW]', ...args);
	} catch (error) {
		// ignore logging failures (e.g. console not available)
	}
};

/**
 * @param {string} name
 * @param {Record<string, string>} [options]
 */
const perfMark = (name, options = {}) => {
	performance.mark(`webview/service-worker/${name}`, {
		detail: {
			...options
		}
	});
}

perfMark('scriptStart');
log('script start', { version: VERSION, scope: sw.registration?.scope });

/** @type {number} */
const resolveTimeout = 30_000;

const decodeComponentMulti = (value) => {
	let result = value;
	for (let i = 0; i < 3; i++) {
		try {
			const decoded = decodeURIComponent(result);
			if (decoded === result) {
				break;
			}
			result = decoded;
		} catch {
			break;
		}
	}
	return result;
};

const decodeAuthoritySegment = (value) => {
	return decodeComponentMulti(value.replace(/-([0-9a-fA-F]{4})/g, (_, hex) => {
		try {
			return String.fromCharCode(parseInt(hex, 16));
		} catch {
			return `-${hex}`;
		}
	}));
};

const parseEncodedBaseHref = (encoded) => {
	const decoded = decodeComponentMulti(encoded);
	const matches = decoded.match(/^([a-zA-Z0-9+\-.]+):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
	if (!matches) {
		return undefined;
	}

	const originalScheme = matches[1];
	const rawHost = decodeAuthoritySegment(matches[2]);
	let path = decodeComponentMulti(matches[3] ?? '/');
	if (!path.length || !path.startsWith('/')) {
		path = `/${path}`;
	}
	const query = matches[4] ? decodeComponentMulti(matches[4].slice(1)) : '';

	let scheme = originalScheme;
	let authority = rawHost;

	const marker = '.vscode-resource.';
	const lowerHost = rawHost.toLowerCase();
	const markerIndex = lowerHost.indexOf(marker);
	if (markerIndex >= 0) {
		const prefix = rawHost.slice(0, markerIndex);
		const plusIndex = prefix.indexOf('+');
		if (plusIndex >= 0) {
			scheme = prefix.slice(0, plusIndex);
			const encodedAuthority = prefix.slice(plusIndex + 1);
			authority = decodeAuthoritySegment(encodedAuthority);
		} else if (prefix === 'file') {
			scheme = 'file';
			authority = '';
		}
	} else if (lowerHost.startsWith('file+vscode-resource')) {
		scheme = 'file';
		authority = '';
	} else if (lowerHost.startsWith('vscode-resource')) {
		scheme = 'file';
		authority = '';
	}

	return { scheme, authority, path, query };
};

const resolveResourceSegment = (basePath, resourceSegment) => {
	try {
		const baseForResolution = new URL(basePath || '/', 'http://placeholder');
		const resolved = new URL(resourceSegment || '.', baseForResolution);
		return {
			path: resolved.pathname,
			query: resolved.search.replace(/^\?/, ''),
		};
	} catch {
		return {
			path: resourceSegment || '/',
			query: '',
		};
	}
};

const resolveNestedResource = (baseInfo, resourceSegmentRaw, requestUrlSearch) => {
	let currentBase = baseInfo;
	let remaining = resourceSegmentRaw;

	while (remaining.startsWith('resource/')) {
		remaining = remaining.slice('resource/'.length);
		const slashIndex = remaining.indexOf('/');
		if (slashIndex === -1) {
			return undefined;
		}

		const nestedEncodedBase = remaining.slice(0, slashIndex);
		const nestedBaseInfo = parseEncodedBaseHref(nestedEncodedBase);
		if (!nestedBaseInfo) {
			return undefined;
		}

		currentBase = nestedBaseInfo;
		remaining = remaining.slice(slashIndex + 1);
	}

	if (!remaining.length) {
		return {
			scheme: currentBase.scheme,
			authority: currentBase.authority,
			path: currentBase.path,
			query: currentBase.query || requestUrlSearch,
		};
	}

	let segmentPathRaw = remaining;
	let segmentQueryRaw = '';
	const questionIndex = remaining.indexOf('?');
	if (questionIndex !== -1) {
		segmentPathRaw = remaining.slice(0, questionIndex);
		segmentQueryRaw = remaining.slice(questionIndex + 1);
	}

	const decodedSegment = decodeComponentMulti(segmentPathRaw);
	const resolved = resolveResourceSegment(currentBase.path, decodedSegment);

	const decodedSegmentQuery = segmentQueryRaw ? decodeComponentMulti(segmentQueryRaw) : '';
	const combinedQuery = resolved.query
		|| decodedSegmentQuery
		|| currentBase.query
		|| requestUrlSearch;

	const target = {
		scheme: currentBase.scheme,
		authority: currentBase.authority,
		path: resolved.path,
		query: combinedQuery,
	};

	log('resolve nested resource', {
		base: currentBase,
		raw: resourceSegmentRaw,
		remaining,
		decodedSegment,
		target
	});

	return target;
};


/**
 * @template T
 * @typedef {{ status: 'ok', value: T } | { status: 'timeout' }} RequestStoreResult
 */


/**
 * @template T
 * @typedef {{ resolve: (x: RequestStoreResult<T>) => void, promise: Promise<RequestStoreResult<T>> }} RequestStoreEntry
 */


/**
 * @template T
 */
class RequestStore {
	constructor() {
		/** @type {Map<number, RequestStoreEntry<T>>} */
		this.map = new Map();
		/** @type {number} */
		this.requestPool = 0;
	}

	/**
	 * @returns {{ requestId: number, promise: Promise<RequestStoreResult<T>> }}
	 */
	create() {
		const requestId = ++this.requestPool;

		/** @type {(x: RequestStoreResult<T>) => void} */
		let resolve;
		const promise = new Promise(r => resolve = r);

		/** @type {RequestStoreEntry<T>} */
		const entry = { resolve, promise };
		this.map.set(requestId, entry);

		const dispose = () => {
			clearTimeout(timeout);
			const existingEntry = this.map.get(requestId);
			if (existingEntry === entry) {
				existingEntry.resolve({ status: 'timeout' });
				this.map.delete(requestId);
			}
		};
		const timeout = setTimeout(dispose, resolveTimeout);
		return { requestId, promise };
	}

	/**
	 * @param {number} requestId
	 * @param {T} result
	 * @returns {boolean}
	 */
	resolve(requestId, result) {
		const entry = this.map.get(requestId);
		if (!entry) {
			return false;
		}
		entry.resolve({ status: 'ok', value: result });
		this.map.delete(requestId);
		return true;
	}
}

/**
 * Map of requested paths to responses.
 */
/** @type {RequestStore<ResourceResponse>} */
const resourceRequestStore = new RequestStore();

/**
 * Map of requested localhost origins to optional redirects.
 */
/** @type {RequestStore<string|undefined>} */
const localhostRequestStore = new RequestStore();

const unauthorized = () =>
	new Response('Unauthorized', { status: 401, });

const notFound = () =>
	new Response('Not Found', { status: 404, });

const methodNotAllowed = () =>
	new Response('Method Not Allowed', { status: 405, });

const requestTimeout = () =>
	new Response('Request Timeout', { status: 408, });

sw.addEventListener('message', async (event) => {
	if (!event.source) {
		return;
	}

	/** @type {Client} */
	const source = event.source;
	log('message event', { channel: event.data?.channel, clientId: source.id });
	switch (event.data.channel) {
		case 'version': {
			perfMark('version/request');
			outerIframeMessagePort = event.ports[0];
			sw.clients.get(source.id).then(client => {
				perfMark('version/reply');
				if (client) {
					client.postMessage({
						channel: 'version',
						version: VERSION
					});
				}
				log('message:version -> replied', { clientFound: !!client });
			});
			return;
		}
		case 'did-load-resource': {
			/** @type {ResourceResponse} */
			const response = event.data.data;
			if (!resourceRequestStore.resolve(response.id, response)) {
				console.log('Could not resolve unknown resource', response.path);
			}
			log('message:did-load-resource', { id: response.id, path: response.path, status: response.status });
			return;
		}
		case 'did-load-localhost': {
			const data = event.data.data;
			if (!localhostRequestStore.resolve(data.id, data.location)) {
				console.log('Could not resolve unknown localhost', data.origin);
			}
			log('message:did-load-localhost', { id: data.id, origin: data.origin, location: data.location });
			return;
		}
		case 'debug-get-last-resource': {
			const respond = (client) => {
				if (client && lastResourceDebug) {
					client.postMessage({ channel: 'debug-last-resource', data: lastResourceDebug });
					return true;
				}
				return false;
			};
			sw.clients.get(source.id).then(client => {
				if (!respond(client) && outerIframeMessagePort && lastResourceDebug) {
					outerIframeMessagePort.postMessage({ channel: 'debug-last-resource', data: lastResourceDebug });
				}
			});
			return;
		}
		default: {
			log('message:unknown-channel', event.data);
			console.log('Unknown message');
			return;
		}
	}
});

sw.addEventListener('fetch', (event) => {
	const requestUrl = new URL(event.request.url);
	log('fetch event', { url: requestUrl.toString() });

	if (requestUrl.origin === sw.origin && requestUrl.pathname === `${rootPath}/__debug__/last-resource`) {
		return respondWithLastResource(event);
	}

	const sameOriginResourcePrefix = `${rootPath}/resource/`;
	if (requestUrl.origin === sw.origin && requestUrl.pathname.startsWith(sameOriginResourcePrefix)) {
		log('resource fetch candidate', { pathname: requestUrl.pathname });
		const remainder = requestUrl.pathname.slice(sameOriginResourcePrefix.length);
		const firstSlash = remainder.indexOf('/');
		if (firstSlash > 0) {
			let encodedBase = remainder.slice(0, firstSlash);
			const normalizeEncodedBase = (value) => {
				const decoded = decodeComponentMulti(value);
				if (/^https?:\/\/vscode-remote\+/i.test(decoded)) {
					return encodeURIComponent(decoded);
				}
				return value;
			};
			encodedBase = normalizeEncodedBase(encodedBase);
			let resourceSegmentRaw = remainder.slice(firstSlash + 1);
			const sanitizeSegment = (segment) => {
				const slashIndex = segment.indexOf('/');
				const head = slashIndex === -1 ? segment : segment.slice(0, slashIndex);
				const tail = slashIndex === -1 ? '' : segment.slice(slashIndex);
				const decodedHead = decodeComponentMulti(head);
				if (/^https?:\/\/vscode-remote\+/i.test(decodedHead)) {
					const sanitizedHead = encodeURIComponent(decodedHead);
					return `${sanitizedHead}${tail}`;
				}
				return segment;
			};
			resourceSegmentRaw = sanitizeSegment(resourceSegmentRaw);

			if (isDebugResourceSegment(resourceSegmentRaw)) {
				return respondWithLastResource(event);
			}

			try {
				const baseInfo = parseEncodedBaseHref(encodedBase);
				if (!baseInfo) {
					log('failed to parse resource base href', { encodedBase });
					return event.respondWith(fetch(event.request));
				}
				log('parsed base href', { base: baseInfo, resourceSegmentRaw });

				const target = resolveNestedResource(baseInfo, resourceSegmentRaw, requestUrl.search.replace(/^\?/, ''));
				if (!target) {
					log('failed to resolve nested resource proxy', { encodedBase, resourceSegmentRaw });
					return event.respondWith(fetch(event.request));
				}

				log('same-origin resource proxy', {
					request: requestUrl.toString(),
					base: decodeComponentMulti(encodedBase),
					resourceSegmentRaw,
					target
				});
				lastResourceDebug = { request: requestUrl.toString(), target };
				try {
					const debugResponse = new Response(JSON.stringify(lastResourceDebug), {
						status: 200,
						headers: { 'Content-Type': 'application/json' }
					});
					caches.open(resourceCacheName).then(cache => {
						cache.put(`${sw.origin}${rootPath}/__debug__/last-resource`, debugResponse);
					});
				} catch (error) {
					log('failed to cache last resource debug', `${error}`);
				}

				return event.respondWith(processResourceRequest(event, target));
			} catch (error) {
				log('failed to resolve same-origin resource proxy', { encodedBase, error: `${error}` });
				return event.respondWith(fetch(event.request));
			}
		} else {
			return event.respondWith(fetch(event.request));
		}
	}
	if (typeof resourceBaseAuthority === 'string' && resourceBaseAuthority.length > 0 && requestUrl.protocol === `${resourceBaseScheme}:` && requestUrl.hostname.endsWith('.' + resourceBaseAuthority)) {
		switch (event.request.method) {
			case 'GET':
			case 'HEAD': {
				const firstHostSegment = requestUrl.hostname.slice(0, requestUrl.hostname.length - (resourceBaseAuthority.length + 1));
				const scheme = firstHostSegment.split('+', 1)[0];
				const authority = firstHostSegment.slice(scheme.length + 1); // may be empty
				return event.respondWith(processResourceRequest(event, {
					scheme,
					authority,
					path: requestUrl.pathname,
					query: requestUrl.search.replace(/^\?/, ''),
				}));
			}
			default: {
				return event.respondWith(methodNotAllowed());
			}
		}
	}

	// If we're making a request against the remote authority, we want to go
	// through VS Code itself so that we are authenticated properly.  If the
	// service worker is hosted on the same origin we will have cookies and
	// authentication will not be an issue.
	if (requestUrl.origin !== sw.origin && requestUrl.host === remoteAuthority) {
		switch (event.request.method) {
			case 'GET':
			case 'HEAD': {
				return event.respondWith(processResourceRequest(event, {
					path: requestUrl.pathname,
					scheme: requestUrl.protocol.slice(0, requestUrl.protocol.length - 1),
					authority: requestUrl.host,
					query: requestUrl.search.replace(/^\?/, ''),
				}));
			}
			default: {
				return event.respondWith(methodNotAllowed());
			}
		}
	}

	// See if it's a localhost request
	if (requestUrl.origin !== sw.origin && requestUrl.host.match(/^(localhost|127.0.0.1|0.0.0.0):(\d+)$/)) {
		return event.respondWith(processLocalhostRequest(event, requestUrl));
	}
});

sw.addEventListener('install', (event) => {
	log('install event');
	event.waitUntil(sw.skipWaiting()); // Activate worker immediately
});

sw.addEventListener('activate', (event) => {
	log('activate event - claiming clients');
	event.waitUntil(sw.clients.claim()); // Become available to all pages
});


/**
 * @typedef {Object} ResourceRequestUrlComponents
 * @property {string} scheme
 * @property {string} authority
 * @property {string} path
 * @property {string} query
 */

/**
 * @param {FetchEvent} event
 * @param {ResourceRequestUrlComponents} requestUrlComponents
 * @returns {Promise<Response>}
 */
async function processResourceRequest(
	event,
	requestUrlComponents
) {
	let client = await sw.clients.get(event.clientId);
	if (!client) {
		client = await getWorkerClientForId(event.clientId);
	}

	const webviewId = client ? getWebviewIdForClient(client) : null;

	// Refs https://github.com/microsoft/vscode/issues/244143
	// With PlzDedicatedWorker, worker subresources and blob wokers
	// will use clients different from the window client.
	// Since we cannot different a worker main resource from a worker subresource
	// we will use message channel to the outer iframe provided at the time
	// of service worker controller version initialization.
	if (!webviewId && client.type !== 'worker' && client.type !== 'sharedworker') {
		console.error('Could not resolve webview id');
		return notFound();
	}

	const shouldTryCaching = (event.request.method === 'GET');

	/**
	 * @param {RequestStoreResult<ResourceResponse>} result
	 * @param {Response|undefined} cachedResponse
	 * @returns {Response}
	 */
	const resolveResourceEntry = (result, cachedResponse) => {
		if (result.status === 'timeout') {
			return requestTimeout();
		}

		const entry = result.value;
		if (entry.status === 304) { // Not modified
			if (cachedResponse) {
				return cachedResponse.clone();
			} else {
				throw new Error('No cache found');
			}
		}

		if (entry.status === 401) {
			return unauthorized();
		}

		if (entry.status !== 200) {
			return notFound();
		}

		/** @type {Record<string, string>} */
		const commonHeaders = {
			'Access-Control-Allow-Origin': '*',
		};

		const byteLength = entry.data.byteLength;

		const range = event.request.headers.get('range');
		if (range) {
			// To support seeking for videos, we need to handle range requests
			const bytes = range.match(/^bytes\=(\d+)\-(\d+)?$/g);
			if (bytes) {
				// TODO: Right now we are always reading the full file content. This is a bad idea
				// for large video files :)

				const start = Number(bytes[1]);
				const end = Number(bytes[2]) || byteLength - 1;
				return new Response(entry.data.slice(start, end + 1), {
					status: 206,
					headers: {
						...commonHeaders,
						'Content-range': `bytes 0-${end}/${byteLength}`,
					}
				});
			} else {
				// We don't understand the requested bytes
				return new Response(null, {
					status: 416,
					headers: {
						...commonHeaders,
						'Content-range': `*/${byteLength}`
					}
				});
			}
		}

		/** @type {Record<string, string>} */
		const headers = {
			...commonHeaders,
			'Content-Type': entry.mime,
			'Content-Length': byteLength.toString(),
		};

		if (entry.etag) {
			headers['ETag'] = entry.etag;
			headers['Cache-Control'] = 'no-cache';
		}
		if (entry.mtime) {
			headers['Last-Modified'] = new Date(entry.mtime).toUTCString();
		}

		// support COI requests, see network.ts#COI.getHeadersFromQuery(...)
		const coiRequest = new URL(event.request.url).searchParams.get('vscode-coi');
		if (coiRequest === '3') {
			headers['Cross-Origin-Opener-Policy'] = 'same-origin';
			headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
		} else if (coiRequest === '2') {
			headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
		} else if (coiRequest === '1') {
			headers['Cross-Origin-Opener-Policy'] = 'same-origin';
		}

		const response = new Response(entry.data, {
			status: 200,
			headers
		});

		if (shouldTryCaching && entry.etag) {
			caches.open(resourceCacheName).then(cache => {
				return cache.put(event.request, response);
			});
		}
		return response.clone();
	};

	/** @type {Response|undefined} */
	let cached;
	if (shouldTryCaching) {
		const cache = await caches.open(resourceCacheName);
		cached = await cache.match(event.request);
	}

	const { requestId, promise } = resourceRequestStore.create();

	const dispatchToOuterIframe = () => {
		if (!outerIframeMessagePort) {
			return false;
		}
		log('same-origin load-resource via message port (fallback)', {
			id: requestId,
			clientFound: !!client,
			scheme: requestUrlComponents.scheme,
			authority: requestUrlComponents.authority,
			path: requestUrlComponents.path,
			query: requestUrlComponents.query
		});
		outerIframeMessagePort.postMessage({
			channel: 'load-resource',
			id: requestId,
			scheme: requestUrlComponents.scheme,
			authority: requestUrlComponents.authority,
			path: requestUrlComponents.path,
			query: requestUrlComponents.query,
			ifNoneMatch: cached?.headers.get('ETag'),
		});
		return true;
	};

	if (webviewId && client) {
		const parentClients = await getOuterIframeClient(webviewId);
		if (!parentClients.length) {
			console.log('Could not find parent client for request');
			if (!dispatchToOuterIframe()) {
				return notFound();
			}
		} else {
			for (const parentClient of parentClients) {
				log('same-origin load-resource', {
					id: requestId,
					scheme: requestUrlComponents.scheme,
					authority: requestUrlComponents.authority,
					path: requestUrlComponents.path,
					query: requestUrlComponents.query
				});
				parentClient.postMessage({
					channel: 'load-resource',
					id: requestId,
					scheme: requestUrlComponents.scheme,
					authority: requestUrlComponents.authority,
					path: requestUrlComponents.path,
					query: requestUrlComponents.query,
					ifNoneMatch: cached?.headers.get('ETag'),
				});
			}
		}
	} else if (client && (client.type === 'worker' || client.type === 'sharedworker')) {
		log('same-origin load-resource via message port', {
			id: requestId,
			scheme: requestUrlComponents.scheme,
			authority: requestUrlComponents.authority,
			path: requestUrlComponents.path,
			query: requestUrlComponents.query
		});
		if (!dispatchToOuterIframe()) {
			return notFound();
		}
	} else {
		log('missing client for resource request; attempting message-port fallback', {
			clientId: event.clientId,
			requestId,
			target: requestUrlComponents
		});
		if (!dispatchToOuterIframe()) {
			console.error('Could not find inner client for request');
			return notFound();
		}
	}

	return promise.then(entry => resolveResourceEntry(entry, cached));
}

/**
 * @param {FetchEvent} event
 * @param {URL} requestUrl
 * @returns {Promise<Response>}
 */
async function processLocalhostRequest(
	event,
	requestUrl
) {
	const client = await sw.clients.get(event.clientId);
	if (!client) {
		// This is expected when requesting resources on other localhost ports
		// that are not spawned by vs code
		return fetch(event.request);
	}
	const webviewId = getWebviewIdForClient(client);
	// Refs https://github.com/microsoft/vscode/issues/244143
	// With PlzDedicatedWorker, worker subresources and blob wokers
	// will use clients different from the window client.
	// Since we cannot different a worker main resource from a worker subresource
	// we will use message channel to the outer iframe provided at the time
	// of service worker controller version initialization.
	if (!webviewId && client.type !== 'worker' && client.type !== 'sharedworker') {
		console.error('Could not resolve webview id');
		return fetch(event.request);
	}

	const origin = requestUrl.origin;

	/**
	 * @param {RequestStoreResult<string|undefined>} result
	 * @returns {Promise<Response>}
	 */
	const resolveRedirect = async function (result) {
		if (result.status !== 'ok' || !result.value) {
			return fetch(event.request);
		}

		const redirectOrigin = result.value;
		const location = event.request.url.replace(new RegExp(`^${requestUrl.origin}(/|$)`), `${redirectOrigin}$1`);
		return new Response(null, {
			status: 302,
			headers: {
				Location: location
			}
		});
	};

	const { requestId, promise } = localhostRequestStore.create();
	if (webviewId) {
		const parentClients = await getOuterIframeClient(webviewId);
		if (!parentClients.length) {
			console.log('Could not find parent client for request');
			return notFound();
		}
		for (const parentClient of parentClients) {
			parentClient.postMessage({
				channel: 'load-localhost',
				origin: origin,
				id: requestId,
			});
		}
	} else if (client.type === 'worker' || client.type === 'sharedworker') {
		outerIframeMessagePort?.postMessage({
			channel: 'load-localhost',
			origin: origin,
			id: requestId,
		});
	}

	return promise.then(resolveRedirect);
}

/**
 * @param {Client} client
 * @returns {string|null}
 */
function getWebviewIdForClient(client) {
	const requesterClientUrl = new URL(client.url);
	return requesterClientUrl.searchParams.get('id');
}

/**
 * @param {string} webviewId
 * @returns {Promise<Client[]>}
 */
async function getOuterIframeClient(webviewId) {
	const allClients = await sw.clients.matchAll({ includeUncontrolled: true });
	return allClients.filter(client => {
		const clientUrl = new URL(client.url);
		const hasExpectedPathName = (clientUrl.pathname === `${rootPath}/` || clientUrl.pathname === `${rootPath}/index.html` || clientUrl.pathname === `${rootPath}/index-no-csp.html`);
		return hasExpectedPathName && clientUrl.searchParams.get('id') === webviewId;
	});
}

/**
 * @param {string} clientId
 * @returns {Promise<Client|undefined>}
 */
async function getWorkerClientForId(clientId) {
	const allDedicatedWorkerClients = await sw.clients.matchAll({ type: 'worker' });
	const allSharedWorkerClients = await sw.clients.matchAll({ type: 'sharedworker' });
	const allWorkerClients = [...allDedicatedWorkerClients, ...allSharedWorkerClients];
	return allWorkerClients.find(client => {
		return client.id === clientId;
	});
}


/**
 * @typedef {(
 *   | { readonly status: 200, id: number, path: string, mime: string, data: Uint8Array, etag: string|undefined, mtime: number|undefined }
 *   | { readonly status: 304, id: number, path: string, mime: string, mtime: number|undefined }
 *   | { readonly status: 401, id: number, path: string }
 *   | { readonly status: 404, id: number, path: string }
 * )} ResourceResponse
 */

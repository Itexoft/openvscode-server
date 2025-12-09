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

const connectionToken = searchParams.get('tkn') ?? undefined;

const remoteAuthority = searchParams.get('remoteAuthority');
const extensionIdHint = (() => {
	const raw = searchParams.get('extensionId');
	if (!raw) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed.length ? trimmed : undefined;
})();

const parseExtensionId = (value) => {
	if (!value) {
		return undefined;
	}
	try {
		const url = new URL(value, 'https://placeholder');
		const raw = url.searchParams.get('extensionId');
		if (!raw) {
			return undefined;
		}
		const trimmed = raw.trim();
		return trimmed.length ? trimmed : undefined;
	} catch {
		return undefined;
	}
};

/** @type {Map<string, string>} */
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
const resourceBaseHost = (resourceBaseAuthority ?? '').replace(/^vscode-resource\./i, '').replace(/:\d+$/, '');
const FALLBACK_RESOURCE_SCHEME = 'https';
const resourceBaseScheme = (searchParams.get('vscode-resource-base-scheme') ?? FALLBACK_RESOURCE_SCHEME).toLowerCase() || FALLBACK_RESOURCE_SCHEME;

const Schemas = {
	file: 'file',
	vscodeRemote: 'vscode-remote',
};

const extractExtensionIdFromPath = (value) => {
	if (!value) {
		return undefined;
	}
	try {
		const decoded = decodeURIComponent(value);
		const match = decoded.match(/\/extensions\/([^/]+)-\d/);
		if (match && match[1]) {
			return match[1];
		}
	} catch {
		// ignore
	}
	return undefined;
};

const parseBooleanFlag = (value) => {
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		return normalized === '1' || normalized === 'true' || normalized === 'yes';
	}
	if (typeof value === 'number') {
		return value !== 0;
	}
	if (typeof value === 'boolean') {
		return value;
	}
	return false;
};

const debugLoggingEnabled = (() => {
	const explicit = searchParams.get('openvscodeDebug');
	if (explicit !== null) {
		return parseBooleanFlag(explicit) || explicit === '';
	}
	const legacyDebug = searchParams.get('debug');
	return parseBooleanFlag(legacyDebug);
})();

const log = debugLoggingEnabled ? (...args) => {
	try {
		console.log('[WebviewSW]', ...args);
	} catch (error) {
		// ignore logging failures (e.g. console not available)
	}
} : () => {};
const warn = debugLoggingEnabled ? (...args) => {
	try {
		console.warn('[WebviewSW]', ...args);
	} catch (error) {
		// ignore logging failures
	}
} : () => {};

const shouldAttachExtensionId = (target, extensionId) => {
	if (!target || !extensionId) {
		return false;
	}
	return true;
};

const inferExtensionId = (target, explicitId) => {
	if (explicitId) {
		return explicitId;
	}
	const candidates = [];
	if (target?.path) {
		candidates.push(target.path);
	}
	if (target?.query) {
		candidates.push(target.query);
	}
	for (const candidate of candidates) {
		const inferred = extractExtensionIdFromPath(candidate);
		if (inferred) {
			return inferred;
		}
	}
	return extensionIdHint;
};

const withExtensionId = (target, extensionId) => {
	if (!target) {
		return target;
	}
	const id = inferExtensionId(target, extensionId);
	if (!id || !shouldAttachExtensionId(target, id)) {
		return target;
	}
	try {
		const params = new URLSearchParams(target.query ?? '');
		if (params.has('extensionId')) {
			return target;
		}
		params.set('extensionId', id);
		return {
			...target,
			query: params.toString(),
		};
	} catch {
		return target;
	}
};

const getExtensionIdForClientId = async (clientId) => {
	if (!clientId) {
		return extensionIdHint;
	}
	try {
		const client = await sw.clients.get(clientId) ?? await getWorkerClientForId(clientId);
		if (client?.url) {
			return parseExtensionId(client.url) ?? extensionIdHint;
		}
	} catch {
		// ignore lookup failure
	}
	return extensionIdHint;
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
	} else if (lowerHost.startsWith('vscode-remote+')) {
		scheme = Schemas.vscodeRemote;
		const encodedAuthority = rawHost.slice('vscode-remote+'.length);
		authority = decodeAuthoritySegment(encodedAuthority);
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
		const normalizedBasePath = (() => {
			if (!basePath || basePath === '/') {
				return '/';
			}
			return basePath.endsWith('/') ? basePath : `${basePath}/`;
		})();
		const baseForResolution = new URL(normalizedBasePath, 'http://placeholder');
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

const normalizeEncodedBase = (value) => {
	const decoded = decodeComponentMulti(value);
	if (/^https?:\/\/vscode-remote\+/i.test(decoded)) {
		return encodeURIComponent(decoded);
	}
	return value;
};

const sanitizeResourceSegment = (segment) => {
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

const splitEncodedBaseAndResource = (value) => {
	const input = value ?? '';
	const schemeIndex = input.indexOf('://');
	const splitIndex = schemeIndex >= 0
		? input.indexOf('/', schemeIndex + '://'.length)
		: input.indexOf('/');
	if (splitIndex === -1) {
		return { encodedBase: input, resourceSegmentRaw: '' };
	}
	return {
		encodedBase: input.slice(0, splitIndex),
		resourceSegmentRaw: input.slice(splitIndex + 1),
	};
};

const buildRemoteResourceUrl = (path, query, extensionId) => {
	const target = {
		scheme: Schemas.vscodeRemote,
		authority: remoteAuthority || sw.origin.replace(/^https?:\/\//, ''),
		path,
		query: query.replace(/^\?/, ''),
	};
	return withExtensionId(target, extensionId);
};

// Прямой, «упрощённый» путь: если видим кодированный vscode-remote+ URL без base/segment логики,
// собираем целевой URI и сразу проксируем, не проходя через pre/resource.
const tryHandleEncodedRemoteUrl = (event, requestUrl) => {
	const lastSegment = requestUrl.pathname.slice(requestUrl.pathname.lastIndexOf('/') + 1);
	const decodedSegment = decodeComponentMulti(lastSegment);
	if (!decodedSegment.includes('vscode-remote+')) {
		return false;
	}
	try {
		const targetUrl = new URL(decodedSegment);
		const extensionId =
			inferExtensionId(undefined, undefined) ??
			extractExtensionIdFromPath(targetUrl.pathname) ??
			extractExtensionIdFromPath(requestUrl.pathname);
		const target = buildRemoteResourceUrl(
			targetUrl.pathname,
			targetUrl.search || requestUrl.search,
			extensionId,
		);
		log('direct encoded remote url', { from: requestUrl.toString(), decoded: decodedSegment, target });
		event.respondWith(fetchWorkbenchResource(event, target));
		return true;
	} catch {
		return false;
	}
};

const extractFsPathFromEncodedUrl = (raw) => {
	if (!raw) {
		return undefined;
	}
	try {
		const decoded = decodeComponentMulti(raw.replace(/^https:\//, 'https://'));
		const schemeIndex = decoded.indexOf('://');
		if (schemeIndex === -1) {
			return undefined;
		}
		const pathIndex = decoded.indexOf('/', schemeIndex + '://'.length);
		if (pathIndex === -1) {
			return undefined;
		}
		return decoded.slice(pathIndex);
	} catch {
		return undefined;
	}
};

const normalizeMalformedRemoteTarget = (value) => {
	const decoded = decodeComponentMulti(value ?? '');
	const marker = '.vscode-resource.';
	const markerIndex = decoded.indexOf(marker);
	if (markerIndex !== -1) {
		const pathIndex = decoded.indexOf('/', markerIndex + marker.length);
		if (pathIndex !== -1) {
			return decoded.slice(pathIndex);
		}
	}
	const schemeIndex = decoded.indexOf('://');
	if (schemeIndex !== -1) {
		const pathIndex = decoded.indexOf('/', schemeIndex + '://'.length);
		if (pathIndex !== -1) {
			return decoded.slice(pathIndex);
		}
	}
	return decoded;
};

const normalizeResourceRemainder = (value) => {
	// В легаси путях встречается https:/vscode-remote+..., приводим к https://...
	return normalizeMalformedRemoteTarget((value ?? '').replace(/^https:\//, 'https://'));
};

const collapseNestedRemoteUrl = (value) => {
	const normalizedValue = normalizeResourceRemainder(value);
	const matches = [...normalizedValue.matchAll(/https?:\/\/vscode-remote\+[^/]+/g)];
	if (matches.length > 1) {
		const last = matches[matches.length - 1];
		if (typeof last.index === 'number') {
			return normalizedValue.slice(last.index);
		}
	}
	return normalizedValue;
};

const tryResolveAbsoluteResource = (rawSegment, requestUrl) => {
	// Сначала коллапсируем вложенные remote-ссылки, затем пытаемся интерпретировать как базу.
	const normalized = collapseNestedRemoteUrl(rawSegment);

	// Попытка распарсить как полный base href (scheme://authority/path?query).
	const baseInfo = parseEncodedBaseHref(normalized);
	if (baseInfo) {
		return {
			scheme: baseInfo.scheme,
			authority: baseInfo.authority,
			path: baseInfo.path,
			query: baseInfo.query || requestUrl.search.replace(/^\?/, ''),
		};
	}

	// Если base не распарсился, но строка похожа на файл/путь — трактуем как абсолют.
	const fsCandidate = extractFsPathFromEncodedUrl(normalized);
	if (fsCandidate || normalized.startsWith('/')) {
		return {
			scheme: Schemas.vscodeRemote,
			authority: remoteAuthority || requestUrl.host,
			path: fsCandidate || normalized,
			query: requestUrl.search.replace(/^\?/, ''),
		};
	}
	return undefined;
};

/**
 * Общий обработчик запросов resource/pre/resource.
 * @param {FetchEvent} event
 * @param {URL} requestUrl
 * @param {string} remainderRaw
 * @param {string} context
 */
const handleResourceRequest = async (event, requestUrl, remainderRaw, context) => {
	const normalizedRemainder = normalizeResourceRemainder(remainderRaw);
	const { encodedBase: rawBase, resourceSegmentRaw: rawSegment } = splitEncodedBaseAndResource(normalizedRemainder);
	const encodedBase = normalizeEncodedBase(rawBase);
	const resourceSegmentRaw = sanitizeResourceSegment(rawSegment.replace(/^\/+/, ''));

	if (isDebugResourceSegment(resourceSegmentRaw)) {
		return createLastResourceResponse();
	}

	try {
		const extensionId = await getExtensionIdForClientId(event.clientId);
		const absoluteTarget = tryResolveAbsoluteResource(resourceSegmentRaw, requestUrl);
		if (absoluteTarget) {
			const targetWithExtension = withExtensionId(
				absoluteTarget,
				inferExtensionId(undefined, extensionId) ?? extractExtensionIdFromPath(absoluteTarget.path),
			);
			log(`${context} absolute segment`, { request: requestUrl.toString(), target: targetWithExtension });
			lastResourceDebug = { request: requestUrl.toString(), target: targetWithExtension };
			return fetchWorkbenchResource(event, targetWithExtension);
		}

		const baseInfo = parseEncodedBaseHref(encodedBase);
		if (!baseInfo) {
			const fallbackPath =
				extractFsPathFromEncodedUrl(normalizedRemainder) ||
				(normalizedRemainder.startsWith('/') ? normalizedRemainder : undefined);
			if (fallbackPath) {
				const target = withExtensionId({
					scheme: Schemas.vscodeRemote,
					authority: remoteAuthority || requestUrl.host,
					path: fallbackPath,
					query: requestUrl.search.replace(/^\?/, ''),
				}, inferExtensionId(undefined, extensionId) ?? extractExtensionIdFromPath(fallbackPath));
				log(`${context} fallback`, { request: requestUrl.toString(), target });
				lastResourceDebug = { request: requestUrl.toString(), target };
				return fetchWorkbenchResource(event, target);
			}
			log(`failed to parse ${context} base href`, { encodedBase });
			return fetch(event.request);
		}

		log(`parsed ${context} base href`, { base: baseInfo, resourceSegmentRaw });

		const target = resolveNestedResource(baseInfo, resourceSegmentRaw, requestUrl.search.replace(/^\?/, ''));
		if (!target) {
			log(`failed to resolve ${context} proxy`, { encodedBase, resourceSegmentRaw });
			return fetch(event.request);
		}

		const extensionHint =
			extensionId ??
			extractExtensionIdFromPath(target.path) ??
			extractExtensionIdFromPath(baseInfo.path) ??
			extractExtensionIdFromPath(resourceSegmentRaw);

		const targetWithExtension = withExtensionId(target, extensionHint);

		log(`${context} proxy`, {
			request: requestUrl.toString(),
			base: decodeComponentMulti(encodedBase),
			resourceSegmentRaw,
			target: targetWithExtension
		});
		lastResourceDebug = { request: requestUrl.toString(), target: targetWithExtension };

		return processResourceRequest(event, targetWithExtension);
	} catch (error) {
		log(`failed to resolve ${context} proxy`, { encodedBase, error: `${error}` });
		return fetch(event.request);
	}
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

/**
 * Fetch a resource via the workbench HTTP endpoint (/vscode-remote-resource) using the resolved target.
 * This avoids any fallback routing by relying on the exact decoded path.
 * @param {FetchEvent} event
 * @param {ResourceRequestUrlComponents} target
 */
const fetchWorkbenchResource = async (event, target) => {
	if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
		return methodNotAllowed();
	}
	if (!target?.path) {
		return notFound();
	}
	try {
		const decodedPath = decodeComponentMulti(target.path);
		const pathWithQuery = decodedPath;
		const directUrl = new URL('/vscode-remote-resource', sw.origin);
		directUrl.searchParams.set('path', pathWithQuery);
		if (connectionToken) {
			directUrl.searchParams.set('tkn', connectionToken);
		}
		const init = {
			method: event.request.method,
			headers: event.request.headers,
			redirect: event.request.redirect,
			credentials: event.request.credentials ?? 'include',
			cache: event.request.cache,
			referrer: event.request.referrer,
			referrerPolicy: event.request.referrerPolicy,
			integrity: event.request.integrity,
			keepalive: event.request.keepalive,
			signal: event.request.signal,
		};
		if (event.request.mode !== 'navigate') {
			init.mode = event.request.mode;
		}
		const response = await fetch(new Request(directUrl.toString(), init));
		if (response && response.ok) {
			return response;
		}
		return notFound();
	} catch (error) {
		log('fetchWorkbenchResource failed', { error: `${error}`, target });
		return notFound();
	}
};

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
				log('Could not resolve unknown resource', response.path);
			}
			log('message:did-load-resource', { id: response.id, path: response.path, status: response.status });
			return;
		}
		case 'did-load-localhost': {
			const data = event.data.data;
			if (!localhostRequestStore.resolve(data.id, data.location)) {
				log('Could not resolve unknown localhost', data.origin);
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
			log('Unknown message');
			return;
		}
	}
});

sw.addEventListener('fetch', (event) => {
	const requestUrl = new URL(event.request.url);
	log('fetch event', { url: requestUrl.toString() });

	// Упрощённый маршрут: если путь уже содержит кодированный vscode-remote+ URL, разбираем напрямую.
	if (tryHandleEncodedRemoteUrl(event, requestUrl)) {
		return;
	}

	// Rewrite loopback vscode-remote+ hosts (127.0.0.1/localhost/0.0.0.0) to resourceBaseHost.
	try {
		const hostMatch = requestUrl.hostname.match(/^(vscode-remote\+[^.]+\.vscode-resource\.)(127\.0\.0\.1|localhost|0\.0\.0\.0)$/i);
		if (hostMatch && resourceBaseHost) {
			const rewritten = new URL(requestUrl.toString());
			rewritten.hostname = `${hostMatch[1]}${resourceBaseHost}`;
			rewritten.port = '';
			rewritten.protocol = `${resourceBaseScheme}:`;
			log('rewrite loopback vscode-resource host', {
				original: requestUrl.toString(),
				rewritten: rewritten.toString(),
			});
			const newRequest = new Request(rewritten.toString(), event.request);
			return event.respondWith(fetch(newRequest));
		}
	} catch (error) {
		log('failed loopback rewrite check', { error: `${error}` });
	}

	if (requestUrl.origin === sw.origin && requestUrl.pathname === `${rootPath}/__debug__/last-resource`) {
		return respondWithLastResource(event);
	}

	// Legacy malformed resource paths that were previously routed via node_modules/vscode-regexpp/.
	const regexppResourceMatch = (() => {
		if (requestUrl.origin !== sw.origin) {
			return undefined;
		}
		return requestUrl.pathname.match(/^\/static\/node_modules\/vscode-regexpp\/(.+)/);
	})();
	if (regexppResourceMatch && (event.request.method === 'GET' || event.request.method === 'HEAD')) {
		return event.respondWith(handleResourceRequest(event, requestUrl, regexppResourceMatch[1], 'regexpp resource'));
	}

	// Ensure static assets (including oss- prefixed) carry the connection token for auth.
	if (
		(requestUrl.origin === sw.origin) &&
		(event.request.method === 'GET' || event.request.method === 'HEAD')
	) {
		const staticMatch = requestUrl.pathname.match(/^\/?(?:oss-[^/]+\/)?static\//);
		if (staticMatch && connectionToken && !requestUrl.searchParams.has('tkn')) {
			return event.respondWith((async () => {
				const rewritten = new URL(requestUrl.toString());
				rewritten.searchParams.set('tkn', connectionToken);
				log('rewrite static asset with token', { from: requestUrl.toString(), to: rewritten.toString() });
				const init = {
					method: event.request.method,
					headers: event.request.headers,
					redirect: event.request.redirect,
					credentials: event.request.credentials,
					cache: event.request.cache,
					referrer: event.request.referrer,
					referrerPolicy: event.request.referrerPolicy,
					integrity: event.request.integrity,
					keepalive: event.request.keepalive,
					signal: event.request.signal,
				};
				if (event.request.mode !== 'navigate') {
					init.mode = event.request.mode;
				}
				try {
					return fetch(new Request(rewritten.toString(), init));
				} catch (error) {
					log('failed to clone request for static rewrite', { error: `${error}` });
					return fetch(rewritten.toString(), { method: event.request.method, credentials: event.request.credentials });
				}
			})());
		}
	}

	// Rewrite same-origin absolute paths (e.g. "/default-dark.css") to pre/resource so the server can resolve by extensionId.
	if (
		(requestUrl.origin === sw.origin) &&
		!requestUrl.pathname.startsWith(rootPath) &&
		(event.request.method === 'GET' || event.request.method === 'HEAD')
	) {
		return event.respondWith((async () => {
			const extensionId = inferExtensionId(undefined, await getExtensionIdForClientId(event.clientId)) ?? extractExtensionIdFromPath(requestUrl.pathname);
			const target = withExtensionId({
				scheme: Schemas.vscodeRemote,
				authority: remoteAuthority || requestUrl.host,
				path: requestUrl.pathname,
				query: requestUrl.search.replace(/^\?/, ''),
			}, extensionId);
			log('absolute resource via direct fetch', { from: requestUrl.toString(), target });
			return fetchWorkbenchResource(event, target);
		})());
	}

	const resourceLikePrefix = `${rootPath}/`;
	if (
		requestUrl.origin === sw.origin &&
		requestUrl.pathname.startsWith(resourceLikePrefix) &&
		!requestUrl.pathname.startsWith(`${resourceLikePrefix}resource/`)
	) {
		const remainderRaw = requestUrl.pathname.slice(resourceLikePrefix.length);
		const normalizedRemainder = normalizeResourceRemainder(remainderRaw);
		if (normalizedRemainder.startsWith('service-worker.js') || normalizedRemainder.startsWith('__debug__')) {
			return;
		}
		const decodedHead = decodeComponentMulti(splitEncodedBaseAndResource(normalizedRemainder).encodedBase);
		if (!decodedHead.includes(':') && !decodedHead.startsWith('vscode-remote+')) {
			// Let the browser handle it normally
			return;
		}
		return event.respondWith(handleResourceRequest(event, requestUrl, remainderRaw, 'implicit resource'));
	}

	const sameOriginResourcePrefix = `${rootPath}/resource/`;
	if (requestUrl.origin === sw.origin && requestUrl.pathname.startsWith(sameOriginResourcePrefix)) {
		log('resource fetch candidate', { pathname: requestUrl.pathname });
		return event.respondWith(handleResourceRequest(event, requestUrl, requestUrl.pathname.slice(sameOriginResourcePrefix.length), 'resource'));
	}
	if (typeof resourceBaseAuthority === 'string' && resourceBaseAuthority.length > 0 && requestUrl.protocol === `${resourceBaseScheme}:` && requestUrl.hostname.endsWith('.' + resourceBaseAuthority)) {
		switch (event.request.method) {
			case 'GET':
			case 'HEAD': {
				return event.respondWith((async () => {
					const firstHostSegment = requestUrl.hostname.slice(0, requestUrl.hostname.length - (resourceBaseAuthority.length + 1));
					const scheme = firstHostSegment.split('+', 1)[0];
					const encodedAuthority = firstHostSegment.slice(scheme.length + 1); // may be empty
					const authority = encodedAuthority.length ? decodeAuthoritySegment(encodedAuthority) : '';
					const extensionId = inferExtensionId(undefined, await getExtensionIdForClientId(event.clientId)) ?? extractExtensionIdFromPath(requestUrl.pathname);
					return processResourceRequest(event, withExtensionId({
						scheme,
						authority,
						path: requestUrl.pathname,
						query: requestUrl.search.replace(/^\?/, ''),
					}, extensionId));
				})());
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
				return event.respondWith((async () => {
					const extensionId = inferExtensionId(undefined, await getExtensionIdForClientId(event.clientId)) ?? extractExtensionIdFromPath(requestUrl.pathname);
					return processResourceRequest(event, withExtensionId({
						path: requestUrl.pathname,
						scheme: requestUrl.protocol.slice(0, requestUrl.protocol.length - 1),
						authority: requestUrl.host,
						query: requestUrl.search.replace(/^\?/, ''),
					}, extensionId));
				})());
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
	const extensionIdForRequest = await getExtensionIdForClientId(event.clientId);
	requestUrlComponents = withExtensionId(requestUrlComponents, extensionIdForRequest);

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
	if (!webviewId && (!client || (client.type !== 'worker' && client.type !== 'sharedworker'))) {
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

	/**
	 * Attempt to fetch the requested resource directly from the workbench HTTP endpoint.
	 * This is used as a fallback when we cannot reach the outer iframe (e.g. no parent client found).
	 */
	const tryFetchDirectResource = () => {
		if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
			return undefined;
		}
		if (!requestUrlComponents.path || requestUrlComponents.path === '/') {
			return undefined;
		}
		if (requestUrlComponents.scheme !== 'vscode-remote' && requestUrlComponents.scheme !== 'file') {
			return undefined;
		}
		try {
			const directUrl = new URL('/vscode-remote-resource', sw.origin);
			directUrl.searchParams.set('path', requestUrlComponents.path);
			if (connectionToken) {
				directUrl.searchParams.set('tkn', connectionToken);
			}
			const directRequest = new Request(directUrl.toString(), {
				method: event.request.method,
				headers: event.request.headers,
				credentials: event.request.credentials ?? 'include',
			});
			return fetch(directRequest);
		} catch (error) {
			log('failed to build direct fetch request', { error: `${error}` });
			return undefined;
		}
	};

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

	const attemptDirectResponse = () => {
		const directResponse = tryFetchDirectResource();
		if (!directResponse) {
			return undefined;
		}
		return directResponse.then(response => {
			if (response && response.ok) {
				return response;
			}
			return undefined;
		}).catch(() => undefined);
	};

	const directCandidate = attemptDirectResponse();
	if (directCandidate) {
		return event.respondWith(directCandidate.then(response => {
			if (response) {
				return response;
			}
			// fall through to message dispatch
			return promise.then(entry => resolveResourceEntry(entry, cached));
		}));
	}

	if (webviewId && client) {
		const parentClients = await getOuterIframeClient(webviewId);
		if (!parentClients.length) {
			log('could not find parent client for request', { webviewId });
			if (!dispatchToOuterIframe()) {
				const directResponse = tryFetchDirectResource();
				if (directResponse) {
					return event.respondWith(directResponse.then(response => {
						if (!response || response.status === 404) {
							return notFound();
						}
						return response;
					}).catch(() => notFound()));
				}
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
			const directResponse = tryFetchDirectResource();
			if (directResponse) {
				return event.respondWith(directResponse.then(response => {
					if (!response || response.status === 404) {
						return notFound();
					}
					return response;
				}).catch(() => notFound()));
			}
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
	if (!webviewId && (!client || (client.type !== 'worker' && client.type !== 'sharedworker'))) {
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
			log('Could not find parent client for request');
			return notFound();
		}
		for (const parentClient of parentClients) {
			parentClient.postMessage({
				channel: 'load-localhost',
				origin: origin,
				id: requestId,
			});
		}
	} else if (client && (client.type === 'worker' || client.type === 'sharedworker')) {
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

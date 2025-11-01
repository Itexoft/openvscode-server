/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream, promises } from 'fs';
import { Buffer } from 'buffer';
import * as http from 'http';
import * as url from 'url';
import * as cookie from 'cookie';
import * as crypto from 'crypto';
import { isEqualOrParent } from '../../base/common/extpath.js';
import { getMediaMime } from '../../base/common/mime.js';
import { isLinux } from '../../base/common/platform.js';
import { ILogService, LogLevel } from '../../platform/log/common/log.js';
import { IServerEnvironmentService } from './serverEnvironmentService.js';
import { extname, dirname, join, normalize, posix, resolve } from '../../base/common/path.js';
import { FileAccess, connectionTokenCookieName, connectionTokenQueryName, Schemas, builtinExtensionsPath } from '../../base/common/network.js';
import { generateUuid } from '../../base/common/uuid.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { ServerConnectionToken, ServerConnectionTokenType } from './serverConnectionToken.js';
import { asTextOrError, IRequestService } from '../../platform/request/common/request.js';
import { IHeaders } from '../../base/parts/request/common/request.js';
import { CancellationToken } from '../../base/common/cancellation.js';
import { URI } from '../../base/common/uri.js';
import { streamToBuffer } from '../../base/common/buffer.js';
import { IProductConfiguration } from '../../base/common/product.js';
import { isString, Mutable } from '../../base/common/types.js';
import { CharCode } from '../../base/common/charCode.js';
import { IExtensionManifest } from '../../platform/extensions/common/extensions.js';
import { ICSSDevelopmentService } from '../../platform/cssDev/node/cssDevService.js';

const textMimeType: { [ext: string]: string | undefined } = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
};

/**
 * Return an error to the client.
 */
export async function serveError(req: http.IncomingMessage, res: http.ServerResponse, errorCode: number, errorMessage: string): Promise<void> {
	res.writeHead(errorCode, { 'Content-Type': 'text/plain' });
	if (req.method === 'HEAD') {
		res.end();
	} else {
		res.end(errorMessage);
	}
}

export const enum CacheControl {
	NO_CACHING, ETAG, NO_EXPIRY
}

/**
 * Serve a file at a given path or 404 if the file is missing.
 */
export async function serveFile(filePath: string, cacheControl: CacheControl, logService: ILogService, req: http.IncomingMessage, res: http.ServerResponse, responseHeaders: Record<string, string>): Promise<void> {
	try {
		const stat = await promises.stat(filePath); // throws an error if file doesn't exist
		if (cacheControl === CacheControl.ETAG) {

			// Check if file modified since
			const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
			if (req.headers['if-none-match'] === etag) {
				res.writeHead(304);
				return void res.end();
			}

			responseHeaders['Etag'] = etag;
		} else if (cacheControl === CacheControl.NO_EXPIRY) {
			responseHeaders['Cache-Control'] = 'public, max-age=31536000';
		} else if (cacheControl === CacheControl.NO_CACHING) {
			responseHeaders['Cache-Control'] = 'no-store';
		}

		responseHeaders['Content-Type'] = textMimeType[extname(filePath)] || getMediaMime(filePath) || 'text/plain';

		res.writeHead(200, responseHeaders);

		if (req.method === 'HEAD') {
			res.end();
		} else {
			// Data
			createReadStream(filePath).pipe(res);
		}
	} catch (error) {
		if (error.code !== 'ENOENT') {
			logService.error(error);
			console.error(error.toString());
		} else {
			console.error(`File not found: ${filePath}`);
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		if (req.method === 'HEAD') {
			return void res.end();
		}

		return void res.end('Not found');
	}
}

const APP_ROOT = dirname(FileAccess.asFileUri('').fsPath);

const STATIC_PATH = `/static`;
const CALLBACK_PATH = `/callback`;
const WEB_EXTENSION_PATH = `/web-extension-resource`;

export class WebClientServer {

	private readonly _webExtensionResourceUrlTemplate: URI | undefined;
	private _webviewServiceWorkerVersionPromise: Promise<string> | undefined;
	private _webviewServiceWorkerInfoPromise: Promise<{ version: string; sourceText: string }> | undefined;
	private _webviewPreIndexCache: { mtimeMs: number; etag: string; content: string } | undefined;

	constructor(
		private readonly _connectionToken: ServerConnectionToken,
		private readonly _basePath: string,
		private readonly _productPath: string,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
		@IProductService private readonly _productService: IProductService,
		@ICSSDevelopmentService private readonly _cssDevService: ICSSDevelopmentService
	) {
		this._webExtensionResourceUrlTemplate = this._productService.extensionsGallery?.resourceUrlTemplate ? URI.parse(this._productService.extensionsGallery.resourceUrlTemplate) : undefined;
	}

	/**
	 * Handle web resources (i.e. only needed by the web client).
	 * **NOTE**: This method is only invoked when the server has web bits.
	 * **NOTE**: This method is only invoked after the connection token has been validated.
	 * @param parsedUrl The URL to handle, including base and product path
	 * @param pathname The pathname of the URL, without base and product path
	 */
	async handle(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery, pathname: string): Promise<void> {
		console.log(`[WebClientServer] handle ${req.method} ${pathname} origin=${req.headers.origin ?? ''}`);
		try {
			const ossMatch = /^\/oss-[0-9a-f]+(\/.*)$/.exec(pathname);
			if (ossMatch && ossMatch[1]) {
				const ossPath = ossMatch[1];
				if (ossPath.startsWith(STATIC_PATH) && ossPath.charCodeAt(STATIC_PATH.length) === CharCode.Slash) {
					return this._handleStatic(req, res, ossPath.substring(STATIC_PATH.length));
				}
				if (ossPath === '/') {
					return this._handleRoot(req, res, parsedUrl);
				}
				if (ossPath === CALLBACK_PATH) {
					return this._handleCallback(res);
				}
				if (ossPath.startsWith(WEB_EXTENSION_PATH) && ossPath.charCodeAt(WEB_EXTENSION_PATH.length) === CharCode.Slash) {
					return this._handleWebExtensionResource(req, res, ossPath.substring(WEB_EXTENSION_PATH.length));
				}
			}

			if (pathname.startsWith(STATIC_PATH) && pathname.charCodeAt(STATIC_PATH.length) === CharCode.Slash) {
				return this._handleStatic(req, res, pathname.substring(STATIC_PATH.length));
			}
			if (pathname === '/') {
				return this._handleRoot(req, res, parsedUrl);
			}
			if (pathname === CALLBACK_PATH) {
				// callback support
				return this._handleCallback(res);
			}
			if (pathname.startsWith(WEB_EXTENSION_PATH) && pathname.charCodeAt(WEB_EXTENSION_PATH.length) === CharCode.Slash) {
				// extension resource support
				return this._handleWebExtensionResource(req, res, pathname.substring(WEB_EXTENSION_PATH.length));
			}

			return serveError(req, res, 404, 'Not found.');
		} catch (error) {
			this._logService.error(error);
			console.error(error.toString());

			return serveError(req, res, 500, 'Internal Server Error.');
		}
	}
	/**
	 * Handle HTTP requests for /static/*
	 * @param resourcePath The path after /static/
	 */
	private async _handleStatic(req: http.IncomingMessage, res: http.ServerResponse, resourcePath: string): Promise<void> {
		const headers: Record<string, string> = Object.create(null);

		// Strip the this._staticRoute from the path
		let normalizedPathname = decodeURIComponent(resourcePath).replace(/^\/+/, ''); // support paths that are uri-encoded (e.g. spaces => %20)

		// Allow requests routed through /oss-<commit>/static/... to fall back to /static/...
		if (normalizedPathname.startsWith('oss-')) {
			const firstSlash = normalizedPathname.indexOf('/');
			if (firstSlash !== -1) {
				normalizedPathname = normalizedPathname.slice(firstSlash + 1);
				if (normalizedPathname.startsWith('static/')) {
					normalizedPathname = normalizedPathname.slice('static/'.length);
				}
			}
		}

		const filePath = join(APP_ROOT, normalizedPathname); // join also normalizes the path
		const normalizedFilePath = normalize(filePath);
		if (!isEqualOrParent(normalizedFilePath, APP_ROOT, !isLinux)) {
			return serveError(req, res, 400, `Bad request.`);
		}

		const requestOriginHeader = req.headers.origin;
		const allowRequestOrigin = typeof requestOriginHeader === 'string' && isAllowedStaticCdnOrigin(requestOriginHeader, this._logService);
		if (allowRequestOrigin) {
			headers['Access-Control-Allow-Origin'] = requestOriginHeader;
			headers['Vary'] = headers['Vary'] ? `${headers['Vary']}, Origin` : 'Origin';
			console.log(`[WebClientServer] Serving static ${req.method} ${req.url} with CORS origin ${requestOriginHeader}`);
		}

		if (req.method?.toUpperCase() === 'OPTIONS') {
			if (!allowRequestOrigin) {
				res.writeHead(403);
				return void res.end();
			}
			const preflightHeaders: Record<string, string> = Object.create(null);
			preflightHeaders['Access-Control-Allow-Origin'] = requestOriginHeader!;
			preflightHeaders['Access-Control-Allow-Private-Network'] = 'true';
			preflightHeaders['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
			preflightHeaders['Vary'] = 'Origin';
			const requestedHeaders = req.headers['access-control-request-headers'];
			if (typeof requestedHeaders === 'string' && requestedHeaders.length > 0) {
				preflightHeaders['Access-Control-Allow-Headers'] = requestedHeaders;
			} else if (Array.isArray(requestedHeaders) && requestedHeaders.length) {
				preflightHeaders['Access-Control-Allow-Headers'] = requestedHeaders.join(', ');
			}
			res.writeHead(204, preflightHeaders);
			return void res.end();
		}

		if (normalizedPathname === 'out/vs/workbench/contrib/webview/browser/pre/index.html') {
			return this._serveWebviewPreIndex(normalizedFilePath, this._environmentService.isBuilt ? CacheControl.NO_EXPIRY : CacheControl.ETAG, req, res, headers);
		}

		return serveFile(normalizedFilePath, this._environmentService.isBuilt ? CacheControl.NO_EXPIRY : CacheControl.ETAG, this._logService, req, res, headers);
	}

	private async _serveWebviewPreIndex(filePath: string, cacheControl: CacheControl, req: http.IncomingMessage, res: http.ServerResponse, headers: Record<string, string>): Promise<void> {
		let stat;
		try {
			stat = await promises.stat(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return serveError(req, res, 404, 'Not found.');
			}
			this._logService.error(`[WebClientServer] Failed to stat webview index: ${error instanceof Error ? error.message : String(error)}`);
			return serveError(req, res, 500, 'Internal Server Error.');
		}

		const entry = await this._getWebviewPreIndexContent(filePath, stat.mtimeMs);
		const ifNoneMatchHeader = req.headers['if-none-match'];
		const ifNoneMatch = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader[0] : ifNoneMatchHeader;
		if (typeof ifNoneMatch === 'string' && ifNoneMatch === entry.etag) {
			res.writeHead(304);
			return void res.end();
		}

		if (cacheControl === CacheControl.NO_EXPIRY) {
			headers['Cache-Control'] = 'public, max-age=31536000';
		} else if (cacheControl === CacheControl.NO_CACHING) {
			headers['Cache-Control'] = 'no-store';
		}

		headers['Content-Type'] = 'text/html';
		headers['Etag'] = entry.etag;

		res.writeHead(200, headers);
		if (req.method === 'HEAD') {
			return void res.end();
		}

		return void res.end(entry.content);
	}

	private async _getWebviewPreIndexContent(filePath: string, mtimeMs: number): Promise<{ content: string; etag: string; mtimeMs: number }> {
		const cached = this._webviewPreIndexCache;
		if (cached && cached.mtimeMs === mtimeMs) {
			return cached;
		}

		let raw: string;
		try {
			raw = (await promises.readFile(filePath)).toString();
		} catch (error) {
			this._logService.error(`[WebClientServer] Failed to read webview index: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}

		let serviceWorkerInfo: { version: string; sourceText: string } | undefined;
		try {
			serviceWorkerInfo = await this._getWebviewServiceWorkerInfo();
		} catch (error) {
			this._logService.error(`[WebClientServer] Failed to load webview service worker source: ${error instanceof Error ? error.message : String(error)}`);
		}

		const rewritten = this._rewriteWebviewPreIndexCsp(raw, serviceWorkerInfo);
		const etag = `W/"${crypto.createHash('sha256').update(rewritten).digest('hex')}"`;

		const entry = { content: rewritten, etag, mtimeMs };
		this._webviewPreIndexCache = entry;
		return entry;
	}

	private _rewriteWebviewPreIndexCsp(html: string, info?: { version: string; sourceText: string }): string {
		const metaRegex = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)("[^>]*>)/i;
		const match = metaRegex.exec(html);
		if (!match) {
			return html;
		}

		const originalCsp = match[2];
		const directives = originalCsp.split(';').map(d => d.trim()).filter(d => d.length > 0);
		const scriptIndex = directives.findIndex(d => d.startsWith('script-src'));
		if (scriptIndex === -1) {
			return html;
		}

		const scriptDirective = directives[scriptIndex];
		const tokens = scriptDirective.split(/\s+/);
		const directiveName = tokens.shift();
		if (!directiveName) {
			return html;
		}

		const preserved = tokens.filter(token => !/^'sha256-[^']*'$/.test(token));
		if (!preserved.includes("'self'")) {
			preserved.unshift("'self'");
		}
		if (!preserved.includes("'unsafe-inline'")) {
			preserved.push("'unsafe-inline'");
		}
		const deduped = Array.from(new Set(preserved));

		directives[scriptIndex] = [directiveName, ...deduped].join(' ');
		const trailingSemicolon = /\s*;\s*$/.test(originalCsp) ? ';' : '';
		const updatedCsp = `${directives.join('; ')}${trailingSemicolon}`;

		let rewritten = html.replace(metaRegex, `$1${updatedCsp}$3`);
		const sourceReplacement = info?.sourceText ? JSON.stringify(Buffer.from(info.sourceText, 'utf-8').toString('base64')) : 'null';
		const versionReplacement = info?.version ? JSON.stringify(info.version) : 'undefined';
		rewritten = rewritten.replace('/*__SERVICE_WORKER_SOURCE__*/ null', sourceReplacement);
		rewritten = rewritten.replace('/*__SERVICE_WORKER_VERSION__*/ undefined', versionReplacement);
		return rewritten;
	}

	private _getResourceURLTemplateAuthority(uri: URI): string | undefined {
		const index = uri.authority.indexOf('.');
		return index !== -1 ? uri.authority.substring(index + 1) : undefined;
	}

	/**
	 * Handle extension resources
	 * @param resourcePath The path after /web-extension-resource/
	 */
	private async _handleWebExtensionResource(req: http.IncomingMessage, res: http.ServerResponse, resourcePath: string): Promise<void> {
		if (!this._webExtensionResourceUrlTemplate) {
			return serveError(req, res, 500, 'No extension gallery service configured.');
		}

		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)
		const path = normalize(normalizedPathname);
		const uri = URI.parse(path).with({
			scheme: this._webExtensionResourceUrlTemplate.scheme,
			authority: path.substring(0, path.indexOf('/')),
			path: path.substring(path.indexOf('/') + 1)
		});

		if (this._getResourceURLTemplateAuthority(this._webExtensionResourceUrlTemplate) !== this._getResourceURLTemplateAuthority(uri)) {
			return serveError(req, res, 403, 'Request Forbidden');
		}

		const headers: IHeaders = {};
		const setRequestHeader = (header: string) => {
			const value = req.headers[header];
			if (value && (isString(value) || value[0])) {
				headers[header] = isString(value) ? value : value[0];
			} else if (header !== header.toLowerCase()) {
				setRequestHeader(header.toLowerCase());
			}
		};
		setRequestHeader('X-Client-Name');
		setRequestHeader('X-Client-Version');
		setRequestHeader('X-Machine-Id');
		setRequestHeader('X-Client-Commit');

		const context = await this._requestService.request({
			type: 'GET',
			url: uri.toString(true),
			headers
		}, CancellationToken.None);

		const status = context.res.statusCode || 500;
		if (status !== 200) {
			let text: string | null = null;
			try {
				text = await asTextOrError(context);
			} catch (error) {/* Ignore */ }
			return serveError(req, res, status, text || `Request failed with status ${status}`);
		}

		const responseHeaders: Record<string, string | string[]> = Object.create(null);
		const setResponseHeader = (header: string) => {
			const value = context.res.headers[header];
			if (value) {
				responseHeaders[header] = value;
			} else if (header !== header.toLowerCase()) {
				setResponseHeader(header.toLowerCase());
			}
		};
		setResponseHeader('Cache-Control');
		setResponseHeader('Content-Type');
		res.writeHead(200, responseHeaders);
		const buffer = await streamToBuffer(context.stream);
		return void res.end(buffer.buffer);
	}

	/**
	 * Handle HTTP requests for /
	 */
	private async _handleRoot(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {

		const getFirstHeader = (headerName: string) => {
			const val = req.headers[headerName];
			const candidate = Array.isArray(val) ? val[0] : val;
			if (!candidate) {
				return undefined;
			}
			const [first] = candidate.split(',');
			const trimmed = first?.trim();
			return trimmed || undefined;
		};

		const splitAuthority = (authority: string): { host: string; port: string | undefined } => {
			if (authority.startsWith('[')) {
				const closing = authority.indexOf(']');
				if (closing !== -1) {
					const host = authority.slice(0, closing + 1);
					const rest = authority.slice(closing + 1);
					if (rest.startsWith(':')) {
						return { host, port: rest.slice(1) };
					}
					return { host, port: undefined };
				}
			}

			const lastColon = authority.lastIndexOf(':');
			if (lastColon > -1 && authority.indexOf(':') === lastColon) {
				return {
					host: authority.slice(0, lastColon),
					port: authority.slice(lastColon + 1),
				};
			}

			return { host: authority, port: undefined };
		};

		const parseForwardedHeader = (raw: string | undefined) => {
			if (!raw) {
				return {};
			}
			const [firstEntry] = raw.split(',');
			if (!firstEntry) {
				return {};
			}

			const result: { proto?: string; host?: string; port?: string } = {};
			for (const segment of firstEntry.split(';')) {
				const [rawKey, rawValue] = segment.split('=');
				if (!rawKey || !rawValue) {
					continue;
				}
				const key = rawKey.trim().toLowerCase();
				let value = rawValue.trim();
				if (value.startsWith('"') && value.endsWith('"')) {
					value = value.slice(1, -1);
				}
				if (!value) {
					continue;
				}
				if (key === 'proto') {
					result.proto = value.toLowerCase();
				} else if (key === 'host') {
					result.host = value;
				} else if (key === 'port') {
					result.port = value;
				}
			}
			return result;
		};

		const forwardedFromForwardedHeader = parseForwardedHeader(getFirstHeader('forwarded'));
		const forwardedProtoHeader = forwardedFromForwardedHeader.proto ?? getFirstHeader('x-forwarded-proto');
		const forwardedHostHeaderRaw = forwardedFromForwardedHeader.host ?? getFirstHeader('x-forwarded-host');
		const forwardedHostParts = forwardedHostHeaderRaw ? splitAuthority(forwardedHostHeaderRaw) : undefined;
		const forwardedHost = forwardedHostParts?.host?.trim();
		const forwardedPortHeader = forwardedFromForwardedHeader.port ?? getFirstHeader('x-forwarded-port') ?? forwardedHostParts?.port;

		const normalizeAuthority = (authority: string | undefined) => {
			if (!authority) {
				return undefined;
			}
			return authority.trim();
		};

		const isPrivateAuthority = (authority: string | undefined) => {
			if (!authority) {
				return true;
			}
			const bracketStripped = authority.startsWith('[') && authority.endsWith(']')
				? authority.slice(1, -1)
				: authority;
			const host = bracketStripped.split(':')[0]?.toLowerCase();
			if (!host) {
				return true;
			}
			if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
				return true;
			}
			if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) {
				return true;
			}
			if (/^fc[0-9a-f]{2}/.test(host) || /^fd[0-9a-f]{2}/.test(host)) {
				return true;
			}
			return false;
		};

		const getProtocol = () => {
			const forwardedProto = forwardedProtoHeader?.split(',')[0]?.trim().toLowerCase();
			if (forwardedProto === 'https') {
				return 'https';
			}
			if (forwardedProto === 'http') {
				return 'http';
			}

			const forwardedPort = forwardedPortHeader?.split(',')[0]?.trim();
			if (forwardedPort === '443') {
				return 'https';
			}
			if (forwardedPort === '80') {
				return 'http';
			}

			// Node's IncomingMessage doesn't guarantee socket to be TLSSocket, so we use type assertion.
			const socket: any = req.socket;
			return socket?.encrypted ? 'https' : 'http';
		};

		// Prefix routes with basePath for clients
		const basePath = getFirstHeader('x-forwarded-prefix') || this._basePath;

		const queryConnectionToken = parsedUrl.query[connectionTokenQueryName];
		if (typeof queryConnectionToken === 'string') {
			// We got a connection token as a query parameter.
			// We want to have a clean URL, so we strip it
			const responseHeaders: Record<string, string> = Object.create(null);
			responseHeaders['Set-Cookie'] = cookie.serialize(
				connectionTokenCookieName,
				queryConnectionToken,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			);

			const newQuery = Object.create(null);
			for (const key in parsedUrl.query) {
				if (key !== connectionTokenQueryName) {
					newQuery[key] = parsedUrl.query[key];
				}
			}
			const newLocation = url.format({ pathname: basePath, query: newQuery });
			responseHeaders['Location'] = newLocation;

			res.writeHead(302, responseHeaders);
			return void res.end();
		}

		const protocol = getProtocol();
		const formatAuthority = (host: string, port: string | undefined) => {
			if (!port || !port.trim()) {
				return host;
			}
			return `${host}:${port.trim()}`;
		};

		const shouldOmitPortForProtocol = (port: string | undefined, scheme: string) => {
			if (!port) {
				return true;
			}

			const trimmed = port.trim();
			if (!trimmed) {
				return true;
			}

			if (scheme === 'https' && trimmed === '443') {
				return true;
			}
			if (scheme === 'http' && trimmed === '80') {
				return true;
			}

			return false;
		};

		const replacePort = (authority: string, port: string | undefined, scheme: string) => {
			const { host } = splitAuthority(authority);
			if (shouldOmitPortForProtocol(port, scheme)) {
				return host;
			}
			return formatAuthority(host, port);
		};

		const normalizeDefaultPort = (authority: string | undefined, scheme: string) => {
			if (!authority) {
				return authority;
			}
			const { host, port } = splitAuthority(authority);
			if (shouldOmitPortForProtocol(port, scheme)) {
				return host;
			}
			return formatAuthority(host, port);
		};

		const useTestResolver = (!this._environmentService.isBuilt && this._environmentService.args['use-test-resolver']);
		const proxyHostOverride = this._environmentService.args['proxy-host'];
		const proxyPortOverride = this._environmentService.args['proxy-port'];
		let remoteAuthority: string | undefined;
		if (useTestResolver) {
				remoteAuthority = 'test+test';
			} else if (proxyHostOverride) {
				remoteAuthority = proxyPortOverride ? `${proxyHostOverride}:${proxyPortOverride}` : proxyHostOverride;
			} else {
				const candidates: (string | undefined)[] = [
					forwardedHost,
					getFirstHeader('x-original-host'),
					getFirstHeader('x-forwarded-host'),
					normalizeAuthority(req.headers.host)
				];
				remoteAuthority = candidates.find(candidate => !!candidate && !isPrivateAuthority(candidate)) ?? candidates.find(candidate => !!candidate);
			}
		if (!remoteAuthority) {
				return serveError(req, res, 400, `Bad request.`);
			}
		if (!proxyHostOverride && remoteAuthority) {
				const forwardedPort = forwardedPortHeader?.split(',')[0]?.trim();
				if (forwardedPort) {
					remoteAuthority = replacePort(remoteAuthority, forwardedPort, protocol);
				}
			}

		remoteAuthority = normalizeDefaultPort(remoteAuthority, protocol);

		function asJSON(value: unknown): string {
				return JSON.stringify(value).replace(/"/g, '&quot;');
			}

		let _wrapWebWorkerExtHostInIframe: undefined | false = undefined;
		if (this._environmentService.args['enable-smoke-test-driver']) {
			// integration tests run at a time when the built output is not yet published to the CDN
			// so we must disable the iframe wrapping because the iframe URL will give a 404
			_wrapWebWorkerExtHostInIframe = false;
		}

		if (this._logService.getLevel() === LogLevel.Trace) {
				['x-original-host', 'x-forwarded-host', 'x-forwarded-port', 'host'].forEach(header => {
					const value = getFirstHeader(header);
					if (value) {
						this._logService.trace(`[WebClientServer] ${header}: ${value}`);
					}
				});
				if (proxyHostOverride) {
					this._logService.trace(`[WebClientServer] proxy-host override in effect: ${remoteAuthority}`);
				}
				this._logService.trace(`[WebClientServer] Request URL: ${req.url}, basePath: ${basePath}, remoteAuthority: ${remoteAuthority}`);
			}

		const staticRoute = posix.join(basePath, this._productPath, STATIC_PATH);
		const callbackRoute = posix.join(basePath, this._productPath, CALLBACK_PATH);
		// const webExtensionRoute = posix.join(basePath, this._productPath, WEB_EXTENSION_PATH);

		const resolveWorkspaceURI = (defaultLocation?: string) => defaultLocation && URI.file(resolve(defaultLocation)).with({ scheme: Schemas.vscodeRemote, authority: remoteAuthority });

		const filePath = FileAccess.asFileUri(`vs/code/browser/workbench/workbench${this._environmentService.isBuilt ? '' : '-dev'}.html`).fsPath;
		const authSessionInfo = !this._environmentService.isBuilt && this._environmentService.args['github-auth'] ? {
			id: generateUuid(),
			providerId: 'github',
			accessToken: this._environmentService.args['github-auth'],
			scopes: [['user:email'], ['repo']]
		} : undefined;

		const webviewEndpoint = `${protocol}://${remoteAuthority}${staticRoute}/out/vs/workbench/contrib/webview/browser/pre/`;

		const webviewServiceWorkerVersion = await this._resolveWebviewServiceWorkerVersion();

		const productConfiguration: Partial<Mutable<IProductConfiguration>> = {
			webviewContentExternalBaseUrlTemplate: webviewEndpoint,
			webviewServiceWorkerVersion
		};

		const proposedApi = this._environmentService.args['enable-proposed-api'];
		if (proposedApi?.length) {
			const normalizedProposedApi = proposedApi
				.map(value => typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value))
				.filter(value => value && value !== '*');
			if (normalizedProposedApi.length) {
				productConfiguration.extensionsEnabledWithApiProposalVersion ??= [];
				productConfiguration.extensionsEnabledWithApiProposalVersion.push(...normalizedProposedApi);
			}
		}

		if (!this._environmentService.isBuilt) {
			try {
				const productOverrides = JSON.parse((await promises.readFile(join(APP_ROOT, 'product.overrides.json'))).toString());
			Object.assign(productConfiguration, productOverrides);
		} catch (err) {/* Ignore Error */ }
	}

		const parseBoolean = (value: unknown): boolean => {
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

		const verboseConsoleFlag = parseBoolean(this._environmentService.args['openvscode-verbose-console']);
		const verboseConsoleEnv = parseBoolean(process.env.OPENVSCODE_VERBOSE_CONSOLE);
		const webviewDebugFlag = parseBoolean(this._environmentService.args['openvscode-webview-debug']);
		const webviewDebugEnv = parseBoolean(process.env.OPENVSCODE_WEBVIEW_DEBUG);

		const openvscodeConfiguration = {
			verboseConsole: verboseConsoleFlag || verboseConsoleEnv,
			webviewDebug: webviewDebugFlag || webviewDebugEnv,
		};

		const workbenchWebConfiguration = {
			remoteAuthority,
			serverBasePath: basePath,
			_wrapWebWorkerExtHostInIframe,
			developmentOptions: { enableSmokeTestDriver: this._environmentService.args['enable-smoke-test-driver'] ? true : undefined, logLevel: this._logService.getLevel() },
			settingsSyncOptions: !this._environmentService.isBuilt && this._environmentService.args['enable-sync'] ? { enabled: true } : undefined,
			enableWorkspaceTrust: !this._environmentService.args['disable-workspace-trust'],
			folderUri: resolveWorkspaceURI(this._environmentService.args['default-folder']),
			workspaceUri: resolveWorkspaceURI(this._environmentService.args['default-workspace']),
			productConfiguration,
			webviewEndpoint,
			webviewServiceWorkerVersion,
			callbackRoute: callbackRoute,
			openvscode: openvscodeConfiguration
		};

		const cookies = cookie.parse(req.headers.cookie || '');
		const locale = cookies['vscode.nls.locale'] || req.headers['accept-language']?.split(',')[0]?.toLowerCase() || 'en';
		let WORKBENCH_NLS_BASE_URL: string | undefined;
		let WORKBENCH_NLS_URL: string;
		if (!locale.startsWith('en') && this._productService.nlsCoreBaseUrl) {
			WORKBENCH_NLS_BASE_URL = this._productService.nlsCoreBaseUrl;
			WORKBENCH_NLS_URL = `${WORKBENCH_NLS_BASE_URL}${this._productService.commit}/${this._productService.version}/${locale}/nls.messages.js`;
		} else {
			WORKBENCH_NLS_URL = ''; // fallback will apply
		}

		const values: { [key: string]: string } = {
			WORKBENCH_WEB_CONFIGURATION: asJSON(workbenchWebConfiguration),
			WORKBENCH_AUTH_SESSION: authSessionInfo ? asJSON(authSessionInfo) : '',
			WORKBENCH_WEB_BASE_URL: staticRoute,
			WORKBENCH_NLS_URL,
			WORKBENCH_NLS_FALLBACK_URL: `${staticRoute}/out/nls.messages.js`
		};

		// DEV ---------------------------------------------------------------------------------------
		// DEV: This is for development and enables loading CSS via import-statements via import-maps.
		// DEV: The server needs to send along all CSS modules so that the client can construct the
		// DEV: import-map.
		// DEV ---------------------------------------------------------------------------------------
		if (this._cssDevService.isEnabled) {
			const cssModules = await this._cssDevService.getCssModules();
			values['WORKBENCH_DEV_CSS_MODULES'] = JSON.stringify(cssModules);
		}

	if (useTestResolver) {
			const bundledExtensions: { extensionPath: string; packageJSON: IExtensionManifest }[] = [];
			for (const extensionPath of ['vscode-test-resolver', 'github-authentication']) {
				const packageJSON = JSON.parse((await promises.readFile(FileAccess.asFileUri(`${builtinExtensionsPath}/${extensionPath}/package.json`).fsPath)).toString());
				bundledExtensions.push({ extensionPath, packageJSON });
			}
			values['WORKBENCH_BUILTIN_EXTENSIONS'] = asJSON(bundledExtensions);
		}

		let data;
		try {
			const workbenchTemplate = (await promises.readFile(filePath)).toString();
			data = workbenchTemplate.replace(/\{\{([^}]+)\}\}/g, (_, key) => values[key] ?? 'undefined');
		} catch (e) {
			res.writeHead(404, { 'Content-Type': 'text/plain' });
			return void res.end('Not found');
		}

		const webWorkerExtensionHostIframeScriptSHA = 'sha256-2Q+j4hfT09+1+imS46J2YlkCtHWQt0/BE79PXjJ0ZJ8=';

		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'self\';',
			`script-src 'self' 'unsafe-eval' ${WORKBENCH_NLS_BASE_URL ?? ''} blob: 'nonce-1nline-m4p' ${this._getScriptCspHashes(data).join(' ')} '${webWorkerExtensionHostIframeScriptSHA}' 'sha256-/r7rqQ+yrxt57sxLuQ6AMYcy/lUpvAIzHjIJt/OeLWU=' ${useTestResolver ? '' : `${protocol}://${remoteAuthority}`};`,  // the sha is the same as in src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
			'child-src \'self\';',
			`frame-src 'self' ${protocol}://${remoteAuthority} https://*.vscode-cdn.net data:;`,
			'worker-src \'self\' data: blob:;',
			'style-src \'self\' \'unsafe-inline\';',
			'connect-src \'self\' ws: wss: https: http:;',
			'font-src \'self\' https: http: data: blob:;',
			'manifest-src \'self\';'
		].join(' ');

		const headers: http.OutgoingHttpHeaders = {
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		};
		if (this._connectionToken.type !== ServerConnectionTokenType.None) {
			// At this point we know the client has a valid cookie
			// and we want to set it prolong it to ensure that this
			// client is valid for another 1 week at least
			headers['Set-Cookie'] = cookie.serialize(
				connectionTokenCookieName,
				this._connectionToken.value,
				{
					sameSite: 'lax',
					maxAge: 60 * 60 * 24 * 7 /* 1 week */
				}
			);
		}

		res.writeHead(200, headers);
		return void res.end(data);
	}

	private async _resolveWebviewServiceWorkerVersion(): Promise<string> {
		if (!this._webviewServiceWorkerVersionPromise) {
			this._webviewServiceWorkerVersionPromise = (async () => {
				try {
					const info = await this._getWebviewServiceWorkerInfo();
					return info.version;
				} catch (error) {
					this._logService.error(`[WebClientServer] Failed to compute webview service worker version: ${error instanceof Error ? error.message : String(error)}`);
					return this._productService.commit ?? Date.now().toString();
				}
			})();
		}

		return this._webviewServiceWorkerVersionPromise;
	}

	private async _getWebviewServiceWorkerInfo(): Promise<{ version: string; sourceText: string }> {
		if (!this._webviewServiceWorkerInfoPromise) {
			this._webviewServiceWorkerInfoPromise = (async () => {
				const serviceWorkerPath = join(APP_ROOT, 'static', 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', 'service-worker.js');
				const contentBuffer = await promises.readFile(serviceWorkerPath);
				return {
					version: crypto.createHash('sha256').update(contentBuffer).digest('hex'),
					sourceText: contentBuffer.toString('utf-8')
				};
			})();
		}

		return this._webviewServiceWorkerInfoPromise;
	}

	private _getScriptCspHashes(content: string): string[] {
		// Compute the CSP hashes for line scripts. Uses regex
		// which means it isn't 100% good.
		const regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/img;
		const result: string[] = [];
		let match: RegExpExecArray | null;
		while (match = regex.exec(content)) {
			const attributes = match[1];
			if (/\ssrc\s*=/.test(attributes ?? '')) {
				continue;
			}
			const hasher = crypto.createHash('sha256');
			// This only works on Windows if we strip `\r` from `\r\n`.
			const script = match[2].replace(/\r\n/g, '\n');
			if (!script.trim()) {
				continue;
			}
			const hash = hasher
				.update(Buffer.from(script))
				.digest().toString('base64');

			result.push(`'sha256-${hash}'`);
		}
		return result;
	}

	/**
	 * Handle HTTP requests for /callback
	 */
	private async _handleCallback(res: http.ServerResponse): Promise<void> {
		const filePath = FileAccess.asFileUri('vs/code/browser/workbench/callback.html').fsPath;
		const data = (await promises.readFile(filePath)).toString();
		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'none\';',
			`script-src 'self' ${this._getScriptCspHashes(data).join(' ')};`,
			'style-src \'self\' \'unsafe-inline\';',
			'font-src \'self\' blob:;'
		].join(' ');

		res.writeHead(200, {
			'Content-Type': 'text/html',
			'Content-Security-Policy': cspDirectives
		});
		return void res.end(data);
	}

}

function isAllowedStaticCdnOrigin(origin: string, logService: ILogService): boolean {
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== 'https:') {
			return false;
		}
		return parsed.hostname.endsWith('.vscode-cdn.net');
	} catch (error) {
		logService.trace(`[WebClientServer] Ignoring invalid static origin "${origin}": ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

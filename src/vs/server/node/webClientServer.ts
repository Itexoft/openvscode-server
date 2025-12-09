/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createReadStream, promises } from "fs";
import { Buffer } from "buffer";
import * as http from "http";
import * as url from "url";
import * as cookie from "cookie";
import * as crypto from "crypto";
import { isEqualOrParent } from "../../base/common/extpath.js";
import { getMediaMime } from "../../base/common/mime.js";
import { isLinux } from "../../base/common/platform.js";
import { ILogService, LogLevel } from "../../platform/log/common/log.js";
import { IServerEnvironmentService } from "./serverEnvironmentService.js";
import {
	extname,
	dirname,
	join,
	normalize,
	posix,
	resolve,
} from "../../base/common/path.js";
import {
	FileAccess,
	connectionTokenCookieName,
	connectionTokenQueryName,
	Schemas,
	builtinExtensionsPath,
} from "../../base/common/network.js";
import { generateUuid } from "../../base/common/uuid.js";
import { IProductService } from "../../platform/product/common/productService.js";
import {
	ServerConnectionToken,
	ServerConnectionTokenType,
} from "./serverConnectionToken.js";
import {
	asTextOrError,
	IRequestService,
} from "../../platform/request/common/request.js";
import { IHeaders } from "../../base/parts/request/common/request.js";
import { CancellationToken } from "../../base/common/cancellation.js";
import { URI } from "../../base/common/uri.js";
import { readdir } from "fs/promises";
import { streamToBuffer } from "../../base/common/buffer.js";
import { IProductConfiguration } from "../../base/common/product.js";
import { isString, Mutable } from "../../base/common/types.js";
import { CharCode } from "../../base/common/charCode.js";
import { IExtensionManifest } from "../../platform/extensions/common/extensions.js";
import { ICSSDevelopmentService } from "../../platform/cssDev/node/cssDevService.js";

const textMimeType: { [ext: string]: string | undefined } = {
	".html": "text/html",
	".js": "text/javascript",
	".json": "application/json",
	".css": "text/css",
	".svg": "image/svg+xml",
};

/**
 * Return an error to the client.
 */
export async function serveError(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	errorCode: number,
	errorMessage: string,
): Promise<void> {
	res.writeHead(errorCode, { "Content-Type": "text/plain" });
	if (req.method === "HEAD") {
		res.end();
	} else {
		res.end(errorMessage);
	}
}

export const enum CacheControl {
	NO_CACHING,
	ETAG,
	NO_EXPIRY,
}

/**
 * Serve a file at a given path or 404 if the file is missing.
 */
export async function serveFile(
	filePath: string,
	cacheControl: CacheControl,
	logService: ILogService,
	req: http.IncomingMessage,
	res: http.ServerResponse,
	responseHeaders: Record<string, string>,
): Promise<void> {
	try {
		const stat = await promises.stat(filePath); // throws an error if file doesn't exist
		if (cacheControl === CacheControl.ETAG) {
			// Check if file modified since
			const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join("-")}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
			if (req.headers["if-none-match"] === etag) {
				res.writeHead(304);
				return void res.end();
			}

			responseHeaders["Etag"] = etag;
		} else if (cacheControl === CacheControl.NO_EXPIRY) {
			responseHeaders["Cache-Control"] = "public, max-age=31536000";
		} else if (cacheControl === CacheControl.NO_CACHING) {
			responseHeaders["Cache-Control"] = "no-store";
		}

		responseHeaders["Content-Type"] =
			textMimeType[extname(filePath)] || getMediaMime(filePath) || "text/plain";

		res.writeHead(200, responseHeaders);

		if (req.method === "HEAD") {
			res.end();
		} else {
			// Data
			createReadStream(filePath).pipe(res);
		}
	} catch (error) {
		if (error.code !== "ENOENT") {
			logService.error(error);
			console.error(error.toString());
		} else {
			console.error(`File not found: ${filePath}`);
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		if (req.method === "HEAD") {
			return void res.end();
		}

		return void res.end("Not found");
	}
}

const APP_ROOT = dirname(FileAccess.asFileUri("").fsPath);
const RUNTIME_ROOT = normalize(process.env.OPENVSCODE_RUNTIME_ROOT ?? "/home/openvscode-server");

const STATIC_PATH = `/static`;
const CALLBACK_PATH = `/callback`;
const WEB_EXTENSION_PATH = `/web-extension-resource`;
const WEBVIEW_RESOURCE_PROXY_PREFIX =
	"out/vs/workbench/contrib/webview/browser/pre/resource/";
const WEBVIEW_PRE_ROOT = WEBVIEW_RESOURCE_PROXY_PREFIX.slice(
	0,
	-"resource/".length,
);

const decodeComponentMulti = (value: string): string => {
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

const decodeAuthoritySegment = (value: string): string => {
	return decodeComponentMulti(
		value.replace(/-([0-9a-fA-F]{4})/g, (_, hex) => {
			try {
				return String.fromCharCode(parseInt(hex, 16));
			} catch {
				return `-${hex}`;
			}
		}),
	);
};

const parseBooleanFlag = (value: unknown): boolean => {
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return normalized === "1" || normalized === "true" || normalized === "yes";
	}

	if (typeof value === "number") {
		return value !== 0;
	}

	if (typeof value === "boolean") {
		return value;
	}

	return false;
};

type DebugLogFn = (message: string, ...args: unknown[]) => void;

const parseEncodedBaseHref = (
	encoded: string,
	debugLog?: DebugLogFn,
):
	| { scheme: string; authority: string; path: string; query: string }
	| undefined => {
	const decoded = decodeComponentMulti(encoded);
	const matches = decoded.match(
		/^([a-zA-Z0-9+\-.]+):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/,
	);
	if (!matches) {
		debugLog?.(
			`[WebClientServer][debug] parseEncodedBaseHref: unable to parse "${decoded}"`,
		);
		return undefined;
	}

	const originalScheme = matches[1];
	const rawHost = decodeAuthoritySegment(matches[2]);
	let path = decodeComponentMulti(matches[3] ?? "/");
	if (!path.length || !path.startsWith("/")) {
		path = `/${path}`;
	}
	const query = matches[4] ? decodeComponentMulti(matches[4].slice(1)) : "";

	let scheme = originalScheme;
	let authority = rawHost;

	const marker = ".vscode-resource.";
	const lowerHost = rawHost.toLowerCase();
	const markerIndex = lowerHost.indexOf(marker);
	if (markerIndex >= 0) {
		const prefix = rawHost.slice(0, markerIndex);
		const plusIndex = prefix.indexOf("+");
		if (plusIndex >= 0) {
			scheme = prefix.slice(0, plusIndex);
			const encodedAuthority = prefix.slice(plusIndex + 1);
			authority = decodeAuthoritySegment(encodedAuthority);
		} else if (prefix === "file") {
			scheme = "file";
			authority = "";
		}
	} else if (lowerHost.startsWith("vscode-remote+")) {
		scheme = Schemas.vscodeRemote;
		const encodedAuthority = rawHost.slice("vscode-remote+".length);
		authority = decodeAuthoritySegment(encodedAuthority);
	} else if (lowerHost.startsWith("file+vscode-resource")) {
		scheme = "file";
		authority = "";
	} else if (lowerHost.startsWith("vscode-resource")) {
		scheme = "file";
		authority = "";
	}

	return { scheme, authority, path, query };
};

const resolveResourceSegment = (
	basePath: string,
	resourceSegment: string,
): { path: string; query: string } => {
	try {
		const normalizedBasePath = (() => {
			if (!basePath || basePath === "/") {
				return "/";
			}
			return basePath.endsWith("/") ? basePath : `${basePath}/`;
		})();
		const baseForResolution = new URL(normalizedBasePath, "http://placeholder");
		const resolved = new URL(resourceSegment || ".", baseForResolution);
		return {
			path: resolved.pathname,
			query: resolved.search.replace(/^\?/, ""),
		};
	} catch {
		return {
			path: resourceSegment || "/",
			query: "",
		};
	}
};

const resolveNestedResource = (
	baseInfo: { scheme: string; authority: string; path: string; query: string },
	resourceSegmentRaw: string,
	requestUrlSearch: string,
	debugLog?: DebugLogFn,
):
	| { scheme: string; authority: string; path: string; query: string }
	| undefined => {
	let currentBase = baseInfo;
	let remaining = resourceSegmentRaw;

	while (remaining.startsWith("resource/")) {
		remaining = remaining.slice("resource/".length);
		const slashIndex = remaining.indexOf("/");
		if (slashIndex === -1) {
			debugLog?.(
				`[WebClientServer][debug] resolveNestedResource: malformed nested segment "${remaining}"`,
			);
			return undefined;
		}

		const nestedEncodedBase = remaining.slice(0, slashIndex);
		const nestedBaseInfo = parseEncodedBaseHref(nestedEncodedBase, debugLog);
		if (!nestedBaseInfo) {
			debugLog?.(
				`[WebClientServer][debug] resolveNestedResource: failed to parse nested base "${nestedEncodedBase}"`,
			);
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

	const { path, query } = resolveResourceSegment(currentBase.path, remaining);
	return {
		scheme: currentBase.scheme,
		authority: currentBase.authority,
		path,
		query: query || currentBase.query || requestUrlSearch,
	};
};

const isDebugResourceSegment = (segment: string): boolean => {
	const queryIndex = segment.indexOf("?");
	const withoutQuery =
		queryIndex === -1 ? segment : segment.slice(0, queryIndex);
	const trimmed = withoutQuery.replace(/^(\.\/)+/, "");
	return trimmed === "__debug__/last-resource";
};

const normalizeEncodedBase = (value: string): string => {
	const decoded = decodeComponentMulti(value);
	if (/^https?:\/\/vscode-remote\+/i.test(decoded)) {
		return encodeURIComponent(decoded);
	}
	return value;
};

const sanitizeResourceSegment = (segment: string): string => {
	const slashIndex = segment.indexOf("/");
	const head = slashIndex === -1 ? segment : segment.slice(0, slashIndex);
	const tail = slashIndex === -1 ? "" : segment.slice(slashIndex);
	const decodedHead = decodeComponentMulti(head);
	if (/^https?:\/\/vscode-remote\+/i.test(decodedHead)) {
		const sanitizedHead = encodeURIComponent(decodedHead);
		return `${sanitizedHead}${tail}`;
	}
	return segment;
};

const splitEncodedBaseAndResource = (
	value: string,
): { encodedBase: string; resourceSegmentRaw: string } => {
	const input = value ?? "";
	const schemeIndex = input.indexOf("://");
	const splitIndex =
		schemeIndex >= 0
			? input.indexOf("/", schemeIndex + "://".length)
			: input.indexOf("/");
	if (splitIndex === -1) {
		return { encodedBase: input, resourceSegmentRaw: "" };
	}
	return {
		encodedBase: input.slice(0, splitIndex),
		resourceSegmentRaw: input.slice(splitIndex + 1),
	};
};

const collapseNestedRemoteUrl = (value: string): string => {
	const normalized = normalizeResourceInput(value);
	const matches = [...normalized.matchAll(/https?:\/\/vscode-remote\+[^/]+/g)];
	if (matches.length > 1) {
		const last = matches[matches.length - 1];
		if (typeof last.index === "number") {
			return normalized.slice(last.index);
		}
	}
	return normalized;
};

const normalizeResourceInput = (value: string): string => {
	const decoded = decodeComponentMulti((value ?? "").replace(/^https:\//, "https://"));
	const marker = ".vscode-resource.";
	const markerIndex = decoded.indexOf(marker);
	if (markerIndex !== -1) {
		const pathIndex = decoded.indexOf("/", markerIndex + marker.length);
		if (pathIndex !== -1) {
			return decoded.slice(pathIndex);
		}
	}
	const schemeIndex = decoded.indexOf("://");
	if (schemeIndex !== -1) {
		const pathIndex = decoded.indexOf("/", schemeIndex + "://".length);
		if (pathIndex !== -1) {
			return decoded.slice(pathIndex);
		}
	}
	return decoded;
};

const tryResolveAbsoluteResource = (
	rawSegment: string,
	requestQuery: string,
	debugLog?: DebugLogFn,
): { scheme: string; authority: string; path: string; query: string } | undefined => {
	const normalized = collapseNestedRemoteUrl(rawSegment);

	// Попробуем распарсить как полноценный base href (scheme://authority/path?query).
	const baseInfo = parseEncodedBaseHref(normalized, debugLog);
	if (baseInfo) {
		return {
			scheme: baseInfo.scheme,
			authority: baseInfo.authority,
			path: baseInfo.path,
			query: baseInfo.query || requestQuery,
		};
	}

	// Если base не распарсился, но это похоже на абсолютный путь — считаем file/vscode-remote путь.
	const fallbackPath = normalized.startsWith("/") ? normalized : undefined;
	if (fallbackPath) {
		return {
			scheme: Schemas.vscodeRemote,
			authority: "",
			path: fallbackPath,
			query: requestQuery,
		};
	}
	return undefined;
};

const normalizeRemoteBase = (
	base: { scheme: string; authority: string; path: string; query: string },
): { scheme: string; authority: string; path: string; query: string } => {
	if (
		(base.scheme === "http" || base.scheme === "https") &&
		base.authority.startsWith("vscode-remote+")
	) {
		return {
			scheme: Schemas.vscodeRemote,
			authority: decodeAuthoritySegment(
				base.authority.slice("vscode-remote+".length),
			),
			path: base.path,
			query: base.query,
		};
	}
	return base;
};

const resolveWebviewResourceProxyTarget = (
	encodedTarget: string,
	requestQuery: string,
	debugLog?: DebugLogFn,
):
	| { scheme: string; authority: string; path: string; query: string }
	| undefined => {
	const normalizedTarget = collapseNestedRemoteUrl(
		decodeComponentMulti(encodedTarget),
	);
	const { encodedBase: rawBase, resourceSegmentRaw: rawSegment } =
		splitEncodedBaseAndResource(normalizedTarget);
	const encodedBase = normalizeEncodedBase(rawBase);
	const resourceSegmentRaw = sanitizeResourceSegment(rawSegment);

	const absoluteSegment = tryResolveAbsoluteResource(resourceSegmentRaw, requestQuery, debugLog);
	if (absoluteSegment) {
		return absoluteSegment;
	}

	if (!encodedBase) {
		return undefined;
	}

	const baseInfo = parseEncodedBaseHref(encodedBase, debugLog);
	if (!baseInfo) {
		debugLog?.(
			`[WebClientServer][debug] resolveWebviewResourceProxyTarget: no base info for base=${encodedBase}, requestQuery=${requestQuery}`,
		);
		return undefined;
	}

	if (isDebugResourceSegment(resourceSegmentRaw)) {
		return undefined;
	}

	const normalizedBase = normalizeRemoteBase(baseInfo);

	return resolveNestedResource(
		normalizedBase,
		resourceSegmentRaw,
		requestQuery.replace(/^\?/, ""),
		debugLog,
	);
};

const lookupBasename = (value: string): string => {
	const withoutQuery = value.replace(/[?#].*$/, "");
	return posix.basename(withoutQuery);
};

const getAlternateBasenames = (value: string): string[] => {
	const primary = lookupBasename(value);
	const alternates = [primary];
	if (primary.endsWith(".map.json")) {
		alternates.push(primary.replace(/\.map\.json$/, ".js.map"));
	} else if (primary.endsWith(".sourcemap")) {
		alternates.push(primary.replace(/\.sourcemap$/, ".js.map"));
	}
	return alternates;
};

export class WebClientServer {
	private readonly _webExtensionResourceUrlTemplate: URI | undefined;
	private _webviewServiceWorkerVersionPromise: Promise<string> | undefined;
	private _webviewServiceWorkerInfoPromise:
		| Promise<{ version: string; sourceText: string }>
		| undefined;
	private _webviewPreIndexCache:
		| { mtimeMs: number; etag: string; content: string }
		| undefined;
	private readonly _webviewResourceRoots = new Map<
		string,
		{ scheme: string; authority: string; directory: string }
	>();
	private readonly _webviewResourceRootsById = new Map<
		string,
		{ scheme: string; authority: string; directory: string }
	>();
	private readonly _extensionResourceByBasename = new Map<string, string | null>();
	private readonly _serverResourceByBasename = new Map<string, string | null>();
	private readonly _debugLogger: DebugLogFn | undefined;

	constructor(
		private readonly _connectionToken: ServerConnectionToken,
		private readonly _basePath: string,
		private readonly _productPath: string,
		@IServerEnvironmentService
		private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IRequestService private readonly _requestService: IRequestService,
		@IProductService private readonly _productService: IProductService,
		@ICSSDevelopmentService
		private readonly _cssDevService: ICSSDevelopmentService,
	) {
		this._webExtensionResourceUrlTemplate = this._productService
			.extensionsGallery?.resourceUrlTemplate
			? URI.parse(this._productService.extensionsGallery.resourceUrlTemplate)
			: undefined;
		const argsRecord = this._environmentService.args as unknown as Record<string, unknown>;
		const debugFlag = parseBooleanFlag(argsRecord['openvscode-debug']);
		const debugEnv = parseBooleanFlag(process.env.OPENVSCODE_DEBUG);
		const debugEnabled = debugFlag || debugEnv;
		this._debugLogger = debugEnabled
			? (message, ...args) => {
					if (args.length) {
						console.log(message, ...args);
					} else {
						console.log(message);
					}
				}
			: undefined;
	}

		/**
		 * Handle web resources (i.e. only needed by the web client).
		 * **NOTE**: This method is only invoked when the server has web bits.
		 * **NOTE**: This method is only invoked after the connection token has been validated.
		 * @param parsedUrl The URL to handle, including base and product path
	 * @param pathname The pathname of the URL, without base and product path
	 */
	async handle(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		parsedUrl: url.UrlWithParsedQuery,
		pathname: string,
	): Promise<void> {
		this._debugLogger?.(
			`[WebClientServer] handle ${req.method} ${pathname} origin=${req.headers.origin ?? ""}`,
		);
		try {
			const ossMatch = /^\/oss-[0-9a-f]+(\/.*)$/.exec(pathname);
			if (ossMatch && ossMatch[1]) {
				const ossPath = ossMatch[1];
				const ossPathWithoutQuery = ossPath.split("?")[0];
				if (
					ossPath.startsWith(STATIC_PATH) &&
					ossPath.charCodeAt(STATIC_PATH.length) === CharCode.Slash
				) {
					return this._handleStatic(
						req,
						res,
						ossPath.substring(STATIC_PATH.length),
					);
				}
				if (ossPathWithoutQuery === "/version") {
					return this._handleVersion(req, res);
				}
				if (ossPathWithoutQuery === "/") {
					return this._handleRoot(req, res, parsedUrl);
				}
					if (ossPathWithoutQuery === CALLBACK_PATH) {
						return this._handleCallback(res);
					}
					if (ossPathWithoutQuery === "/vscode-remote-resource") {
						return this._handleVSCodeRemoteResource(req, res, parsedUrl);
					}
					if (
						ossPath.startsWith(WEB_EXTENSION_PATH) &&
						ossPath.charCodeAt(WEB_EXTENSION_PATH.length) === CharCode.Slash
					) {
						return this._handleWebExtensionResource(
						req,
						res,
						ossPath.substring(WEB_EXTENSION_PATH.length),
					);
			}
		}

		// Фолбек для прямых обращений к asset-файлам (например, "/default-dark.css" или "/assets/index-*.js") из webview,
		// если SW не перехватил запрос. Ищем по basename среди расширений/серверных ассетов.
		if (
			(req.method?.toUpperCase() === "GET" || req.method?.toUpperCase() === "HEAD") &&
			!pathname.startsWith(STATIC_PATH) &&
			!pathname.startsWith(CALLBACK_PATH) &&
			!pathname.startsWith(WEB_EXTENSION_PATH) &&
			!pathname.startsWith(`/${WEBVIEW_PRE_ROOT}`)
		) {
			const basename = posix.basename(pathname);
			if (basename && basename.includes(".")) {
				const extMatch = await this._findExtensionResourceByBasename(basename);
				const serverMatch = extMatch
					? undefined
					: await this._findServerResourceByBasename(basename);
				const candidate = extMatch ?? serverMatch;
				if (
					candidate &&
					this._isAllowedWebviewResourcePath(candidate) &&
					(await this._fileExists(candidate))
				) {
					this._logService.info(
						`[WebClientServer] loose asset hit -> ${candidate} (request=${pathname})`,
					);
					const headers: Record<string, string> = Object.create(null);
					return serveFile(
						candidate,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
				}
			}
		}

		if (
			pathname.startsWith(STATIC_PATH) &&
			pathname.charCodeAt(STATIC_PATH.length) === CharCode.Slash
		) {
			return this._handleStatic(
					req,
					res,
					pathname.substring(STATIC_PATH.length),
				);
			}
			if (pathname === "/version") {
				return this._handleVersion(req, res);
			}
				if (pathname === "/") {
					return this._handleRoot(req, res, parsedUrl);
				}
				if (pathname === CALLBACK_PATH) {
					// callback support
					return this._handleCallback(res);
				}
				if (pathname === "/vscode-remote-resource") {
					return this._handleVSCodeRemoteResource(req, res, parsedUrl);
				}
				if (
					pathname.startsWith(WEB_EXTENSION_PATH) &&
					pathname.charCodeAt(WEB_EXTENSION_PATH.length) === CharCode.Slash
				) {
					// extension resource support
				return this._handleWebExtensionResource(
					req,
					res,
					pathname.substring(WEB_EXTENSION_PATH.length),
				);
			}

			return serveError(req, res, 404, "Not found.");
		} catch (error) {
			this._logService.error(error);
			console.error(error.toString());

			return serveError(req, res, 500, "Internal Server Error.");
		}
	}
	private _handleVersion(
		req: http.IncomingMessage,
		res: http.ServerResponse,
	): void {
		const isHead = req.method?.toUpperCase() === "HEAD";
		const remote = req.socket?.remoteAddress ?? "unknown";
		this._logService.info(
			`[diag] /version ${isHead ? "HEAD" : "GET"} from ${remote}`,
		);

		const headers: Record<string, string> = { "Content-Type": "text/plain" };
		res.writeHead(200, headers);
		if (isHead) {
			res.end();
			return;
		}

		const lines: string[] = [];
		const productName =
			this._productService.nameLong ??
			this._productService.nameShort ??
			"OpenVSCode Server";
		if (productName) {
			lines.push(`product: ${productName}`);
		}
		if (this._productService.version) {
			lines.push(`version: ${this._productService.version}`);
		}
		if (this._productService.commit) {
			lines.push(`commit: ${this._productService.commit}`);
		}
		lines.push(`timestamp: ${new Date().toISOString()}`);

		res.end(lines.join("\n"));
	}

	/**
	 * Handle HTTP requests for /static/*
	 * @param resourcePath The path after /static/
	 */
	private async _handleStatic(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		resourcePath: string,
	): Promise<void> {
		const headers: Record<string, string> = Object.create(null);
		if (this._connectionToken.type !== ServerConnectionTokenType.None) {
			const cookieHeader = req.headers.cookie ?? "";
			const hasTokenCookie = cookieHeader
				.split(";")
				.map((part) => part.trim())
				.some((part) => part.startsWith(`${connectionTokenCookieName}=`));
			if (!hasTokenCookie) {
				headers["Set-Cookie"] = cookie.serialize(
					connectionTokenCookieName,
					this._connectionToken.value,
					{
						sameSite: "lax",
						maxAge: 60 * 60 * 24 * 7 /* 1 week */,
					},
				);
			}
		}

		// Strip the this._staticRoute from the path
		let normalizedPathname = decodeURIComponent(resourcePath).replace(
			/^\/+/,
			"",
		); // support paths that are uri-encoded (e.g. spaces => %20)
		this._debugLogger?.(
			`[WebClientServer][debug] normalizedPathname=${normalizedPathname}`,
		);

		// Allow requests routed through /oss-<commit>/static/... to fall back to /static/...
		if (normalizedPathname.startsWith("oss-")) {
			const firstSlash = normalizedPathname.indexOf("/");
			if (firstSlash !== -1) {
				normalizedPathname = normalizedPathname.slice(firstSlash + 1);
				if (normalizedPathname.startsWith("static/")) {
					normalizedPathname = normalizedPathname.slice("static/".length);
				}
			}
		}

		// Allow static-prefixed pre resources (/static/out/vs/.../pre/...) to resolve like non-static paths.
		if (normalizedPathname.startsWith(`static/${WEBVIEW_PRE_ROOT}`)) {
			normalizedPathname = normalizedPathname.slice("static/".length);
		}

		// Normalize regexpp paths even when they are still prefixed with static/.
		if (normalizedPathname.startsWith("static/node_modules/vscode-regexpp/")) {
			normalizedPathname = normalizedPathname.slice("static/".length);
		}

		// Decode query once for special-case handlers.
		let requestQuery = "";
		try {
			const parsed = new URL(req.url ?? "", "https://placeholder");
			requestQuery = parsed.search.replace(/^\?/, "");
		} catch {
			requestQuery = "";
		}

		// Быстрый обработчик pre/* путей с зашитым https:/vscode-remote+ (включая один слеш).
		if (
			normalizedPathname.startsWith(WEBVIEW_PRE_ROOT) &&
			normalizedPathname.indexOf("vscode-remote+") !== -1
		) {
			this._debugLogger?.(
				`[WebClientServer][debug] pre-embedded request ${normalizedPathname}, query=${requestQuery}`,
			);
			const rawTail = normalizedPathname
				.slice(WEBVIEW_PRE_ROOT.length)
				.replace(/^resource\//, "");
			const normalizedTail = collapseNestedRemoteUrl(
				rawTail.replace(/https:\//g, "https://"),
			);
			this._debugLogger?.(
				`[WebClientServer][debug] pre-embedded tail=${normalizedTail}`,
			);
			this._logService.info(
				`[WebClientServer] pre-embedded request: path=${normalizedPathname} tail=${normalizedTail} query=${requestQuery}`,
			);
			// Если хвост уже абсолютный путь, отдаём напрямую без proxy-резолва.
			if (normalizedTail.startsWith("/")) {
				const normalizedTargetPath = normalize(normalizedTail);
				if (
					this._isAllowedWebviewResourcePath(normalizedTargetPath) &&
					(await this._fileExists(normalizedTargetPath))
				) {
					this._logService.info(
						`[WebClientServer] pre-embedded absolute hit -> ${normalizedTargetPath}`,
					);
					return serveFile(
						normalizedTargetPath,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
				}
				this._logService.warn(
					`[WebClientServer] pre-embedded absolute miss -> ${normalizedTargetPath}`,
				);
			}
			const target = resolveWebviewResourceProxyTarget(
				normalizedTail,
				requestQuery,
				this._debugLogger,
			);
			if (
				target &&
				target.path &&
				this._isAllowedWebviewResourcePath(target.path)
			) {
				const normalizedTargetPath = normalize(target.path);
				if (await this._fileExists(normalizedTargetPath)) {
					this._debugLogger?.(
						`[WebClientServer][debug] pre-embedded proxy -> ${normalizedTargetPath}`,
					);
					this._logService.info(
						`[WebClientServer] pre-embedded hit -> ${normalizedTargetPath}`,
					);
					return serveFile(
						normalizedTargetPath,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
				}
				this._logService.warn(
					`[WebClientServer] pre-embedded target missing -> ${normalizedTargetPath}`,
				);
			}
			const fallbackPath = this._extractRegexppFsPath(normalizedTail);
			if (
				fallbackPath &&
				this._isAllowedWebviewResourcePath(fallbackPath) &&
				(await this._fileExists(fallbackPath))
			) {
				this._debugLogger?.(
					`[WebClientServer][debug] pre-embedded fallback -> ${fallbackPath}`,
				);
				return serveFile(
					fallbackPath,
					this._environmentService.isBuilt
						? CacheControl.NO_EXPIRY
						: CacheControl.ETAG,
					this._logService,
					req,
					res,
					headers,
				);
			}
			this._debugLogger?.(
				`[WebClientServer][debug] pre-embedded unresolved, returning 404`,
			);
			return serveError(req, res, 404, "Not Found");
		}

		// Early fast-path: если последний сегмент уже содержит закодированный vscode-remote+ URL, пробуем его распарсить и отдать файл напрямую.
		const lastPathSegmentEncoded = normalizedPathname.slice(
			normalizedPathname.lastIndexOf("/") + 1,
		);
		const decodedLastSegment = decodeComponentMulti(
			lastPathSegmentEncoded.replace(/^https:\//, "https://"),
		);
		if (decodedLastSegment.includes("vscode-remote+")) {
			const directTarget = resolveWebviewResourceProxyTarget(
				decodedLastSegment,
				requestQuery,
				this._debugLogger,
			);
			if (
				directTarget &&
				directTarget.path &&
				this._isAllowedWebviewResourcePath(directTarget.path)
			) {
				const normalizedTargetPath = normalize(directTarget.path);
				if (await this._fileExists(normalizedTargetPath)) {
					this._debugLogger?.(
						`[WebClientServer][debug] direct remote segment -> ${normalizedTargetPath}`,
					);
					return serveFile(
						normalizedTargetPath,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
				}
			}
		}

		// Deterministic handling of legacy regexpp paths that embed an encoded vscode-resource target.
		const regexppMatch = normalizedPathname.match(/^node_modules\/vscode-regexpp\/(.+)/);
		if (regexppMatch && regexppMatch[1]) {
			const decodedTail = decodeComponentMulti(
				regexppMatch[1].replace(/https:\//g, "https://"),
			);
			const encodedTarget = collapseNestedRemoteUrl(decodedTail);
			const target = resolveWebviewResourceProxyTarget(
				encodedTarget,
				requestQuery,
				this._debugLogger,
			);
			if (
				target &&
				(target.scheme === Schemas.file || target.scheme === Schemas.vscodeRemote) &&
				target.path &&
				this._isAllowedWebviewResourcePath(target.path)
			) {
				const normalizedTargetPath = normalize(target.path);
				if (await this._fileExists(normalizedTargetPath)) {
					this._debugLogger?.(
						`[WebClientServer][debug] regexpp proxy -> ${normalizedTargetPath}`,
					);
					return serveFile(
						normalizedTargetPath,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
				}
				this._debugLogger?.(
					`[WebClientServer][debug] regexpp proxy missing file ${normalizedTargetPath}`,
				);
				return serveError(req, res, 404, "Not Found");
			}

			const fallbackPath = this._extractRegexppFsPath(encodedTarget);
			if (
				fallbackPath &&
				this._isAllowedWebviewResourcePath(fallbackPath) &&
				(await this._fileExists(fallbackPath))
			) {
				this._debugLogger?.(
					`[WebClientServer][debug] regexpp fallback -> ${fallbackPath}`,
				);
				return serveFile(
					fallbackPath,
					this._environmentService.isBuilt
						? CacheControl.NO_EXPIRY
						: CacheControl.ETAG,
					this._logService,
					req,
					res,
					headers,
				);
			}

			// Не даём упасть в статический обработчик с путём static/node_modules/vscode-regexpp/https:/...,
			// если прокси/фолбек не сработали.
			return serveError(req, res, 404, "Not Found");
		}

		if (
			await this._tryHandleWebviewResourceProxy(
				req,
				res,
				normalizedPathname,
				req.url ?? "",
			)
		) {
			return;
		}

		if (
			normalizedPathname.startsWith(WEBVIEW_PRE_ROOT) &&
			!normalizedPathname.startsWith(WEBVIEW_RESOURCE_PROXY_PREFIX)
		) {
			const relativeSegmentRaw = normalizedPathname.slice(WEBVIEW_PRE_ROOT.length);
			if (relativeSegmentRaw) {
				const rawWithoutResourcePrefix = relativeSegmentRaw.startsWith("resource/")
					? relativeSegmentRaw.slice("resource/".length)
					: relativeSegmentRaw;
				const strippedRelative = this._normalizeMalformedRemoteTarget(rawWithoutResourcePrefix);

				const routeKey = normalizedPathname.slice(
					0,
					Math.max(
						normalizedPathname.lastIndexOf("/"),
						WEBVIEW_RESOURCE_PROXY_PREFIX.length,
					),
				);
				const requestQuery = (() => {
					if (!req.url) {
						return "";
					}
					try {
						const parsed = new URL(req.url, "https://placeholder");
						return parsed.search.replace(/^\?/, "");
					} catch {
						return "";
					}
				})();

				const resolveAndValidate = async (
					target:
						| { path: string; scheme: string; authority: string }
						| undefined,
				): Promise<
					{ path: string; scheme: string; authority: string } | undefined
				> => {
					if (!target) {
						return undefined;
					}

					// Если сегмент выглядит как абсолютный URL/путь, пробуем через proxy-резолвер до статических путей.
					if (rawWithoutResourcePrefix && /:\/\//.test(rawWithoutResourcePrefix)) {
						const proxyTarget = resolveWebviewResourceProxyTarget(
							rawWithoutResourcePrefix,
							requestQuery,
							this._debugLogger,
						);
						if (proxyTarget && proxyTarget.path && this._isAllowedWebviewResourcePath(proxyTarget.path)) {
							const normalizedProxy = normalize(proxyTarget.path);
							if (await this._fileExists(normalizedProxy)) {
								return {
									...proxyTarget,
									path: normalizedProxy,
								};
							}
						}
					}

					const normalizedCandidatePath = normalize(target.path);
					if (!this._isAllowedWebviewResourcePath(normalizedCandidatePath)) {
						return undefined;
					}
					if (!(await this._fileExists(normalizedCandidatePath))) {
						this._debugLogger?.(
							`[WebClientServer][debug] webview pre candidate missing: ${normalizedCandidatePath}`,
						);
						return undefined;
					}
					return {
						...target,
						path: normalizedCandidatePath,
					};
				};

				// Если пришёл уже абсолютный путь (после нормализации кривого vscode-remote URL), пробуем отдать напрямую.
				if (strippedRelative.startsWith("/")) {
					const absCandidate = await resolveAndValidate({
						scheme: Schemas.file,
						authority: "",
						path: strippedRelative,
					});
					if (absCandidate) {
						await serveFile(
							absCandidate.path,
							this._environmentService.isBuilt
								? CacheControl.NO_EXPIRY
								: CacheControl.ETAG,
							this._logService,
							req,
							res,
							headers,
						);
						return;
					}
				}

				let candidate = await resolveAndValidate(
					this._resolveRelativeWebviewResource(
						req,
						normalizedPathname,
						strippedRelative,
					),
				);
				if (!candidate) {
					candidate = await resolveAndValidate(
						await this._resolveExtensionResource(
							strippedRelative,
							routeKey,
							requestQuery,
							req.url ?? "",
							req.headers.referer,
						),
					);
				}
				if (!candidate) {
					const baseName = posix.basename(strippedRelative);
					const extensionMatch = await this._findExtensionResourceByBasename(
						baseName,
					);
					if (extensionMatch) {
						candidate = await resolveAndValidate({
							path: extensionMatch,
							scheme: Schemas.file,
							authority: "",
						});
					}
				}
				if (!candidate) {
					const serverMatch = await this._findServerResourceByBasename(
						posix.basename(strippedRelative),
					);
					if (serverMatch) {
						candidate = await resolveAndValidate({
							path: serverMatch,
							scheme: Schemas.file,
							authority: "",
						});
					}
				}
				if (candidate) {
					this._rememberWebviewResourceRoute(
						routeKey,
						{
							scheme: candidate.scheme,
							authority: candidate.authority,
							path: candidate.path,
						},
						requestQuery,
						req.headers.referer,
					);
					await serveFile(
						candidate.path,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
					return;
				}
				// Last-resort direct basename search for pre/resource/* requests.
				const basename = posix.basename(strippedRelative);
				if (basename) {
					const alt = await this._findExtensionResourceByBasename(basename);
					if (alt && (await this._fileExists(alt))) {
						const normalizedAlt = normalize(alt);
						await serveFile(
							normalizedAlt,
							this._environmentService.isBuilt
								? CacheControl.NO_EXPIRY
								: CacheControl.ETAG,
							this._logService,
							req,
							res,
							headers,
						);
						return;
					}
					const serverAlt = await this._findServerResourceByBasename(basename);
					if (serverAlt && (await this._fileExists(serverAlt))) {
						const normalizedAlt = normalize(serverAlt);
						await serveFile(
							normalizedAlt,
							this._environmentService.isBuilt
								? CacheControl.NO_EXPIRY
								: CacheControl.ETAG,
							this._logService,
							req,
							res,
							headers,
						);
						return;
					}
				}
			}
		}

		// Перед тем как опускаться в общий статический поиск, попробуем вытащить любой вложенный vscode-remote+ сегмент и проксировать его.
		const embeddedRemote = this._extractEmbeddedRemoteUrl(normalizedPathname);
		if (embeddedRemote) {
			const proxyTarget = resolveWebviewResourceProxyTarget(
				embeddedRemote,
				requestQuery,
				this._debugLogger,
			);
			if (
				proxyTarget &&
				proxyTarget.path &&
				this._isAllowedWebviewResourcePath(proxyTarget.path)
			) {
				const normalizedProxyPath = normalize(proxyTarget.path);
				if (await this._fileExists(normalizedProxyPath)) {
					this._debugLogger?.(
						`[WebClientServer][debug] embedded remote path -> ${normalizedProxyPath}`,
					);
					return serveFile(
						normalizedProxyPath,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
				}
			}
			const fallbackPath = this._extractRegexppFsPath(embeddedRemote);
			if (
				fallbackPath &&
				this._isAllowedWebviewResourcePath(fallbackPath) &&
				(await this._fileExists(fallbackPath))
			) {
				this._debugLogger?.(
					`[WebClientServer][debug] embedded remote fallback -> ${fallbackPath}`,
				);
				return serveFile(
					fallbackPath,
					this._environmentService.isBuilt
						? CacheControl.NO_EXPIRY
						: CacheControl.ETAG,
					this._logService,
					req,
					res,
					headers,
				);
			}
			this._debugLogger?.(
				`[WebClientServer][debug] embedded remote unresolved, returning 404`,
			);
			return serveError(req, res, 404, "Not Found");
		}

		// Глобальный fallback по basename перед статическим поиском (если предыдущие ветки не сработали).
		const simpleBasename = lookupBasename(normalizedPathname);
		if (simpleBasename && simpleBasename.includes(".")) {
			for (const basename of getAlternateBasenames(simpleBasename)) {
				const extMatch = await this._findExtensionResourceByBasename(basename);
				const serverMatch = extMatch
					? undefined
					: await this._findServerResourceByBasename(basename);
				const candidate = extMatch ?? serverMatch;
				if (
					candidate &&
					this._isAllowedWebviewResourcePath(candidate) &&
					(await this._fileExists(candidate))
				) {
					this._logService.info(
						`[WebClientServer] basename fallback hit -> ${candidate} (request=${normalizedPathname})`,
					);
					return serveFile(
						candidate,
						this._environmentService.isBuilt
							? CacheControl.NO_EXPIRY
							: CacheControl.ETAG,
						this._logService,
						req,
						res,
						headers,
					);
				}
			}
		}

		const candidatePaths: string[] = [];
		const addCandidate = (base: string, rel: string) => {
			const full = normalize(join(base, rel));
			if (isEqualOrParent(full, base, !isLinux)) {
				candidatePaths.push(full);
			}
		};

		addCandidate(APP_ROOT, normalizedPathname);

		const runtimeRoot =
			normalize(process.env.OPENVSCODE_RUNTIME_ROOT ?? "/home/openvscode-server");
		if (normalizedPathname.startsWith("static/")) {
			addCandidate(runtimeRoot, normalizedPathname);
		}
		if (normalizedPathname.startsWith("out/")) {
			addCandidate(runtimeRoot, normalizedPathname);
			addCandidate(join(runtimeRoot, "static"), normalizedPathname);
			addCandidate(APP_ROOT, join("static", normalizedPathname));
		}
		if (normalizedPathname.toLowerCase().endsWith("codicon.ttf")) {
			addCandidate(runtimeRoot, "static/out/media/codicon.ttf");
			addCandidate(APP_ROOT, "static/out/media/codicon.ttf");
		}

		let normalizedFilePath: string | undefined;
		for (const candidate of candidatePaths) {
			try {
				const stat = await promises.stat(candidate);
				if (stat.isFile()) {
					normalizedFilePath = candidate;
					break;
				}
			} catch {
				continue;
			}
		}

		if (!normalizedFilePath) {
			this._logService.warn(
				`[WebClientServer] static miss for ${normalizedPathname}; candidates=${candidatePaths.join(",")}`,
			);
			return serveError(req, res, 404, `Not found`);
		}

		const requestOriginHeader = req.headers.origin;
		const allowRequestOrigin =
			typeof requestOriginHeader === "string" &&
			isAllowedStaticCdnOrigin(requestOriginHeader, this._logService);
		if (allowRequestOrigin) {
			headers["Access-Control-Allow-Origin"] = requestOriginHeader;
			headers["Vary"] = headers["Vary"]
				? `${headers["Vary"]}, Origin`
				: "Origin";
			this._debugLogger?.(
				`[WebClientServer] Serving static ${req.method} ${req.url} with CORS origin ${requestOriginHeader}`,
			);
		}

		if (req.method?.toUpperCase() === "OPTIONS") {
			if (!allowRequestOrigin) {
				res.writeHead(403);
				return void res.end();
			}
			const preflightHeaders: Record<string, string> = Object.create(null);
			preflightHeaders["Access-Control-Allow-Origin"] = requestOriginHeader!;
			preflightHeaders["Access-Control-Allow-Private-Network"] = "true";
			preflightHeaders["Access-Control-Allow-Methods"] = "GET, OPTIONS";
			preflightHeaders["Vary"] = "Origin";
			const requestedHeaders = req.headers["access-control-request-headers"];
			if (typeof requestedHeaders === "string" && requestedHeaders.length > 0) {
				preflightHeaders["Access-Control-Allow-Headers"] = requestedHeaders;
			} else if (Array.isArray(requestedHeaders) && requestedHeaders.length) {
				preflightHeaders["Access-Control-Allow-Headers"] =
					requestedHeaders.join(", ");
			}
			res.writeHead(204, preflightHeaders);
			return void res.end();
		}

		if (
			normalizedPathname ===
			"out/vs/workbench/contrib/webview/browser/pre/index.html"
		) {
			return this._serveWebviewPreIndex(
				normalizedFilePath,
				this._environmentService.isBuilt
					? CacheControl.NO_EXPIRY
					: CacheControl.ETAG,
				req,
				res,
				headers,
			);
		}

		return serveFile(
			normalizedFilePath,
			this._environmentService.isBuilt
				? CacheControl.NO_EXPIRY
				: CacheControl.ETAG,
			this._logService,
			req,
			res,
			headers,
		);
	}

	private async _handleVSCodeRemoteResource(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		parsedUrl: url.UrlWithParsedQuery,
	): Promise<void> {
		const rawPathParam = parsedUrl.query["path"];
		const resourcePath = typeof rawPathParam === "string" ? rawPathParam : undefined;
		if (!resourcePath) {
			return serveError(req, res, 400, "Missing path");
		}

		let decodedPath: string;
		try {
			decodedPath = decodeURIComponent(resourcePath);
		} catch {
			return serveError(req, res, 400, "Malformed path");
		}

		if (!decodedPath || decodedPath.includes("\0")) {
			return serveError(req, res, 400, "Invalid path");
		}

		if (/^file:/i.test(decodedPath)) {
			try {
				const fileUrl = new URL(decodedPath);
				decodedPath = fileUrl.pathname || decodedPath;
			} catch {
				// keep original decodedPath
			}
		}

		const normalizedPath = normalize(decodedPath);
		const looksSafe =
			normalizedPath.startsWith(posix.sep) &&
			!normalizedPath.includes("..") &&
			!normalizedPath.includes("\0");
		if (!looksSafe) {
			return serveError(req, res, 403, "Forbidden");
		}

		const headers: Record<string, string> = Object.create(null);
		return serveFile(
			normalizedPath,
			this._environmentService.isBuilt ? CacheControl.NO_EXPIRY : CacheControl.ETAG,
			this._logService,
			req,
			res,
			headers,
		);
	}

	private async _tryHandleWebviewResourceProxy(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		normalizedPathname: string,
		originalUrl: string,
	): Promise<boolean> {
		if (!normalizedPathname.startsWith(WEBVIEW_RESOURCE_PROXY_PREFIX)) {
			return false;
		}

		const method = req.method?.toUpperCase();
		if (method && method !== "GET" && method !== "HEAD") {
			return false;
		}

		const encodedTarget = normalizedPathname.slice(
			WEBVIEW_RESOURCE_PROXY_PREFIX.length,
		);
		const routeKey = normalizedPathname.slice(
			0,
			Math.max(
				normalizedPathname.lastIndexOf("/"),
				WEBVIEW_RESOURCE_PROXY_PREFIX.length,
			),
		);

		let requestQuery = "";
		try {
			const parsed = new URL(originalUrl, "https://placeholder");
			requestQuery = parsed.search.replace(/^\?/, "");
		} catch {
			requestQuery = "";
		}

		const target = resolveWebviewResourceProxyTarget(
			encodedTarget,
			requestQuery,
			this._debugLogger,
		);
		this._debugLogger?.(
			`[WebClientServer][debug] initial target for ${encodedTarget}: ${target ? `${target.scheme}://${target.authority}${target.path}` : "undefined"}`,
		);
		let resolvedTarget = target;
		const refererHeader = req.headers.referer;

		if (!resolvedTarget) {
			if (refererHeader) {
				try {
					const refererUrl = new URL(refererHeader);
					this._debugLogger?.(
						`[WebClientServer][debug] referer=${refererUrl.toString()}`,
					);
					const refererPathname = decodeURIComponent(
						refererUrl.pathname,
					).replace(/^\/+/, "");
					let refererEncodedTarget: string | undefined;
					if (refererPathname.startsWith("oss-")) {
						const firstSlash = refererPathname.indexOf("/");
						if (firstSlash !== -1) {
							const refererTrimmed = refererPathname.slice(firstSlash + 1);
							if (refererTrimmed.startsWith("static/")) {
								refererEncodedTarget = refererTrimmed.slice("static/".length);
							}
						}
					} else {
						refererEncodedTarget = refererPathname;
					}
					if (
						refererEncodedTarget &&
						refererEncodedTarget.startsWith(WEBVIEW_RESOURCE_PROXY_PREFIX)
					) {
						const refererTarget = resolveWebviewResourceProxyTarget(
							refererEncodedTarget.slice(WEBVIEW_RESOURCE_PROXY_PREFIX.length),
							refererUrl.search,
							this._debugLogger,
						);
						if (
							refererTarget &&
							(refererTarget.scheme === Schemas.vscodeRemote ||
								refererTarget.scheme === Schemas.file)
						) {
							this._debugLogger?.(
								`[WebClientServer][debug] referer target=${refererTarget.scheme}://${refererTarget.authority}${refererTarget.path}`,
							);
							const baseDir = posix.dirname(refererTarget.path);
							const relativeSegment = decodeComponentMulti(encodedTarget);
							const sanitizedRelative = (() => {
								if (relativeSegment.includes("\0")) {
									return undefined;
								}
								const withoutQuery = relativeSegment.replace(/[?#].*$/, "");
								const trimmed = withoutQuery.replace(/^[\\/]+/, "");
								return trimmed;
							})();
							if (sanitizedRelative) {
								const candidatePath = normalize(
									posix.join(baseDir, sanitizedRelative),
								);
								resolvedTarget = {
									scheme: refererTarget.scheme,
									authority: refererTarget.authority,
									path: candidatePath,
									query: "",
								};
								this._debugLogger?.(
									`[WebClientServer][debug] resolved via referer -> ${resolvedTarget.scheme}://${resolvedTarget.authority}${resolvedTarget.path}`,
								);
							}
						}
					}
				} catch (error) {
					this._debugLogger?.(
						`[WebClientServer][debug] failed to parse referer ${refererHeader}: ${error}`,
					);
				}
			}
		}

		if (!resolvedTarget) {
			const hint = this._getWebviewResourceHint(
				routeKey,
				requestQuery,
				refererHeader,
			);
			if (hint) {
				const relativeSegment = decodeComponentMulti(encodedTarget);
				if (!relativeSegment.includes("\0")) {
					const candidatePath = normalize(
						posix.join(hint.directory, relativeSegment),
					);
					resolvedTarget = {
						scheme: hint.scheme,
						authority: hint.authority,
						path: candidatePath,
						query: "",
					};
					this._debugLogger?.(
						`[WebClientServer][debug] resolved via cached hint -> ${resolvedTarget.scheme}://${resolvedTarget.authority}${resolvedTarget.path}`,
					);
				}
			}
		}

		if (!resolvedTarget) {
			const fallback = this._resolveRelativeWebviewResource(
				req,
				normalizedPathname,
				encodedTarget,
			);
			if (fallback) {
				const candidatePath = normalize(fallback.path);
				resolvedTarget = {
					scheme: fallback.scheme,
					authority: fallback.authority,
					path: candidatePath,
					query: "",
				};
				this._debugLogger?.(
					`[WebClientServer][debug] resolved via relative fallback -> ${resolvedTarget.scheme}://${resolvedTarget.authority}${resolvedTarget.path}`,
				);
			}
		}

		if (!resolvedTarget) {
			const extensionFallback = await this._resolveExtensionResource(
				encodedTarget,
				routeKey,
				requestQuery,
				req.url ?? "",
				req.headers.referer,
			);
			if (extensionFallback) {
				const candidatePath = normalize(extensionFallback.path);
				resolvedTarget = {
					scheme: extensionFallback.scheme,
					authority: extensionFallback.authority,
					path: candidatePath,
					query: "",
				};
				this._debugLogger?.(
					`[WebClientServer][debug] resolved via extension fallback -> ${resolvedTarget.scheme}://${resolvedTarget.authority}${resolvedTarget.path}`,
				);
			}
		}

		if (!resolvedTarget) {
			const extensionId = this._extractExtensionIdFromRequest(
				originalUrl,
				refererHeader,
			);
			const basenameCandidates = getAlternateBasenames(encodedTarget);
			if (extensionId) {
				for (const basename of basenameCandidates) {
					if (!basename) {
						continue;
					}
					const extMatch = await this._findExtensionResourceByBasenameWithin(
						extensionId,
						basename,
					);
					if (extMatch) {
						resolvedTarget = {
							scheme: Schemas.file,
							authority: "",
							path: normalize(extMatch),
							query: "",
						};
						this._debugLogger?.(
							`[WebClientServer][debug] resolved via extensionId/basename ${extensionId} -> ${resolvedTarget.path}`,
						);
						break;
					}
				}
			}
		}

		// Последний шанс: поиск по basename среди всех расширений/серверных ассетов.
		if (!resolvedTarget) {
			for (const basename of getAlternateBasenames(encodedTarget)) {
				if (!basename) {
					continue;
				}
				const globalExtMatch = await this._findExtensionResourceByBasename(
					basename,
				);
				if (globalExtMatch) {
					resolvedTarget = {
						scheme: Schemas.file,
						authority: "",
						path: normalize(globalExtMatch),
						query: "",
					};
					this._debugLogger?.(
						`[WebClientServer][debug] resolved via global extension basename -> ${resolvedTarget.path}`,
					);
					break;
				}
				const globalServerMatch =
					await this._findServerResourceByBasename(basename);
				if (globalServerMatch) {
					resolvedTarget = {
						scheme: Schemas.file,
						authority: "",
						path: normalize(globalServerMatch),
						query: "",
					};
					this._debugLogger?.(
						`[WebClientServer][debug] resolved via global server basename -> ${resolvedTarget.path}`,
					);
					break;
				}
			}
		}

		if (!resolvedTarget) {
			this._debugLogger?.(
				`[WebClientServer][debug] unable to resolve target for ${encodedTarget}`,
			);
			return false;
		}

		if (
			resolvedTarget.scheme !== Schemas.vscodeRemote &&
			resolvedTarget.scheme !== Schemas.file
		) {
			this._debugLogger?.(
				`[WebClientServer][debug] unsupported scheme ${resolvedTarget.scheme}`,
			);
			return false;
		}

		if (!resolvedTarget.path) {
			this._debugLogger?.("[WebClientServer][debug] missing path");
			return false;
		}

		if (!this._isAllowedWebviewResourcePath(resolvedTarget.path)) {
			this._debugLogger?.(
				`[WebClientServer][debug] denied access to ${resolvedTarget.path}`,
			);
			return false;
		}

		const responseHeaders: Record<string, string> = Object.create(null);
		const requestOriginHeader = req.headers.origin;
		const allowRequestOrigin =
			typeof requestOriginHeader === "string" &&
			isAllowedStaticCdnOrigin(requestOriginHeader, this._logService);
		if (allowRequestOrigin) {
			responseHeaders["Access-Control-Allow-Origin"] = requestOriginHeader!;
			responseHeaders["Vary"] = "Origin";
		}

		const normalizedFilePath = normalize(resolvedTarget.path);
		this._debugLogger?.(
			`[WebClientServer][debug] normalized path ${normalizedFilePath}`,
		);

		let targetForCache: { scheme: string; authority: string; path: string; query: string } = {
			scheme: resolvedTarget.scheme,
			authority: resolvedTarget.authority,
			path: resolvedTarget.path,
			query: resolvedTarget.query,
		};
		let pathToServe = normalizedFilePath;
		if (!(await this._fileExists(pathToServe))) {
			let fallbackResolved: string | undefined;
			for (const basename of getAlternateBasenames(pathToServe)) {
				const extMatch = await this._findExtensionResourceByBasename(basename);
				if (
					extMatch &&
					this._isAllowedWebviewResourcePath(extMatch) &&
					(await this._fileExists(extMatch))
				) {
					fallbackResolved = normalize(extMatch);
					this._debugLogger?.(
						`[WebClientServer][debug] proxy fallback via extension basename -> ${fallbackResolved}`,
					);
					break;
				}
				const serverMatch = await this._findServerResourceByBasename(basename);
				if (
					serverMatch &&
					this._isAllowedWebviewResourcePath(serverMatch) &&
					(await this._fileExists(serverMatch))
				) {
					fallbackResolved = normalize(serverMatch);
					this._debugLogger?.(
						`[WebClientServer][debug] proxy fallback via server asset basename -> ${fallbackResolved}`,
					);
					break;
				}
			}

			if (fallbackResolved) {
				pathToServe = fallbackResolved;
				targetForCache = {
					scheme: Schemas.file,
					authority: "",
					path: pathToServe,
					query: "",
				};
			} else {
				this._debugLogger?.(
					`[WebClientServer][debug] proxy target missing: ${pathToServe}`,
				);
			}
		}

		this._rememberWebviewResourceRoute(
			routeKey,
			targetForCache,
			requestQuery,
			refererHeader,
		);

		this._logService.debug(
			`[WebClientServer] webview resource proxy: serving ${targetForCache.scheme}://${targetForCache.authority}${targetForCache.path}`,
		);

		await serveFile(
			pathToServe,
			this._environmentService.isBuilt
				? CacheControl.NO_EXPIRY
				: CacheControl.ETAG,
			this._logService,
			req,
			res,
			responseHeaders,
		);
		return true;
	}

	private _isAllowedWebviewResourcePath(candidate: string): boolean {
		const normalized = normalize(candidate);
		const allowedRoots: string[] = [];
		if (this._environmentService.extensionsPath) {
			allowedRoots.push(normalize(this._environmentService.extensionsPath));
		}
		allowedRoots.push(RUNTIME_ROOT);
		const homeEnv = process.env.HOME;
		if (homeEnv) {
			allowedRoots.push(
				normalize(join(homeEnv, ".openvscode-server", "extensions")),
			);
		}
		// Runtime extensions folder (default install location)
		allowedRoots.push(normalize(join(RUNTIME_ROOT, "extensions")));
		// Some deployments do not populate extensionsPath; allow the default
		// .openvscode-server/extensions location as a fallback so webviews can
		// serve their static assets.
		allowedRoots.push(
			normalize(
				join(APP_ROOT, ".openvscode-server", "extensions"),
			),
		);
		allowedRoots.push(
			normalize(join(RUNTIME_ROOT, ".openvscode-server", "extensions")),
		);
		if (this._environmentService.builtinExtensionsPath) {
			allowedRoots.push(
				normalize(this._environmentService.builtinExtensionsPath),
			);
		}
		const globalStorageFsPath =
			this._environmentService.globalStorageHome?.fsPath ??
			(this._environmentService.userDataPath
				? join(this._environmentService.userDataPath, "User", "globalStorage")
				: undefined);
		if (globalStorageFsPath) {
			allowedRoots.push(normalize(globalStorageFsPath));
		}
		const workspaceStorageFsPath =
			this._environmentService.workspaceStorageHome?.fsPath ??
			(this._environmentService.userDataPath
				? join(
						this._environmentService.userDataPath,
						"User",
						"workspaceStorage",
					)
				: undefined);
		if (workspaceStorageFsPath) {
			allowedRoots.push(normalize(workspaceStorageFsPath));
		}
		const allowed = allowedRoots.some((root) =>
			isEqualOrParent(normalized, root, !isLinux),
		);
		if (!allowed) {
			this._debugLogger?.(
				`[WebClientServer][debug] deny resource path ${normalized}; allowed roots:`,
				allowedRoots,
			);
		}
		return allowed;
	}

	private _rememberWebviewResourceRoute(
		routeKey: string,
		target: { scheme: string; authority: string; path: string },
		requestQuery: string | undefined,
		refererHeader: string | undefined,
	): void {
		try {
			const directory = normalize(posix.dirname(target.path));
			this._webviewResourceRoots.set(routeKey, {
				scheme: target.scheme,
				authority: target.authority,
				directory,
			});
			this._debugLogger?.(
				`[WebClientServer][debug] cache route ${routeKey} -> dir ${directory}`,
			);

			const resourceIndex = routeKey.indexOf("/resource");
			if (resourceIndex !== -1) {
				const baseRouteKey = routeKey.slice(0, resourceIndex);
				if (!this._webviewResourceRoots.has(baseRouteKey)) {
					this._webviewResourceRoots.set(baseRouteKey, {
						scheme: target.scheme,
						authority: target.authority,
						directory,
					});
					this._debugLogger?.(
						`[WebClientServer][debug] cache base route ${baseRouteKey} -> dir ${directory}`,
					);
				}
			}

			const webviewId = this._extractWebviewId(
				routeKey,
				requestQuery,
				refererHeader,
			);
			if (webviewId) {
				this._webviewResourceRootsById.set(webviewId, {
					scheme: target.scheme,
					authority: target.authority,
					directory,
				});
				this._debugLogger?.(
					`[WebClientServer][debug] cache webviewId ${webviewId} -> dir ${directory}`,
				);
			}
		} catch {
			// ignore caching issues
		}
	}

	private _extractWebviewId(
		routeKey: string,
		requestQuery?: string,
		refererHeader?: string,
	): string | undefined {
		if (requestQuery) {
			try {
				const search = new URLSearchParams(requestQuery);
				const id = search.get("id");
				if (id) {
					return id;
				}
			} catch {
				// ignore malformed query strings
			}
		}

		if (refererHeader) {
			try {
				const refererUrl = new URL(refererHeader);
				const id = refererUrl.searchParams.get("id");
				if (id) {
					return id;
				}
			} catch {
				// ignore malformed referer
			}
		}

		const resourceIndex = routeKey.indexOf("/resource/");
		if (resourceIndex !== -1) {
			const remainder = routeKey.slice(resourceIndex + "/resource/".length);
			const slashIndex = remainder.indexOf("/");
			if (slashIndex !== -1) {
				const possibleId = remainder.slice(0, slashIndex);
				if (possibleId) {
					return possibleId;
				}
			}
		}

		return undefined;
	}

	private _getWebviewResourceHint(
		routeKey: string,
		requestQuery: string | undefined,
		refererHeader: string | undefined,
	): { scheme: string; authority: string; directory: string } | undefined {
		const preBaseRoute =
			WEBVIEW_PRE_ROOT.endsWith("/")
				? WEBVIEW_PRE_ROOT.slice(0, -1)
				: WEBVIEW_PRE_ROOT;

		let hint = this._webviewResourceRoots.get(routeKey);
		if (!hint) {
			const resourceIndex = routeKey.indexOf("/resource");
			if (resourceIndex !== -1) {
				const baseRouteKey = routeKey.slice(0, resourceIndex);
				hint = this._webviewResourceRoots.get(baseRouteKey);
			}
		}

		if (
			!hint &&
			(routeKey === preBaseRoute || routeKey.startsWith(`${preBaseRoute}/`))
		) {
			let candidateRoute = routeKey;
			while (!hint) {
				const lastSlash = candidateRoute.lastIndexOf("/");
				if (lastSlash <= preBaseRoute.length) {
					break;
				}
				candidateRoute = candidateRoute.slice(0, lastSlash);
				hint = this._webviewResourceRoots.get(candidateRoute);
			}

			if (!hint) {
				hint =
					this._webviewResourceRoots.get(preBaseRoute) ??
					this._webviewResourceRoots.get(WEBVIEW_PRE_ROOT);
			}

			if (hint) {
				this._debugLogger?.(
					`[WebClientServer][debug] using fallback hint ${candidateRoute} -> ${hint.directory}`,
				);
			}
		}

		if (!hint) {
			const webviewId = this._extractWebviewId(
				routeKey,
				requestQuery,
				refererHeader,
			);
			if (webviewId) {
				hint = this._webviewResourceRootsById.get(webviewId);
				if (hint) {
					this._debugLogger?.(
						`[WebClientServer][debug] using hint from webviewId ${webviewId} -> ${hint.directory}`,
					);
				} else {
					this._debugLogger?.(
						`[WebClientServer][debug] no hint found for webviewId ${webviewId}`,
					);
				}
			}
		}

		if (!hint) {
			this._debugLogger?.(
				`[WebClientServer][debug] no cached resource root for routeKey=${routeKey}`,
			);
		}

		return hint;
	}

	private _resolveRelativeWebviewResource(
		req: http.IncomingMessage,
		normalizedPathname: string,
		relativeSegmentRaw: string,
	): { path: string; scheme: string; authority: string } | undefined {
		const lastSlash = normalizedPathname.lastIndexOf("/");
		const routeKey =
			lastSlash === -1
				? normalizedPathname
				: normalizedPathname.slice(0, lastSlash);

		let requestQuery = "";
		try {
			const parsed = new URL(req.url ?? "", "https://placeholder");
			requestQuery = parsed.search.replace(/^\?/, "");
		} catch {
			requestQuery = "";
		}

		const hint = this._getWebviewResourceHint(
			routeKey,
			requestQuery,
			req.headers.referer,
		);
		if (!hint) {
			this._debugLogger?.(
				`[WebClientServer][debug] no hint available for relative resource ${relativeSegmentRaw} (routeKey=${routeKey})`,
			);
			return undefined;
		}

		const relativeSegment = decodeComponentMulti(relativeSegmentRaw);
		if (relativeSegment.includes("\0")) {
			return undefined;
		}

		const candidatePath = normalize(
			posix.join(hint.directory, relativeSegment),
		);
		this._debugLogger?.(
			`[WebClientServer][debug] resolved relative resource ${relativeSegmentRaw} -> ${candidatePath}`,
		);
		return {
			path: candidatePath,
			scheme: hint.scheme,
			authority: hint.authority,
		};
	}

	private async _resolveExtensionResource(
		relativeSegmentRaw: string,
		routeKey: string,
		requestQuery: string | undefined,
		requestUrl: string,
		refererHeader: string | undefined,
	): Promise<{ path: string; scheme: string; authority: string } | undefined> {
		const relativeSegment = decodeComponentMulti(relativeSegmentRaw);
		if (!relativeSegment || relativeSegment.includes("\0")) {
			return undefined;
		}

		const sanitizedSegment = relativeSegment.replace(/^[\\/]+/, "");
		if (!sanitizedSegment) {
			return undefined;
		}

		const queryIndex = Math.min(
			...["?", "#"]
				.map((ch) => sanitizedSegment.indexOf(ch))
				.filter((idx) => idx >= 0),
		);
		const sanitizedPath =
			queryIndex >= 0 ? sanitizedSegment.slice(0, queryIndex) : sanitizedSegment;

		if (!sanitizedPath) {
			return undefined;
		}
		const baseName = posix.basename(sanitizedPath);

		const expandAlternativePaths = (baseDir: string, target: string): string[] => {
			const alternatives: string[] = [];
			const parentDir = posix.dirname(target);

			if (baseName === "codicon.ttf" && !target.includes("/fonts/")) {
				alternatives.push(posix.join(parentDir, "fonts", baseName));
			}

			const tryMap = (fromExt: string, toExt: string) => {
				if (baseName.endsWith(fromExt)) {
					alternatives.push(posix.join(parentDir, baseName.slice(0, -fromExt.length) + toExt));
				}
			};
			tryMap(".map.json", ".js.map");
			tryMap(".sourcemap", ".js.map");

			return alternatives
				.map((alt) => normalize(posix.join(baseDir, alt)))
				.filter((alt, idx, arr) => arr.indexOf(alt) === idx);
		};

		const placeholderCandidates: string[] = [];
		const lowerBase = baseName.toLowerCase();
		if (lowerBase === "index.html" || lowerBase === "fake.html" || lowerBase === "service-worker.js") {
			const pushPre = (base: string) => {
				const preRoot = posix.join(
					base,
					"static/out/vs/workbench/contrib/webview/browser/pre",
				);
				placeholderCandidates.push(normalize(posix.join(preRoot, sanitizedPath)));
				if (sanitizedPath !== baseName) {
					placeholderCandidates.push(normalize(posix.join(preRoot, baseName)));
				}
			};
			pushPre(RUNTIME_ROOT);
			pushPre(APP_ROOT);
		}

		const refererHint = this._getDirectoryFromReferer(refererHeader);
		const fallbackHint =
			refererHint ?? this._getDirectoryFromRequest(requestUrl);
			const tryFallbacks = async (): Promise<
				{ path: string; scheme: string; authority: string } | undefined
			> => {
				const alternativeCandidates = (
					baseDir: string,
					target: string,
				): string[] => {
					const basenames = new Set<string>();
					const parentDir = posix.dirname(target);
					const baseName = posix.basename(target);

					if (baseName === "codicon.ttf" && !target.includes("/fonts/")) {
						basenames.add(posix.join(parentDir, "fonts", baseName));
					}

					const remap = (from: string, to: string) => {
						if (baseName.endsWith(from)) {
							basenames.add(
								posix.join(parentDir, baseName.slice(0, -from.length) + to),
							);
						}
					};
					remap(".map.json", ".js.map");
					remap(".sourcemap", ".js.map");

					return Array.from(basenames).map((p) => normalize(posix.join(baseDir, p)));
				};

				const extensionId = this._extractExtensionIdFromRequest(
					requestUrl,
					refererHeader,
				);
				const derivedExtensionId =
					extensionId ??
					this._guessExtensionIdFromPath(sanitizedPath) ??
					this._guessExtensionIdFromPath(requestUrl) ??
					this._guessExtensionIdFromPath(refererHeader ?? "");
				if (derivedExtensionId) {
					const extensionRoot = await this._findExtensionRoot(derivedExtensionId);
					if (extensionRoot) {
						const guessed = [
							normalize(posix.join(extensionRoot, sanitizedPath)),
							...alternativeCandidates(extensionRoot, sanitizedPath),
						];
						for (const guessedPath of guessed) {
							if (!(await this._fileExists(guessedPath))) {
								this._debugLogger?.(
									`[WebClientServer][debug] guessed path missing for ${extensionId}: ${guessedPath}`,
								);
								continue;
							}
							this._debugLogger?.(
								`[WebClientServer][debug] resolved via extension lookup ${extensionId} -> ${guessedPath}`,
							);
							return {
								path: guessedPath,
								scheme: Schemas.file,
								authority: "",
							};
						}
					} else {
						this._debugLogger?.(
							`[WebClientServer][debug] no extension root found for ${extensionId}`,
						);
					}
				} else {
					this._debugLogger?.(
						`[WebClientServer][debug] no extensionId for ${relativeSegmentRaw}, skip global basename lookup`,
					);
				}

			const tried = new Set<string>();
			for (const hint of this._webviewResourceRoots.values()) {
				if (tried.has(hint.directory)) {
					continue;
				}
				tried.add(hint.directory);
				const candidatePath = normalize(
					posix.join(hint.directory, sanitizedPath),
				);
				if (!this._isAllowedWebviewResourcePath(candidatePath)) {
					continue;
				}
				if (await this._fileExists(candidatePath)) {
					this._debugLogger?.(
						`[WebClientServer][debug] resolved via cached root ${hint.directory} -> ${candidatePath}`,
					);
					return {
						path: candidatePath,
						scheme: hint.scheme,
						authority: hint.authority,
					};
				}
			}
			for (const placeholder of placeholderCandidates) {
				if (!(await this._fileExists(placeholder))) {
					continue;
				}
				// pre assets are trusted; they live under runtime/app roots we allow below
				this._debugLogger?.(
					`[WebClientServer][debug] resolved via pre placeholder -> ${placeholder}`,
				);
				return {
					path: placeholder,
					scheme: Schemas.file,
					authority: "",
				};
			}
			const serverByBasename = await this._findServerResourceByBasename(baseName);
			if (serverByBasename) {
				return {
					path: serverByBasename,
					scheme: Schemas.file,
					authority: "",
				};
			}
			if (!derivedExtensionId) {
				const uniqueExtMatch = await this._findUniqueExtensionResourceByBasename(
					baseName,
				);
				if (uniqueExtMatch) {
					return {
						path: uniqueExtMatch,
						scheme: Schemas.file,
						authority: "",
					};
				}
			}
			return undefined;
		};

		if (!fallbackHint) {
			this._debugLogger?.(
				`[WebClientServer][debug] no directory hint for ${relativeSegmentRaw}`,
			);
			return tryFallbacks();
		}

		const candidatePath = normalize(posix.join(fallbackHint.directory, sanitizedPath));
		if (!this._isAllowedWebviewResourcePath(candidatePath)) {
			return tryFallbacks();
		}

		const candidates = [candidatePath, ...expandAlternativePaths(fallbackHint.directory, sanitizedPath)];
		for (const candidate of candidates) {
			if (!(await this._fileExists(candidate))) {
				this._debugLogger?.(
					`[WebClientServer][debug] candidate ${candidate} missing for ${relativeSegmentRaw}`,
				);
				continue;
			}

			this._rememberWebviewResourceRoute(
				routeKey,
				{
					scheme: fallbackHint.scheme,
					authority: fallbackHint.authority,
					path: candidate,
				},
				requestQuery,
				refererHeader,
			);

			this._debugLogger?.(
				`[WebClientServer][debug] resolved via referer fallback -> ${candidate}`,
			);
			return {
				path: candidate,
				scheme: fallbackHint.scheme,
				authority: fallbackHint.authority,
			};
		}

		return tryFallbacks();
	}

	private _getDirectoryFromReferer(
		refererHeader: string | undefined,
	): { directory: string; scheme: string; authority: string } | undefined {
		if (!refererHeader) {
			return undefined;
		}

		try {
			const refererUrl = new URL(refererHeader);
			let refererPath = decodeURIComponent(refererUrl.pathname).replace(
				/^\/+/,
				"",
			);
			if (refererPath.startsWith("oss-")) {
				const firstSlash = refererPath.indexOf("/");
				if (firstSlash !== -1) {
					refererPath = refererPath.slice(firstSlash + 1);
				} else {
					refererPath = "";
				}
			}
			if (refererPath.startsWith("static/")) {
				refererPath = refererPath.slice("static/".length);
			}
			if (!refererPath.startsWith(WEBVIEW_RESOURCE_PROXY_PREFIX)) {
				return undefined;
			}

			const encodedTarget = refererPath.slice(
				WEBVIEW_RESOURCE_PROXY_PREFIX.length,
			);
			const resolved = resolveWebviewResourceProxyTarget(
				encodedTarget,
				refererUrl.search,
				this._debugLogger,
			);
			if (!resolved) {
				return undefined;
			}

			return {
				directory: normalize(posix.dirname(resolved.path)),
				scheme: resolved.scheme,
				authority: resolved.authority,
			};
		} catch (error) {
			this._debugLogger?.(
				`[WebClientServer][debug] failed to derive directory from referer ${refererHeader}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	private _getDirectoryFromRequest(
		requestUrl: string,
	): { directory: string; scheme: string; authority: string } | undefined {
		if (!requestUrl) {
			return undefined;
		}

		try {
			const parsedUrl = new URL(requestUrl, "https://placeholder");
			let pathname = parsedUrl.pathname.replace(/^\/+/, "");
			if (pathname.startsWith("oss-")) {
				const firstSlash = pathname.indexOf("/");
				if (firstSlash !== -1) {
					pathname = pathname.slice(firstSlash + 1);
				} else {
					pathname = "";
				}
			}
			if (pathname.startsWith("static/")) {
				pathname = pathname.slice("static/".length);
			}
			const slashIndex = pathname.lastIndexOf("/");
			const routeKey =
				slashIndex === -1 ? pathname : pathname.slice(0, slashIndex);
			const hint =
				this._webviewResourceRoots.get(routeKey) ??
				this._getWebviewResourceHint(
					routeKey,
					parsedUrl.search.replace(/^\?/, ""),
					undefined,
				);
			return hint;
		} catch {
			return undefined;
		}
	}

	private async _findExtensionRoot(
		extensionId: string,
	): Promise<string | undefined> {
		const searchRoots: string[] = [];
		if (this._environmentService.extensionsPath) {
			searchRoots.push(this._environmentService.extensionsPath);
		}
		if (this._environmentService.builtinExtensionsPath) {
			searchRoots.push(this._environmentService.builtinExtensionsPath);
		}

		for (const root of searchRoots) {
			try {
				const entries = await readdir(root, { withFileTypes: true });
				const matching = entries
					.filter(
						(entry) =>
							entry.isDirectory() &&
							entry.name.startsWith(`${extensionId}-`),
					)
					.map((entry) => normalize(posix.join(root, entry.name)));
				if (matching.length) {
					matching.sort();
					return matching[matching.length - 1];
				}
			} catch (error) {
				this._debugLogger?.(
					`[WebClientServer][debug] failed to scan ${root} for ${extensionId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}

		return undefined;
	}

	private _extractExtensionIdFromRequest(
		requestUrl: string | undefined,
		refererHeader: string | undefined,
	): string | undefined {
		const tryParse = (value: string | undefined): string | undefined => {
			if (!value) {
				return undefined;
			}
			try {
				const parsed = new URL(value, "https://placeholder");
				const id = parsed.searchParams.get("extensionId");
				return id ?? undefined;
			} catch {
				return undefined;
			}
		};

		return tryParse(requestUrl) ?? tryParse(refererHeader);
	}

	private async _findExtensionResourceByBasename(
		basename: string,
	): Promise<string | undefined> {
		if (!basename) {
			return undefined;
		}
		const cached = this._extensionResourceByBasename.get(basename);
		if (cached) {
			if (await this._fileExists(cached)) {
				return cached;
			}
			this._extensionResourceByBasename.delete(basename);
		}

		const candidateRoots = new Set<string>();
		if (this._environmentService.extensionsPath) {
			candidateRoots.add(this._environmentService.extensionsPath);
		}
		// Default extension install root (when extensionsPath is empty)
		candidateRoots.add(join(APP_ROOT, ".openvscode-server", "extensions"));
		candidateRoots.add(join(RUNTIME_ROOT, ".openvscode-server", "extensions"));
		const homeEnv = process.env.HOME;
		if (homeEnv) {
			candidateRoots.add(join(homeEnv, ".openvscode-server", "extensions"));
		}
		if (this._environmentService.builtinExtensionsPath) {
			candidateRoots.add(this._environmentService.builtinExtensionsPath);
		}

		const found = await this._scanForBasename(Array.from(candidateRoots), basename);
		if (found) {
			this._extensionResourceByBasename.set(basename, found);
		}
		return found ?? undefined;
	}

	private async _findUniqueExtensionResourceByBasename(
		basename: string,
	): Promise<string | undefined> {
		if (!basename) {
			return undefined;
		}
		const candidateRoots: string[] = [];
		if (this._environmentService.extensionsPath) {
			candidateRoots.push(this._environmentService.extensionsPath);
		}
		candidateRoots.push(join(APP_ROOT, ".openvscode-server", "extensions"));
		candidateRoots.push(join(RUNTIME_ROOT, ".openvscode-server", "extensions"));
		const homeEnv = process.env.HOME;
		if (homeEnv) {
			candidateRoots.push(join(homeEnv, ".openvscode-server", "extensions"));
		}

		let foundPath: string | undefined;
		for (const root of candidateRoots) {
			const resolved = await this._scanForBasename([root], basename);
			if (!resolved) {
				continue;
			}
			if (foundPath && foundPath !== resolved) {
				return undefined;
			}
			foundPath = resolved;
		}
		return foundPath;
	}

	private async _findExtensionResourceByBasenameWithin(
		extensionId: string,
		basename: string,
	): Promise<string | undefined> {
		if (!extensionId || !basename) {
			return undefined;
		}
		const extensionRoot = await this._findExtensionRoot(extensionId);
		if (!extensionRoot) {
			return undefined;
		}
		return this._scanForBasename([extensionRoot], basename);
	}

	private _extractRegexppFsPath(encoded: string): string | undefined {
		if (!encoded) {
			return undefined;
		}
		try {
			const decoded = collapseNestedRemoteUrl(
				decodeComponentMulti(encoded.replace(/https:\//g, "https://")),
			);
			const schemeIndex = decoded.indexOf("://");
			if (schemeIndex === -1) {
				return undefined;
			}
			const pathIndex = decoded.indexOf("/", schemeIndex + "://".length);
			if (pathIndex === -1) {
				return undefined;
			}
			return normalize(decoded.slice(pathIndex));
		} catch {
			return undefined;
		}
	}

	private _extractEmbeddedRemoteUrl(rawPath: string): string | undefined {
		if (!rawPath || rawPath.indexOf("vscode-remote+") === -1) {
			return undefined;
		}
		const sanitized = rawPath.replace(/https:\//g, "https://");
		const decoded = decodeComponentMulti(sanitized);
		const matches = [
			...decoded.matchAll(/https?:\/+vscode-remote\+[^/]+.*/g),
		];
		if (!matches.length) {
			return undefined;
		}
		const last = matches[matches.length - 1];
		if (typeof last.index === "number") {
			const tail = decoded.slice(last.index);
			return collapseNestedRemoteUrl(tail);
		}
		return collapseNestedRemoteUrl(last[0]);
	}

	private _normalizeMalformedRemoteTarget(relative: string): string {
		return normalizeResourceInput(relative);
	}

	private _guessExtensionIdFromPath(rawPath: string): string | undefined {
		if (!rawPath) {
			return undefined;
		}
		const decoded = decodeURIComponent(rawPath);
		const match = /(?:^|\/)extensions\/([^/]+)-\d/.exec(decoded);
		if (match && match[1]) {
			return match[1];
		}
		return undefined;
	}

	private async _findServerResourceByBasename(
		basename: string,
	): Promise<string | undefined> {
		if (!basename) {
			return undefined;
		}
		const cached = this._serverResourceByBasename.get(basename);
		if (cached !== undefined) {
			return cached ?? undefined;
		}

		const normalizeDir = (value: string): string | undefined => {
			try {
				return normalize(value);
			} catch {
				return undefined;
			}
		};

		const serverRoots: string[] = [];
		const runtimeRoot = normalize(
			process.env.OPENVSCODE_RUNTIME_ROOT ?? "/home/openvscode-server",
		);
		const maybeAdd = (dir: string | undefined) => {
			if (dir) {
				serverRoots.push(dir);
			}
		};
		maybeAdd(normalizeDir(join(runtimeRoot, "static")));
		maybeAdd(normalizeDir(join(runtimeRoot, "static", "out")));
		maybeAdd(normalizeDir(join(runtimeRoot, "out")));
		maybeAdd(normalizeDir(join(APP_ROOT, "static")));
		maybeAdd(normalizeDir(join(APP_ROOT, "static", "out")));
		maybeAdd(normalizeDir(join(APP_ROOT, "out")));

		const found = await this._scanForBasename(serverRoots, basename);
		this._serverResourceByBasename.set(basename, found ?? null);
		return found ?? undefined;
	}

	private async _scanForBasename(
		roots: string[],
		targetBasename: string,
	): Promise<string | undefined> {
		for (const root of roots) {
			const resolvedRoot = normalize(root);
			const queue: string[] = [resolvedRoot];
			while (queue.length) {
				const dir = queue.pop();
				if (!dir) {
					continue;
				}
				let entries: import("fs").Dirent[];
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					continue;
				}
				for (const entry of entries) {
					const fullPath = join(dir, entry.name);
					if (entry.isDirectory()) {
						queue.push(fullPath);
					} else if (entry.isFile() && entry.name === targetBasename) {
						return normalize(fullPath);
					}
				}
			}
		}
		return undefined;
	}

	private async _fileExists(candidate: string): Promise<boolean> {
		try {
			const stat = await promises.stat(candidate);
			return stat.isFile();
		} catch {
			return false;
		}
	}

	private async _serveWebviewPreIndex(
		filePath: string,
		cacheControl: CacheControl,
		req: http.IncomingMessage,
		res: http.ServerResponse,
		headers: Record<string, string>,
	): Promise<void> {
		let stat;
		try {
			stat = await promises.stat(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return serveError(req, res, 404, "Not found.");
			}
			this._logService.error(
				`[WebClientServer] Failed to stat webview index: ${error instanceof Error ? error.message : String(error)}`,
			);
			return serveError(req, res, 500, "Internal Server Error.");
		}

		const entry = await this._getWebviewPreIndexContent(filePath, stat.mtimeMs);
		const ifNoneMatchHeader = req.headers["if-none-match"];
		const ifNoneMatch = Array.isArray(ifNoneMatchHeader)
			? ifNoneMatchHeader[0]
			: ifNoneMatchHeader;
		if (typeof ifNoneMatch === "string" && ifNoneMatch === entry.etag) {
			res.writeHead(304);
			return void res.end();
		}

		if (cacheControl === CacheControl.NO_EXPIRY) {
			headers["Cache-Control"] = "public, max-age=31536000";
		} else if (cacheControl === CacheControl.NO_CACHING) {
			headers["Cache-Control"] = "no-store";
		}

		headers["Content-Type"] = "text/html";
		headers["Etag"] = entry.etag;

		res.writeHead(200, headers);
		if (req.method === "HEAD") {
			return void res.end();
		}

		return void res.end(entry.content);
	}

	private async _getWebviewPreIndexContent(
		filePath: string,
		mtimeMs: number,
	): Promise<{ content: string; etag: string; mtimeMs: number }> {
		const cached = this._webviewPreIndexCache;
		if (cached && cached.mtimeMs === mtimeMs) {
			return cached;
		}

		let raw: string;
		try {
			raw = (await promises.readFile(filePath)).toString();
		} catch (error) {
			this._logService.error(
				`[WebClientServer] Failed to read webview index: ${error instanceof Error ? error.message : String(error)}`,
			);
			throw error;
		}

		let serviceWorkerInfo: { version: string; sourceText: string } | undefined;
		try {
			serviceWorkerInfo = await this._getWebviewServiceWorkerInfo();
		} catch (error) {
			this._logService.error(
				`[WebClientServer] Failed to load webview service worker source: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		const rewritten = this._rewriteWebviewPreIndexCsp(raw, serviceWorkerInfo);
		const etag = `W/"${crypto.createHash("sha256").update(rewritten).digest("hex")}"`;

		const entry = { content: rewritten, etag, mtimeMs };
		this._webviewPreIndexCache = entry;
		return entry;
	}

	private _rewriteWebviewPreIndexCsp(
		html: string,
		info?: { version: string; sourceText: string },
	): string {
		const metaRegex =
			/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)("[^>]*>)/i;
		const match = metaRegex.exec(html);
		if (!match) {
			return html;
		}

		const originalCsp = match[2];
		const directives = originalCsp
			.split(";")
			.map((d) => d.trim())
			.filter((d) => d.length > 0);
		const scriptIndex = directives.findIndex((d) => d.startsWith("script-src"));
		if (scriptIndex === -1) {
			return html;
		}

		const scriptDirective = directives[scriptIndex];
		const tokens = scriptDirective.split(/\s+/);
		const directiveName = tokens.shift();
		if (!directiveName) {
			return html;
		}

		const preserved = tokens.filter((token) => !/^'sha256-[^']*'$/.test(token));
		if (!preserved.includes("'self'")) {
			preserved.unshift("'self'");
		}
		if (!preserved.includes("'unsafe-inline'")) {
			preserved.push("'unsafe-inline'");
		}
		const deduped = Array.from(new Set(preserved));

		directives[scriptIndex] = [directiveName, ...deduped].join(" ");
		const trailingSemicolon = /\s*;\s*$/.test(originalCsp) ? ";" : "";
		const updatedCsp = `${directives.join("; ")}${trailingSemicolon}`;

		let rewritten = html.replace(metaRegex, `$1${updatedCsp}$3`);
		const sourceReplacement = info?.sourceText
			? JSON.stringify(Buffer.from(info.sourceText, "utf-8").toString("base64"))
			: "null";
		const versionReplacement = info?.version
			? JSON.stringify(info.version)
			: "undefined";
		rewritten = rewritten.replace(
			"/*__SERVICE_WORKER_SOURCE__*/ null",
			sourceReplacement,
		);
		rewritten = rewritten.replace(
			"/*__SERVICE_WORKER_VERSION__*/ undefined",
			versionReplacement,
		);
		return rewritten;
	}

	private _getResourceURLTemplateAuthority(uri: URI): string | undefined {
		const index = uri.authority.indexOf(".");
		return index !== -1 ? uri.authority.substring(index + 1) : undefined;
	}

	/**
	 * Handle extension resources
	 * @param resourcePath The path after /web-extension-resource/
	 */
	private async _handleWebExtensionResource(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		resourcePath: string,
	): Promise<void> {
		if (!this._webExtensionResourceUrlTemplate) {
			return serveError(
				req,
				res,
				500,
				"No extension gallery service configured.",
			);
		}

		const normalizedPathname = decodeURIComponent(resourcePath); // support paths that are uri-encoded (e.g. spaces => %20)
		const path = normalize(normalizedPathname);
		const uri = URI.parse(path).with({
			scheme: this._webExtensionResourceUrlTemplate.scheme,
			authority: path.substring(0, path.indexOf("/")),
			path: path.substring(path.indexOf("/") + 1),
		});

		if (
			this._getResourceURLTemplateAuthority(
				this._webExtensionResourceUrlTemplate,
			) !== this._getResourceURLTemplateAuthority(uri)
		) {
			return serveError(req, res, 403, "Request Forbidden");
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
		setRequestHeader("X-Client-Name");
		setRequestHeader("X-Client-Version");
		setRequestHeader("X-Machine-Id");
		setRequestHeader("X-Client-Commit");

		const context = await this._requestService.request(
			{
				type: "GET",
				url: uri.toString(true),
				headers,
			},
			CancellationToken.None,
		);

		const status = context.res.statusCode || 500;
		if (status !== 200) {
			let text: string | null = null;
			try {
				text = await asTextOrError(context);
			} catch (error) {
				/* Ignore */
			}
			return serveError(
				req,
				res,
				status,
				text || `Request failed with status ${status}`,
			);
		}

		const responseHeaders: Record<string, string | string[]> =
			Object.create(null);
		const setResponseHeader = (header: string) => {
			const value = context.res.headers[header];
			if (value) {
				responseHeaders[header] = value;
			} else if (header !== header.toLowerCase()) {
				setResponseHeader(header.toLowerCase());
			}
		};
		setResponseHeader("Cache-Control");
		setResponseHeader("Content-Type");
		res.writeHead(200, responseHeaders);
		const buffer = await streamToBuffer(context.stream);
		return void res.end(buffer.buffer);
	}

	/**
	 * Handle HTTP requests for /
	 */
	private async _handleRoot(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		parsedUrl: url.UrlWithParsedQuery,
	): Promise<void> {
		const getFirstHeader = (headerName: string) => {
			const val = req.headers[headerName];
			const candidate = Array.isArray(val) ? val[0] : val;
			if (!candidate) {
				return undefined;
			}
			const [first] = candidate.split(",");
			const trimmed = first?.trim();
			return trimmed || undefined;
		};

		const splitAuthority = (
			authority: string,
		): { host: string; port: string | undefined } => {
			if (authority.startsWith("[")) {
				const closing = authority.indexOf("]");
				if (closing !== -1) {
					const host = authority.slice(0, closing + 1);
					const rest = authority.slice(closing + 1);
					if (rest.startsWith(":")) {
						return { host, port: rest.slice(1) };
					}
					return { host, port: undefined };
				}
			}

			const lastColon = authority.lastIndexOf(":");
			if (lastColon > -1 && authority.indexOf(":") === lastColon) {
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
			const [firstEntry] = raw.split(",");
			if (!firstEntry) {
				return {};
			}

			const result: { proto?: string; host?: string; port?: string } = {};
			for (const segment of firstEntry.split(";")) {
				const [rawKey, rawValue] = segment.split("=");
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
				if (key === "proto") {
					result.proto = value.toLowerCase();
				} else if (key === "host") {
					result.host = value;
				} else if (key === "port") {
					result.port = value;
				}
			}
			return result;
		};

		const forwardedFromForwardedHeader = parseForwardedHeader(
			getFirstHeader("forwarded"),
		);
		const forwardedProtoHeader =
			forwardedFromForwardedHeader.proto ?? getFirstHeader("x-forwarded-proto");
		const forwardedHostHeaderRaw =
			forwardedFromForwardedHeader.host ?? getFirstHeader("x-forwarded-host");
		const forwardedHostParts = forwardedHostHeaderRaw
			? splitAuthority(forwardedHostHeaderRaw)
			: undefined;
		const forwardedHost = forwardedHostParts?.host?.trim();
		const forwardedPortHeader =
			forwardedFromForwardedHeader.port ??
			getFirstHeader("x-forwarded-port") ??
			forwardedHostParts?.port;

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
			const bracketStripped =
				authority.startsWith("[") && authority.endsWith("]")
					? authority.slice(1, -1)
					: authority;
			const host = bracketStripped.split(":")[0]?.toLowerCase();
			if (!host) {
				return true;
			}
			if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
				return true;
			}
			if (
				/^10\./.test(host) ||
				/^192\.168\./.test(host) ||
				/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
				/^169\.254\./.test(host)
			) {
				return true;
			}
			if (/^fc[0-9a-f]{2}/.test(host) || /^fd[0-9a-f]{2}/.test(host)) {
				return true;
			}
			return false;
		};

		const getProtocol = () => {
			const forwardedProto = forwardedProtoHeader
				?.split(",")[0]
				?.trim()
				.toLowerCase();
			if (forwardedProto === "https") {
				return "https";
			}
			if (forwardedProto === "http") {
				return "http";
			}

			const forwardedPort = forwardedPortHeader?.split(",")[0]?.trim();
			if (forwardedPort === "443") {
				return "https";
			}
			if (forwardedPort === "80") {
				return "http";
			}

			// Node's IncomingMessage doesn't guarantee socket to be TLSSocket, so we use type assertion.
			const socket: any = req.socket;
			return socket?.encrypted ? "https" : "http";
		};

		// Prefix routes with basePath for clients
		const basePath = getFirstHeader("x-forwarded-prefix") || this._basePath;

		const queryConnectionToken = parsedUrl.query[connectionTokenQueryName];
		if (typeof queryConnectionToken === "string") {
			// We got a connection token as a query parameter.
			// We want to have a clean URL, so we strip it
			const responseHeaders: Record<string, string> = Object.create(null);
			responseHeaders["Set-Cookie"] = cookie.serialize(
				connectionTokenCookieName,
				queryConnectionToken,
				{
					sameSite: "lax",
					maxAge: 60 * 60 * 24 * 7 /* 1 week */,
				},
			);

			const newQuery = Object.create(null);
			for (const key in parsedUrl.query) {
				if (key !== connectionTokenQueryName) {
					newQuery[key] = parsedUrl.query[key];
				}
			}
			const newLocation = url.format({ pathname: basePath, query: newQuery });
			responseHeaders["Location"] = newLocation;

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

		const shouldOmitPortForProtocol = (
			port: string | undefined,
			scheme: string,
		) => {
			if (!port) {
				return true;
			}

			const trimmed = port.trim();
			if (!trimmed) {
				return true;
			}

			if (scheme === "https" && trimmed === "443") {
				return true;
			}
			if (scheme === "http" && trimmed === "80") {
				return true;
			}

			return false;
		};

		const replacePort = (
			authority: string,
			port: string | undefined,
			scheme: string,
		) => {
			const { host } = splitAuthority(authority);
			if (shouldOmitPortForProtocol(port, scheme)) {
				return host;
			}
			return formatAuthority(host, port);
		};

		const normalizeDefaultPort = (
			authority: string | undefined,
			scheme: string,
		) => {
			if (!authority) {
				return authority;
			}
			const { host, port } = splitAuthority(authority);
			if (shouldOmitPortForProtocol(port, scheme)) {
				return host;
			}
			return formatAuthority(host, port);
		};

		const useTestResolver =
			!this._environmentService.isBuilt &&
			this._environmentService.args["use-test-resolver"];
		const proxyHostOverride = this._environmentService.args["proxy-host"];
		const proxyPortOverride = this._environmentService.args["proxy-port"];
		let remoteAuthority: string | undefined;
		if (useTestResolver) {
			remoteAuthority = "test+test";
		} else if (proxyHostOverride) {
			remoteAuthority = proxyPortOverride
				? `${proxyHostOverride}:${proxyPortOverride}`
				: proxyHostOverride;
		} else {
			const candidates: (string | undefined)[] = [
				forwardedHost,
				getFirstHeader("x-original-host"),
				getFirstHeader("x-forwarded-host"),
				normalizeAuthority(req.headers.host),
			];
			remoteAuthority =
				candidates.find(
					(candidate) => !!candidate && !isPrivateAuthority(candidate),
				) ?? candidates.find((candidate) => !!candidate);
		}
		if (!remoteAuthority) {
			return serveError(req, res, 400, `Bad request.`);
		}
		if (!proxyHostOverride && remoteAuthority) {
			const forwardedPort = forwardedPortHeader?.split(",")[0]?.trim();
			if (forwardedPort) {
				remoteAuthority = replacePort(remoteAuthority, forwardedPort, protocol);
			}
		}

		remoteAuthority = normalizeDefaultPort(remoteAuthority, protocol);

		function asJSON(value: unknown): string {
			return JSON.stringify(value).replace(/"/g, "&quot;");
		}

		let _wrapWebWorkerExtHostInIframe: undefined | false = undefined;
		if (this._environmentService.args["enable-smoke-test-driver"]) {
			// integration tests run at a time when the built output is not yet published to the CDN
			// so we must disable the iframe wrapping because the iframe URL will give a 404
			_wrapWebWorkerExtHostInIframe = false;
		}

		if (this._logService.getLevel() === LogLevel.Trace) {
			[
				"x-original-host",
				"x-forwarded-host",
				"x-forwarded-port",
				"host",
			].forEach((header) => {
				const value = getFirstHeader(header);
				if (value) {
					this._logService.trace(`[WebClientServer] ${header}: ${value}`);
				}
			});
			if (proxyHostOverride) {
				this._logService.trace(
					`[WebClientServer] proxy-host override in effect: ${remoteAuthority}`,
				);
			}
			this._logService.trace(
				`[WebClientServer] Request URL: ${req.url}, basePath: ${basePath}, remoteAuthority: ${remoteAuthority}`,
			);
		}

		const staticRoute = posix.join(basePath, this._productPath, STATIC_PATH);
		const callbackRoute = posix.join(
			basePath,
			this._productPath,
			CALLBACK_PATH,
		);
		// const webExtensionRoute = posix.join(basePath, this._productPath, WEB_EXTENSION_PATH);

		const resolveWorkspaceURI = (defaultLocation?: string) =>
			defaultLocation &&
			URI.file(resolve(defaultLocation)).with({
				scheme: Schemas.vscodeRemote,
				authority: remoteAuthority,
			});

		const filePath = FileAccess.asFileUri(
			`vs/code/browser/workbench/workbench${this._environmentService.isBuilt ? "" : "-dev"}.html`,
		).fsPath;
		const authSessionInfo =
			!this._environmentService.isBuilt &&
			this._environmentService.args["github-auth"]
				? {
						id: generateUuid(),
						providerId: "github",
						accessToken: this._environmentService.args["github-auth"],
						scopes: [["user:email"], ["repo"]],
					}
				: undefined;

		const webviewEndpoint = `${protocol}://${remoteAuthority}${staticRoute}/out/vs/workbench/contrib/webview/browser/pre/`;
		const webviewEndpointWithToken =
			this._connectionToken.type !== ServerConnectionTokenType.None
				? `${webviewEndpoint}?${connectionTokenQueryName}=${encodeURIComponent(this._connectionToken.value)}`
				: webviewEndpoint;

		const webviewServiceWorkerVersion =
			await this._resolveWebviewServiceWorkerVersion();

		const productConfiguration: Partial<Mutable<IProductConfiguration>> = {
			webviewContentExternalBaseUrlTemplate: webviewEndpointWithToken,
			webviewServiceWorkerVersion,
		};

		const proposedApi = this._environmentService.args["enable-proposed-api"];
		const rawProposedApiArgs = Array.isArray(proposedApi) ? proposedApi : [];
		const hasProposedApiArgument = Object.prototype.hasOwnProperty.call(
			this._environmentService.args,
			"enable-proposed-api",
		);
		const normalizeProposedValue = (value: unknown): string =>
			typeof value === "string"
				? value.trim()
				: value === undefined || value === null
					? ""
					: String(value).trim();
		const normalizedProposedApiValues = rawProposedApiArgs.map(normalizeProposedValue);
		const filteredProposedApiValues = normalizedProposedApiValues.filter(
			(value) => value && value !== "*",
		);
		const hasWildcardProposedApi =
			(hasProposedApiArgument && rawProposedApiArgs.length === 0) ||
			normalizedProposedApiValues.some((value) => !value || value === "*");

		if (filteredProposedApiValues.length) {
			productConfiguration.extensionsEnabledWithApiProposalVersion ??= [];
			productConfiguration.extensionsEnabledWithApiProposalVersion.push(
				...filteredProposedApiValues,
			);
		}

		if (!this._environmentService.isBuilt) {
			try {
				const productOverrides = JSON.parse(
					(
						await promises.readFile(join(APP_ROOT, "product.overrides.json"))
					).toString(),
				);
				Object.assign(productConfiguration, productOverrides);
			} catch (err) {
				/* Ignore Error */
			}
		}

		const galleryConfiguration = this._productService.extensionsGallery;
		if (galleryConfiguration) {
			productConfiguration.extensionsGallery = { ...galleryConfiguration };
		}

		const envArgsRecord = this._environmentService.args as unknown as Record<
			string,
			unknown
		>;
		const verboseConsoleFlag = parseBooleanFlag(
			envArgsRecord['openvscode-verbose-console'],
		);
		const verboseConsoleEnv = parseBooleanFlag(
			process.env.OPENVSCODE_VERBOSE_CONSOLE,
		);
		const webviewDebugFlag = parseBooleanFlag(
			envArgsRecord['openvscode-webview-debug'],
		);
		const webviewDebugEnv = parseBooleanFlag(
			process.env.OPENVSCODE_WEBVIEW_DEBUG,
		);

		const openvscodeConfiguration = {
			verboseConsole: verboseConsoleFlag || verboseConsoleEnv,
			webviewDebug: webviewDebugFlag || webviewDebugEnv,
			enableProposedApiAll: hasWildcardProposedApi || undefined,
			connectionToken:
				this._connectionToken.type !== ServerConnectionTokenType.None
					? this._connectionToken.value
					: undefined,
		};

		const workbenchWebConfiguration = {
			remoteAuthority,
			serverBasePath: basePath,
			_wrapWebWorkerExtHostInIframe,
			developmentOptions: {
				enableSmokeTestDriver: this._environmentService.args[
					"enable-smoke-test-driver"
				]
					? true
					: undefined,
				logLevel: this._logService.getLevel(),
			},
			settingsSyncOptions:
				!this._environmentService.isBuilt &&
				this._environmentService.args["enable-sync"]
					? { enabled: true }
					: undefined,
			enableWorkspaceTrust:
				!this._environmentService.args["disable-workspace-trust"],
			folderUri: resolveWorkspaceURI(
				this._environmentService.args["default-folder"],
			),
			workspaceUri: resolveWorkspaceURI(
				this._environmentService.args["default-workspace"],
			),
			productConfiguration,
			webviewEndpoint,
			webviewServiceWorkerVersion,
			callbackRoute: callbackRoute,
			openvscode: openvscodeConfiguration,
		};

		const cookies = cookie.parse(req.headers.cookie || "");
		const locale =
			cookies["vscode.nls.locale"] ||
			req.headers["accept-language"]?.split(",")[0]?.toLowerCase() ||
			"en";
		let WORKBENCH_NLS_BASE_URL: string | undefined;
		let WORKBENCH_NLS_URL: string;
		if (!locale.startsWith("en") && this._productService.nlsCoreBaseUrl) {
			WORKBENCH_NLS_BASE_URL = this._productService.nlsCoreBaseUrl;
			WORKBENCH_NLS_URL = `${WORKBENCH_NLS_BASE_URL}${this._productService.commit}/${this._productService.version}/${locale}/nls.messages.js`;
		} else {
			WORKBENCH_NLS_URL = ""; // fallback will apply
		}

		const values: { [key: string]: string } = {
			WORKBENCH_WEB_CONFIGURATION: asJSON(workbenchWebConfiguration),
			WORKBENCH_AUTH_SESSION: authSessionInfo ? asJSON(authSessionInfo) : "",
			WORKBENCH_WEB_BASE_URL: staticRoute,
			WORKBENCH_NLS_URL,
			WORKBENCH_NLS_FALLBACK_URL: `${staticRoute}/out/nls.messages.js`,
		};

		// DEV ---------------------------------------------------------------------------------------
		// DEV: This is for development and enables loading CSS via import-statements via import-maps.
		// DEV: The server needs to send along all CSS modules so that the client can construct the
		// DEV: import-map.
		// DEV ---------------------------------------------------------------------------------------
		if (this._cssDevService.isEnabled) {
			const cssModules = await this._cssDevService.getCssModules();
			values["WORKBENCH_DEV_CSS_MODULES"] = JSON.stringify(cssModules);
		}

		if (useTestResolver) {
			const bundledExtensions: {
				extensionPath: string;
				packageJSON: IExtensionManifest;
			}[] = [];
			for (const extensionPath of [
				"vscode-test-resolver",
				"github-authentication",
			]) {
				const packageJSON = JSON.parse(
					(
						await promises.readFile(
							FileAccess.asFileUri(
								`${builtinExtensionsPath}/${extensionPath}/package.json`,
							).fsPath,
						)
					).toString(),
				);
				bundledExtensions.push({ extensionPath, packageJSON });
			}
			values["WORKBENCH_BUILTIN_EXTENSIONS"] = asJSON(bundledExtensions);
		}

		let data;
		try {
			const workbenchTemplate = (await promises.readFile(filePath)).toString();
			data = workbenchTemplate.replace(
				/\{\{([^}]+)\}\}/g,
				(_, key) => values[key] ?? "undefined",
			);
		} catch (e) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			return void res.end("Not found");
		}

		const webWorkerExtensionHostIframeScriptSHA =
			"sha256-2Q+j4hfT09+1+imS46J2YlkCtHWQt0/BE79PXjJ0ZJ8=";

		const cspDirectives = [
			"default-src 'self';",
			"img-src 'self' https: data: blob:;",
			"media-src 'self';",
			`script-src 'self' 'unsafe-eval' ${WORKBENCH_NLS_BASE_URL ?? ""} blob: 'nonce-1nline-m4p' ${this._getScriptCspHashes(data).join(" ")} '${webWorkerExtensionHostIframeScriptSHA}' 'sha256-/r7rqQ+yrxt57sxLuQ6AMYcy/lUpvAIzHjIJt/OeLWU=' ${useTestResolver ? "" : `${protocol}://${remoteAuthority}`};`, // the sha is the same as in src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
			"child-src 'self';",
			`frame-src 'self' ${protocol}://${remoteAuthority} https://*.vscode-cdn.net data:;`,
			"worker-src 'self' data: blob:;",
			"style-src 'self' 'unsafe-inline';",
			"connect-src 'self' ws: wss: https: http:;",
			"font-src 'self' https: http: data: blob:;",
			"manifest-src 'self';",
		].join(" ");

		const headers: http.OutgoingHttpHeaders = {
			"Content-Type": "text/html",
			"Content-Security-Policy": cspDirectives,
		};
		if (this._connectionToken.type !== ServerConnectionTokenType.None) {
			// At this point we know the client has a valid cookie
			// and we want to set it prolong it to ensure that this
			// client is valid for another 1 week at least
			headers["Set-Cookie"] = cookie.serialize(
				connectionTokenCookieName,
				this._connectionToken.value,
				{
					sameSite: "lax",
					maxAge: 60 * 60 * 24 * 7 /* 1 week */,
				},
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
					this._logService.error(
						`[WebClientServer] Failed to compute webview service worker version: ${error instanceof Error ? error.message : String(error)}`,
					);
					return this._productService.commit ?? Date.now().toString();
				}
			})();
		}

		return this._webviewServiceWorkerVersionPromise;
	}

	private async _getWebviewServiceWorkerInfo(): Promise<{
		version: string;
		sourceText: string;
	}> {
		if (!this._webviewServiceWorkerInfoPromise) {
			this._webviewServiceWorkerInfoPromise = (async () => {
				const serviceWorkerPath = join(
					APP_ROOT,
					"static",
					"out",
					"vs",
					"workbench",
					"contrib",
					"webview",
					"browser",
					"pre",
					"service-worker.js",
				);
				const contentBuffer = await promises.readFile(serviceWorkerPath);
				return {
					version: crypto
						.createHash("sha256")
						.update(contentBuffer)
						.digest("hex"),
					sourceText: contentBuffer.toString("utf-8"),
				};
			})();
		}

		return this._webviewServiceWorkerInfoPromise;
	}

	private _getScriptCspHashes(content: string): string[] {
		// Compute the CSP hashes for line scripts. Uses regex
		// which means it isn't 100% good.
		const regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gim;
		const result: string[] = [];
		let match: RegExpExecArray | null;
		while ((match = regex.exec(content))) {
			const attributes = match[1];
			if (/\ssrc\s*=/.test(attributes ?? "")) {
				continue;
			}
			const hasher = crypto.createHash("sha256");
			// This only works on Windows if we strip `\r` from `\r\n`.
			const script = match[2].replace(/\r\n/g, "\n");
			if (!script.trim()) {
				continue;
			}
			const hash = hasher
				.update(Buffer.from(script))
				.digest()
				.toString("base64");

			result.push(`'sha256-${hash}'`);
		}
		return result;
	}

	/**
	 * Handle HTTP requests for /callback
	 */
	private async _handleCallback(res: http.ServerResponse): Promise<void> {
		const filePath = FileAccess.asFileUri(
			"vs/code/browser/workbench/callback.html",
		).fsPath;
		const data = (await promises.readFile(filePath)).toString();
		const cspDirectives = [
			"default-src 'self';",
			"img-src 'self' https: data: blob:;",
			"media-src 'none';",
			`script-src 'self' ${this._getScriptCspHashes(data).join(" ")};`,
			"style-src 'self' 'unsafe-inline';",
			"font-src 'self' blob:;",
		].join(" ");

		res.writeHead(200, {
			"Content-Type": "text/html",
			"Content-Security-Policy": cspDirectives,
		});
		return void res.end(data);
	}
}

function isAllowedStaticCdnOrigin(
	origin: string,
	logService: ILogService,
): boolean {
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== "https:") {
			return false;
		}
		return parsed.hostname.endsWith(".vscode-cdn.net");
	} catch (error) {
		logService.trace(
			`[WebClientServer] Ignoring invalid static origin "${origin}": ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

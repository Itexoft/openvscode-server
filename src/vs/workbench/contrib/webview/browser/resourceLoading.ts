/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBufferReadableStream } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { isUNC } from '../../../../base/common/extpath.js';
import { Schemas } from '../../../../base/common/network.js';
import { normalize, sep } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { FileOperationError, FileOperationResult, IFileService, IWriteFileOptions } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getWebviewContentMimeType } from '../../../../platform/webview/common/mimeTypes.js';

export namespace WebviewResourceResponse {
	export enum Type { Success, Failed, AccessDenied, NotModified }

	export class StreamSuccess {
		readonly type = Type.Success;

		constructor(
			public readonly stream: VSBufferReadableStream,
			public readonly etag: string | undefined,
			public readonly mtime: number | undefined,
			public readonly mimeType: string,
		) { }
	}

	export const Failed = { type: Type.Failed } as const;
	export const AccessDenied = { type: Type.AccessDenied } as const;

	export class NotModified {
		readonly type = Type.NotModified;

		constructor(
			public readonly mimeType: string,
			public readonly mtime: number | undefined,
		) { }
	}

	export type StreamResponse = StreamSuccess | typeof Failed | typeof AccessDenied | NotModified;
}

export async function loadLocalResource(
	requestUri: URI,
	options: {
		ifNoneMatch: string | undefined;
		roots: ReadonlyArray<URI>;
	},
	fileService: IFileService,
	logService: ILogService,
	token: CancellationToken,
): Promise<WebviewResourceResponse.StreamResponse> {
	const resourceToLoad = getResourceToLoad(requestUri, options.roots);

	logService.trace(`Webview.loadLocalResource - trying to load resource. requestUri=${requestUri}, resourceToLoad=${resourceToLoad}`);

	try {
		const requestStore = (globalThis as any).__webviewResourceRequests as Array<{ request: string; scheme: string; hasRoot: boolean; timestamp: number }> | undefined;
		const entry = { request: requestUri.toString(true), scheme: requestUri.scheme, hasRoot: !!resourceToLoad, timestamp: Date.now() };
		if (Array.isArray(requestStore)) {
			requestStore.push(entry);
		} else {
			(globalThis as any).__webviewResourceRequests = [entry];
		}
	} catch {
		// ignore diagnostic failures
	}

	let resolvedResource = resourceToLoad;

	if (!resolvedResource) {
		resolvedResource = normalizeResourcePath(requestUri);
		logService.warn(`Webview.loadLocalResource - falling back to normalized remote resource without explicit root`, {
			request: requestUri.toString(true),
			roots: options.roots.map(root => root.toString(true))
		});
		try {
			const fallbackStore = (globalThis as any).__webviewResourceFallbacks as Array<{ request: string; timestamp: number }> | undefined;
			if (Array.isArray(fallbackStore)) {
				fallbackStore.push({ request: requestUri.toString(true), timestamp: Date.now() });
			} else {
				(globalThis as any).__webviewResourceFallbacks = [{ request: requestUri.toString(true), timestamp: Date.now() }];
			}
		} catch {
			// ignore diagnostic failures
		}
	}

	if (!resolvedResource) {
		logService.trace(`Webview.loadLocalResource - access denied. requestUri=${requestUri}, resourceToLoad=${resourceToLoad}`);
		logService.warn(`Webview.loadLocalResource - denied`, {
			request: requestUri.toString(true),
			roots: options.roots.map(root => root.toString(true))
		});
		return WebviewResourceResponse.AccessDenied;
	}

	const mime = getWebviewContentMimeType(requestUri); // Use the original path for the mime

	try {
		const result = await fileService.readFileStream(resolvedResource, { etag: options.ifNoneMatch }, token);
		logService.trace(`Webview.loadLocalResource - Loaded. requestUri=${requestUri}, resourceToLoad=${resolvedResource}`);
		return new WebviewResourceResponse.StreamSuccess(result.value, result.etag, result.mtime, mime);
	} catch (err) {
		const isNotFound =
			err instanceof FileOperationError &&
			err.fileOperationResult === FileOperationResult.FILE_NOT_FOUND;

		if (isNotFound) {
			const fallbackUri = getSourceMapFallbackUri(requestUri);
			if (fallbackUri) {
				const fallbackResource =
					getResourceToLoad(fallbackUri, options.roots) ??
					normalizeResourcePath(fallbackUri);

				if (fallbackResource) {
					try {
						const fallbackResult = await fileService.readFileStream(fallbackResource, { etag: options.ifNoneMatch }, token);
						logService.trace(`Webview.loadLocalResource - Loaded via sourcemap fallback. requestUri=${requestUri}, resourceToLoad=${fallbackResource}`);
						return new WebviewResourceResponse.StreamSuccess(
							fallbackResult.value,
							fallbackResult.etag,
							fallbackResult.mtime,
							mime,
						);
					} catch {
						// fall through to the original error handling
					}
				}
			}
		}

		if (err instanceof FileOperationError) {
			const result = err.fileOperationResult;

			// NotModified status is expected and can be handled gracefully
			if (result === FileOperationResult.FILE_NOT_MODIFIED_SINCE) {
				logService.trace(`Webview.loadLocalResource - not modified. requestUri=${requestUri}, resourceToLoad=${resolvedResource}`);
				return new WebviewResourceResponse.NotModified(mime, (err.options as IWriteFileOptions | undefined)?.mtime);
			}
		}

		// Otherwise the error is unexpected.
		logService.error(`Webview.loadLocalResource - Error using fileReader. requestUri=${requestUri}, resourceToLoad=${resolvedResource}`);
		return WebviewResourceResponse.Failed;
	}
}

function getResourceToLoad(
	requestUri: URI,
	roots: ReadonlyArray<URI>,
): URI | undefined {
	for (const root of roots) {
		if (containsResource(root, requestUri)) {
			return normalizeResourcePath(requestUri);
		}
	}

	return undefined;
}

function containsResource(root: URI, resource: URI): boolean {
	const isFileLikePair =
		(root.scheme === Schemas.file && resource.scheme === Schemas.vscodeRemote) ||
		(root.scheme === Schemas.vscodeRemote && resource.scheme === Schemas.file);

	if (root.scheme !== resource.scheme && !isFileLikePair) {
		return false;
	}

	let resourceFsPath = normalize(resource.fsPath);
	let rootPath = normalize(root.fsPath + (root.fsPath.endsWith(sep) ? '' : sep));

	if (isUNC(root.fsPath) && isUNC(resource.fsPath)) {
		rootPath = rootPath.toLowerCase();
		resourceFsPath = resourceFsPath.toLowerCase();
	}

	return resourceFsPath.startsWith(rootPath);
}

function getSourceMapFallbackUri(requestUri: URI): URI | undefined {
	const lowerPath = requestUri.path.toLowerCase();
	const remap = (from: string, to: string): URI | undefined => {
		if (lowerPath.endsWith(from)) {
			return requestUri.with({ path: requestUri.path.slice(0, -from.length) + to });
		}
		return undefined;
	};

	return remap('.map.json', '.js.map') ?? remap('.sourcemap', '.js.map');
}

function normalizeResourcePath(resource: URI): URI {
	// Rewrite remote uris to a path that the remote file system can understand
	if (resource.scheme === Schemas.vscodeRemote) {
		return URI.from({
			scheme: Schemas.vscodeRemote,
			authority: resource.authority,
			path: '/vscode-resource',
			query: JSON.stringify({
				requestResourcePath: resource.path
			})
		});
	}
	return resource;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CharCode } from '../../../../base/common/charCode.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import product from '../../../../platform/product/common/product.js';

export interface WebviewRemoteInfo {
	readonly isRemote: boolean;
	readonly authority: string | undefined;
}

const FALLBACK_RESOURCE_HOST = 'vscode-cdn.net';
const FALLBACK_RESOURCE_SCHEME = 'https';
const FALLBACK_COMMIT = 'ef65ac1ba57f57f2a3961bfe94aa20481caca4c6';
const FALLBACK_QUALITY = 'insider';
const UUID_TOKEN = '{{uuid}}';
const COMMIT_TOKEN = '{{commit}}';
const QUALITY_TOKEN = '{{quality}}';
const UUID_PLACEHOLDER = '00000000000000000000000000000000';

function replaceAll(input: string, search: string, replacement: string): string {
	if (!search || search === replacement) {
		return input;
	}

	return input.split(search).join(replacement);
}

function stripUuidPlaceholder(authority: string): string {
	if (authority.startsWith(`${UUID_PLACEHOLDER}.`)) {
		return authority.slice(UUID_PLACEHOLDER.length + 1);
	}

	return authority.replace(UUID_PLACEHOLDER, '').replace(/^\./, '');
}

function computeWebviewResourceConfiguration(): {
	readonly baseHost: string;
	readonly rootResourceAuthority: string;
	readonly resourceAuthorityPort: string | undefined;
	readonly resourceScheme: string;
	readonly genericCspSource: string;
} {
	let template = product.webviewContentExternalBaseUrlTemplate;

	if (!template) {
		return {
			baseHost: FALLBACK_RESOURCE_HOST,
			rootResourceAuthority: `vscode-resource.${FALLBACK_RESOURCE_HOST}`,
			resourceAuthorityPort: undefined,
			resourceScheme: FALLBACK_RESOURCE_SCHEME,
			genericCspSource: `'self' ${FALLBACK_RESOURCE_SCHEME}://*.${FALLBACK_RESOURCE_HOST}`
		};
	}

	template = replaceAll(template, COMMIT_TOKEN, product.commit ?? FALLBACK_COMMIT);
	template = replaceAll(template, QUALITY_TOKEN, product.quality ?? FALLBACK_QUALITY);

	const hasUuidToken = template.includes(UUID_TOKEN);
	const parseTarget = hasUuidToken ? template.replace(UUID_TOKEN, UUID_PLACEHOLDER) : template;

	try {
		const endpoint = new URL(parseTarget);
		let hostname = endpoint.hostname;
		if (!hostname) {
			throw new Error('Missing hostname');
		}

		let hostWithPort = endpoint.host || hostname;
		let resourceScheme = (endpoint.protocol || '').replace(/:$/, '').toLowerCase() || FALLBACK_RESOURCE_SCHEME;
		let resourceAuthorityPort = endpoint.port || undefined;

		const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
		if (isLoopback && typeof globalThis !== 'undefined') {
			const location = (globalThis as any)?.location;
			if (location?.host) {
				const locationHost: string = location.host;
				const locationHostname: string = location.hostname || locationHost;
				hostWithPort = locationHost;
				hostname = locationHostname;
				resourceAuthorityPort = location.port || undefined;
				const protocol = typeof location.protocol === 'string' ? location.protocol.replace(/:$/, '') : undefined;
				if (protocol) {
					resourceScheme = protocol.toLowerCase();
				}
			}
		}

		const baseHost = hasUuidToken ? stripUuidPlaceholder(hostWithPort) : hostWithPort;
		const baseHostname = hasUuidToken ? stripUuidPlaceholder(hostname) : hostname;
		const cspAuthority = hasUuidToken ? `*.${baseHostname}` : hostWithPort;

		return {
			baseHost,
			rootResourceAuthority: `vscode-resource.${baseHostname}`,
			resourceAuthorityPort,
			resourceScheme,
			genericCspSource: `'self' ${resourceScheme}://${cspAuthority}`
		};
	} catch (error) {
		return {
			baseHost: FALLBACK_RESOURCE_HOST,
			rootResourceAuthority: `vscode-resource.${FALLBACK_RESOURCE_HOST}`,
			resourceAuthorityPort: undefined,
			resourceScheme: FALLBACK_RESOURCE_SCHEME,
			genericCspSource: `'self' ${FALLBACK_RESOURCE_SCHEME}://*.${FALLBACK_RESOURCE_HOST}`
		};
	}
}

const webviewResourceConfiguration = computeWebviewResourceConfiguration();

/**
 * Root from which resources in webviews are loaded.
 *
 * This is configurable because self-hosted environments often need to serve the webview
 * bundle from a custom origin instead of the default CDN.
 */
export const webviewResourceBaseHost = webviewResourceConfiguration.baseHost;

export const webviewRootResourceAuthority = webviewResourceConfiguration.rootResourceAuthority;

export const webviewResourceBaseScheme = webviewResourceConfiguration.resourceScheme;

export const webviewGenericCspSource = webviewResourceConfiguration.genericCspSource;

/**
 * Construct a uri that can load resources inside a webview
 *
 * We encode the resource component of the uri so that on the main thread
 * we know where to load the resource from (remote or truly local):
 *
 * ```txt
 * ${scheme}+${resource-authority}.vscode-resource.vscode-cdn.net/${path}
 * ```
 *
 * @param resource Uri of the resource to load.
 * @param remoteInfo Optional information about the remote that specifies where `resource` should be resolved from.
 */
export function asWebviewUri(resource: URI, remoteInfo?: WebviewRemoteInfo): URI {
	if (resource.scheme === Schemas.http || resource.scheme === Schemas.https) {
		return resource;
	}

	if (remoteInfo && remoteInfo.authority && remoteInfo.isRemote && resource.scheme === Schemas.file) {
		resource = URI.from({
			scheme: Schemas.vscodeRemote,
			authority: remoteInfo.authority,
			path: resource.path,
		});
	}

	const resourceHost = `${resource.scheme}+${encodeAuthority(resource.authority)}.${webviewRootResourceAuthority}`;
	const authority = webviewResourceConfiguration.resourceAuthorityPort
		? `${resourceHost}:${webviewResourceConfiguration.resourceAuthorityPort}`
		: resourceHost;

	return URI.from({
		scheme: webviewResourceConfiguration.resourceScheme,
		authority,
		path: resource.path,
		fragment: resource.fragment,
		query: resource.query,
	});
}

function encodeAuthority(authority: string): string {
	return authority.replace(/./g, char => {
		const code = char.charCodeAt(0);
		if (
			(code >= CharCode.a && code <= CharCode.z)
			|| (code >= CharCode.A && code <= CharCode.Z)
			|| (code >= CharCode.Digit0 && code <= CharCode.Digit9)
		) {
			return char;
		}
		return '-' + code.toString(16).padStart(4, '0');
	});
}

export function decodeAuthority(authority: string) {
	return authority.replace(/-([0-9a-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

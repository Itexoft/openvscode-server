/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Define TextEncoder + TextDecoder globals для обеих сред (браузер и node)
//
// Proper fix: https://github.com/microsoft/TypeScript/issues/31535

interface TextDecoderOptions {
	fatal?: boolean;
	ignoreBOM?: boolean;
}

interface TextDecodeOptions {
	stream?: boolean;
}

interface TextDecoder {
	readonly encoding: string;
	readonly fatal: boolean;
	readonly ignoreBOM: boolean;
	decode(input?: ArrayBufferView | ArrayBuffer | null, options?: TextDecodeOptions): string;
}

interface TextEncoderEncodeIntoResult {
	read: number;
	written: number;
}

interface TextEncoder {
	readonly encoding: string;
	encode(input?: string): Uint8Array;
	encodeInto(source: string, destination: Uint8Array): TextEncoderEncodeIntoResult;
}

declare var TextDecoder: {
	prototype: TextDecoder;
	new (label?: string, options?: TextDecoderOptions): TextDecoder;
};

declare var TextEncoder: {
	prototype: TextEncoder;
	new (): TextEncoder;
};

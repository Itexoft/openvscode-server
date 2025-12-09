/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
/**
 * @fileoverview Common build script for extension scripts used in in webviews.
 */
import path from 'node:path';
import esbuild from 'esbuild';

const DEFAULT_TARGET = ['es2024'];
const FALLBACK_TARGET = ['esnext'];

/**
 * @typedef {Partial<import('esbuild').BuildOptions> & {
 * 	entryPoints: string[] | Record<string, string> | { in: string, out: string }[];
 * 	outdir: string;
 * }} BuildOptions
 */

/**
 * Build the source code once using esbuild.
 *
 * @param {BuildOptions} options
 * @param {(outDir: string) => unknown} [didBuild]
 */
async function build(options, didBuild) {
	/** @type {import('esbuild').BuildOptions} */
	const baseOptions = {
		bundle: true,
		minify: true,
		sourcemap: false,
		format: 'esm',
		platform: 'browser',
		target: DEFAULT_TARGET,
		...options,
	};

	try {
		await esbuild.build(baseOptions);
	} catch (error) {
		const currentTarget = Array.isArray(baseOptions.target) ? baseOptions.target.join(',') : String(baseOptions.target ?? '');
		if (shouldFallbackTarget(error, currentTarget)) {
			const fallbackOptions = {
				...baseOptions,
				target: FALLBACK_TARGET,
			};
			console.warn(`[esbuild] Falling back from target "${currentTarget}" to "${FALLBACK_TARGET.join(',')}"`);
			await esbuild.build(fallbackOptions);
		} else {
			throw error;
		}
	}

	await didBuild?.(options.outdir);
}

/**
 * Build the source code once using esbuild, logging errors instead of throwing.
 *
 * @param {BuildOptions} options
 * @param {(outDir: string) => unknown} [didBuild]
 */
async function tryBuild(options, didBuild) {
	try {
		await build(options, didBuild);
	} catch (err) {
		console.error(err);
	}
}

/**
 * @param {{
 * 	srcDir: string;
 *  outdir: string;
 *  entryPoints: string[] | Record<string, string> | { in: string, out: string }[];
 * 	additionalOptions?: Partial<import('esbuild').BuildOptions>
 * }} config
 * @param {string[]} args
 * @param {(outDir: string) => unknown} [didBuild]
 */
export async function run(config, args, didBuild) {
	let outdir = config.outdir;
	const outputRootIndex = args.indexOf('--outputRoot');
	if (outputRootIndex >= 0) {
		const outputRoot = args[outputRootIndex + 1];
		const outputDirName = path.basename(outdir);
		outdir = path.join(outputRoot, outputDirName);
	}

	/** @type {BuildOptions} */
	const resolvedOptions = {
		entryPoints: config.entryPoints,
		outdir,
		logOverride: {
			'import-is-undefined': 'error',
		},
		...(config.additionalOptions || {}),
	};

	const isWatch = args.indexOf('--watch') >= 0;
	if (isWatch) {
		await tryBuild(resolvedOptions, didBuild);
		const watcher = await import('@parcel/watcher');
		watcher.subscribe(config.srcDir, () => tryBuild(resolvedOptions, didBuild));
	} else {
		return build(resolvedOptions, didBuild).catch(() => process.exit(1));
	}
}

/**
 * @param {unknown} error
 * @param {string} target
 */
function shouldFallbackTarget(error, target) {
	if (!target) {
		return false;
	}
	if (!(error instanceof Error) || typeof error.message !== 'string') {
		return false;
	}
	if (!/Invalid target/i.test(error.message)) {
		return false;
	}
	return error.message.includes(target);
}

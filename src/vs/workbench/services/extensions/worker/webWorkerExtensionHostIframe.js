(function () {
	const searchParams = new URL(document.location.href).searchParams;
	const vscodeWebWorkerExtHostId = searchParams.get('vscodeWebWorkerExtHostId') || '';
	// DO NOT CHANGE the name of the worker without also updating js-debug, as that
	// is used to filter targets to attach to (e.g. #232544)
	const name = searchParams.get('debugged') ? 'DebugExtensionHostWorker' : 'ExtensionHostWorker';
	const parentOrigin = searchParams.get('parentOrigin') || window.origin;
	const salt = searchParams.get('salt');

	const log = (...args) => console.log('[WebWorkerIframe]', ...args);
	const warn = (...args) => console.warn('[WebWorkerIframe]', ...args);
	const error = (...args) => console.error('[WebWorkerIframe]', ...args);

	log('bootstrap start', { vscodeWebWorkerExtHostId, name, parentOrigin, salt });

	(async function () {
		const hostnameValidationMarker = 'v--';
		const hostname = location.hostname;
		if (!hostname.startsWith(hostnameValidationMarker)) {
			log('hostname validation skipped', { hostname });
			// validation not requested
			return start();
		}
		if (!crypto.subtle) {
			warn('crypto.subtle unavailable; skipping hostname validation.', { hostname, parentOrigin, salt });
			return start();
		}

		// Here the `parentOriginHash()` function from `src/vs/base/browser/iframe.ts` is inlined
		// compute a sha-256 composed of `parentOrigin` and `salt` converted to base 32
		/** @type {string} */
		let parentOriginHash;
		try {
			const strData = JSON.stringify({ parentOrigin, salt });
			const encoder = new TextEncoder();
			const arrData = encoder.encode(strData);
			const hash = await crypto.subtle.digest('sha-256', arrData);
			const hashArray = Array.from(new Uint8Array(hash));
			const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
			// sha256 has 256 bits, so we need at most ceil(lg(2^256-1)/lg(32)) = 52 chars to represent it in base 32
			parentOriginHash = BigInt(`0x${hashHex}`).toString(32).padStart(52, '0');
		} catch (err) {
			error('hostname hash failed', err);
			return sendError(err instanceof Error ? err : new Error(String(err)));
		}

		const requiredSubdomain = `${hostnameValidationMarker}${parentOriginHash}.`;
		if (hostname.substring(0, requiredSubdomain.length) === requiredSubdomain) {
			log('hostname validation succeeded', { hostname });
			// validation succeeded!
			return start();
		}

		const validationError = new Error(`Expected '${requiredSubdomain}' as subdomain!`);
		error('hostname validation failed', { hostname, requiredSubdomain });
		return sendError(validationError);
})();

	function sendError(error) {
		error && error instanceof Error ? console.error('[WebWorkerIframe] fatal', error) : error;
		window.parent.postMessage({
			vscodeWebWorkerExtHostId,
			error: {
				name: error ? error.name : '',
				message: error ? error.message : '',
				stack: error ? error.stack : []
			}
		}, '*');
	}

	function start() {
		log('requesting bootstrap payload', { parentOrigin });

		// Before we can load the worker, we need to get the current set of NLS
		// configuration into this iframe. We ask the parent window to send it
		// together with the necessary information to load the worker via Blob.

		const bootstrapNlsType = 'vscode.bootstrap.nls';

		self.onmessage = (event) => {
			if (event.origin !== parentOrigin || event.data.type !== bootstrapNlsType) {
				return;
			}
			const { data } = event.data;
			log('received bootstrap payload', { workerUrl: data.workerUrl, fileRoot: data.fileRoot });
			createWorker(data.workerUrl, data.fileRoot, data.nls.messages, data.nls.language);
		};

		window.parent.postMessage({
			vscodeWebWorkerExtHostId,
			type: bootstrapNlsType
		}, '*');
	}

	function createWorker(workerUrl, fileRoot, nlsMessages, nlsLanguage) {
		try {
			if (globalThis.crossOriginIsolated) {
				workerUrl += '?vscode-coi=2'; // COEP
			}

			// In below blob code, we are using JSON.stringify to ensure the passed
			// in values are not breaking our script. The values may contain string
			// terminating characters (such as ' or ").

			const blob = new Blob([[
				`/*extensionHostWorker*/`,
				`globalThis._VSCODE_NLS_MESSAGES = ${JSON.stringify(nlsMessages)};`,
				`globalThis._VSCODE_NLS_LANGUAGE = ${JSON.stringify(nlsLanguage)};`,
				`globalThis._VSCODE_FILE_ROOT = ${JSON.stringify(fileRoot)};`,
				`await import(${JSON.stringify(workerUrl)});`,
				`/*extensionHostWorker*/`
			].join('')], { type: 'application/javascript' });

			const worker = new Worker(URL.createObjectURL(blob), { name, type: 'module' });
			const nestedWorkers = new Map();

			log('worker created', { name, workerUrl });

			worker.onmessage = (event) => {
				const { data } = event;

				if (data?.type === '_newWorker') {
					const { id, port, url, options } = data;
					const newWorker = new Worker(url, options);
					newWorker.postMessage(port, [port]);
					newWorker.onerror = console.error.bind(console);
					nestedWorkers.set(id, newWorker);
					log('nested worker created', { id, url });

				} else if (data?.type === '_terminateWorker') {
					const { id } = data;
					if (nestedWorkers.has(id)) {
						nestedWorkers.get(id).terminate();
						nestedWorkers.delete(id);
						log('nested worker terminated', { id });
					}
				} else {
					worker.onerror = console.error.bind(console);
					window.parent.postMessage({
						vscodeWebWorkerExtHostId,
						data
					}, parentOrigin, [data]);
				}
			};

			worker.onerror = (event) => {
				error('worker error', { message: event.message, error: event.error });
				sendError(event.error);
			};

			self.onmessage = (event) => {
				if (event.origin !== parentOrigin) {
					return;
				}
				log('forwarding message to worker', { type: event.data?.type });
				worker.postMessage(event.data, event.ports);
			};
		} catch (err) {
			error('createWorker failed', err);
			sendError(err);
		}
	}
})();

// Diagnostics preload hook for OpenVSCode Server (ES module).
//
// The systemd unit in the build environment sets
//   NODE_OPTIONS=--require=/home/openvscode-server/diagnostics-hooks.js
// to inject diagnostics helpers before the server starts. When the
// runtime package is built, this file must exist at the installation
// root so that Node can resolve it. The previous absence of this file
// caused the service to crash during startup.

(async () => {
	try {
		// Improve stack traces when source-map-support is available.
		const mod = await import('source-map-support');
		const install = mod?.install ?? mod?.default?.install;
		if (typeof install === 'function') {
			install();
		}
	} catch {
		// Optional dependency not present; ignore.
	}

	const isAllowedStaticOrigin = (origin) => {
		try {
			const url = new URL(origin);
			return url.protocol === 'https:' && url.hostname.endsWith('.vscode-cdn.net');
		} catch {
			return false;
		}
	};
	const { appendFileSync } = await import('node:fs');
	const traceCors = (msg) => {
		try {
			appendFileSync('/home/openvscode-server/tmp/diagnostics-cors.log', `${new Date().toISOString()} ${msg}\n`);
		} catch {
			// ignore
		}
	};

	try {
		const moduleUrl = new URL('./out/vs/server/node/webClientServer.js', import.meta.url);
		const fs = await import('node:fs');
		if (!fs.existsSync(moduleUrl)) {
			throw new Error('module missing');
		}
		const webClientServerModule = await import(moduleUrl.href);
		const originalServeFile = webClientServerModule?.serveFile;
		if (typeof originalServeFile === 'function' && !originalServeFile.__patchedForCdnCors) {
			const patchedServeFile = async function (filePath, cacheControl, logService, req, res, responseHeaders) {
				try {
					const origin = req?.headers?.origin;
					if (typeof origin === 'string' && req?.url?.includes('/static/') && isAllowedStaticOrigin(origin)) {
						traceCors(`serveFile ${req?.method} ${req?.url} origin=${origin}`);
						responseHeaders['Access-Control-Allow-Origin'] = origin;
						responseHeaders['Vary'] = responseHeaders['Vary'] ? `${responseHeaders['Vary']}, Origin` : 'Origin';
						console.log(`[diagnostics-hooks] serveFile url=${req?.url} method=${req?.method} origin=${origin}`);
					}
				} catch (error) {
					logService?.trace?.(`[diagnostics-hooks] Failed to evaluate static CORS headers: ${error instanceof Error ? error.message : String(error)}`);
				}
				return originalServeFile.call(this, filePath, cacheControl, logService, req, res, responseHeaders);
			};
			Object.defineProperty(patchedServeFile, '__patchedForCdnCors', { value: true });
			webClientServerModule.serveFile = patchedServeFile;
		}
	} catch {
		// Module not present (e.g. bundled runtime); nothing to patch.
	}

	try {
		const http = await import('node:http');
		const originalEmit = http.Server.prototype.emit;
		if (typeof originalEmit === 'function' && !originalEmit.__patchedForStaticCors) {
			http.Server.prototype.emit = function (event, ...args) {
				if (event === 'request') {
					const [req, res] = args;
					try {
						const origin = req?.headers?.origin;
						if (typeof origin === 'string' && req?.url?.includes('/static/') && isAllowedStaticOrigin(origin) && typeof res?.setHeader === 'function') {
							traceCors(`http.emit ${req?.method} ${req?.url} origin=${origin}`);
							res.setHeader('Access-Control-Allow-Origin', origin);
							console.log(`[diagnostics-hooks] http.emit url=${req?.url} method=${req?.method} origin=${origin}`);
							if (typeof res.getHeader === 'function') {
								const currentVary = res.getHeader('Vary');
								if (Array.isArray(currentVary)) {
									if (!currentVary.includes('Origin')) {
										res.setHeader('Vary', [...currentVary, 'Origin']);
									}
								} else if (typeof currentVary === 'string' && currentVary.trim().length > 0) {
									const varyTokens = currentVary.split(',').map(token => token.trim());
									if (!varyTokens.includes('Origin')) {
										res.setHeader('Vary', `${currentVary}, Origin`);
									}
								} else {
									res.setHeader('Vary', 'Origin');
								}
							} else {
								res.setHeader('Vary', 'Origin');
							}
						}
					} catch (error) {
						console.warn('[diagnostics-hooks] Failed to apply static CORS header:', error);
					}
				}
				return originalEmit.call(this, event, ...args);
			};
			Object.defineProperty(http.Server.prototype.emit, '__patchedForStaticCors', { value: true });
		}
	} catch (error) {
		console.warn('[diagnostics-hooks] Unable to monkey patch http server for static CORS:', error);
	}

	// Additional diagnostic hooks can be added here if needed.

	try {
		const { Module } = await import('node:module');
		const originalLoad = Module._load;

		const maybeGetStringIdentifier = (exports) => {
			if (exports && typeof exports.getStringIdentifierForProxy === 'function') {
				return exports.getStringIdentifierForProxy;
			}
			return () => 'unknownProxy';
		};

		Module._load = function patchedLoad(request, parent, isMain) {
			const loaded = originalLoad.apply(this, arguments);
			try {
				if (typeof request === 'string' && request.includes('rpcProtocol')) {
					console.log('[diagnostics-hooks] Module load:', request);
				}
				if (typeof request === 'string' && /HostConnection/i.test(request)) {
					console.log('[diagnostics-hooks] Module load:', request);
				}
				if (typeof request === 'string'
					&& /rpcProtocol(\.js)?$/.test(request)
					&& loaded?.RPCProtocol
					&& !loaded.RPCProtocol.__openvscodeDiagnosticsPatched) {

					const { RPCProtocol, ResponsiveState } = loaded;
					const getStringIdentifierForProxy = maybeGetStringIdentifier(loaded);
					const proto = RPCProtocol.prototype;
					console.log('[diagnostics-hooks] Patching RPCProtocol module:', request);

					const ensurePendingMap = (self) => {
						if (!self._pendingRPCRequestInfo) {
							try {
								Object.defineProperty(self, '_pendingRPCRequestInfo', {
									value: Object.create(null),
									writable: true,
									enumerable: false,
									configurable: true
								});
							} catch {
								self._pendingRPCRequestInfo = Object.create(null);
							}
						}
						return self._pendingRPCRequestInfo;
					};

					const originalRemoteCall = proto._remoteCall;
					proto._remoteCall = function patchedRemoteCall(rpcId, methodName, args) {
						const result = originalRemoteCall.call(this, rpcId, methodName, args);
						try {
							const callId = String(this._lastMessageId);
							const map = ensurePendingMap(this);
							const labelPrefix = getStringIdentifierForProxy(rpcId);
							map[callId] = {
								label: `${labelPrefix}.${methodName}`,
								created: Date.now(),
								stack: new Error().stack
							};
						} catch (error) {
							console.warn('[RPCProtocol diagnostics] Failed to capture pending request info:', error instanceof Error ? error.message : error);
						}
						return result;
					};

					const originalReceiveReply = proto._receiveReply;
					proto._receiveReply = function patchedReceiveReply(msgLength, req, value) {
						const callId = String(req);
						try {
							const info = this._pendingRPCRequestInfo && this._pendingRPCRequestInfo[callId];
							if (info) {
								console.log(`[RPCProtocol] ⇒ reply #${callId} ${info.label} ok`);
							}
						} catch { /* noop */ }
						const outcome = originalReceiveReply.call(this, msgLength, req, value);
						if (this._pendingRPCRequestInfo) {
							delete this._pendingRPCRequestInfo[callId];
						}
						return outcome;
					};

					const originalReceiveReplyErr = proto._receiveReplyErr;
					proto._receiveReplyErr = function patchedReceiveReplyErr(msgLength, req, value) {
						const callId = String(req);
						try {
							const info = this._pendingRPCRequestInfo && this._pendingRPCRequestInfo[callId];
							if (info) {
								console.warn(`[RPCProtocol] ⇒ reply #${callId} ${info.label} error: ${value?.message ?? value}`);
							}
						} catch { /* noop */ }
						const outcome = originalReceiveReplyErr.call(this, msgLength, req, value);
						if (this._pendingRPCRequestInfo) {
							delete this._pendingRPCRequestInfo[callId];
						}
						return outcome;
					};

					const originalSetResponsiveState = proto._setResponsiveState;
					proto._setResponsiveState = function patchedSetResponsiveState(newState) {
						const previous = this._responsiveState;
						const result = originalSetResponsiveState.call(this, newState);
						try {
							if (previous !== newState) {
								if (newState === ResponsiveState.Unresponsive) {
									const entries = Object.entries(this._pendingRPCRequestInfo ?? {});
							if (entries.length) {
								const summary = entries.map(([id, info]) => `${id}:${info.label ?? 'unknown'}`).join(', ');
								console.warn(`[RPCProtocol] Extension host became unresponsive with ${entries.length} pending requests: ${summary}`);
							} else {
										console.warn('[RPCProtocol] Extension host became unresponsive but no pending request metadata was recorded.');
									}
								} else if (newState === ResponsiveState.Responsive) {
									console.warn('[RPCProtocol] Extension host reported responsive.');
								}
							}
						} catch (error) {
							console.warn('[RPCProtocol diagnostics] Failed to log responsive state change:', error instanceof Error ? error.message : error);
						}
						return result;
					};

					const originalReceiveRequest = proto._receiveRequest;
					proto._receiveRequest = function patchedReceiveRequest(msgLength, req, rpcId, method, args, usesCancellationToken) {
						try {
							console.log(`[RPCProtocol] ⇐ request #${String(req)} ${getStringIdentifierForProxy(rpcId)}.${method}`);
						} catch { /* noop */ }
						return originalReceiveRequest.call(this, msgLength, req, rpcId, method, args, usesCancellationToken);
					};

					Object.defineProperty(RPCProtocol, '__openvscodeDiagnosticsPatched', {
						value: true,
						writable: false,
						enumerable: false
					});
				}

				if (typeof request === 'string'
					&& /extensionHostConnection(\.js)?$/.test(request)
					&& loaded?.ExtensionHostConnection
					&& !loaded.ExtensionHostConnection.__openvscodeDiagnosticsPatched) {
					const proto = loaded.ExtensionHostConnection.prototype;
					const originalPipeSockets = proto._pipeSockets;
					proto._pipeSockets = async function patchedPipeSockets(extHostSocket, connectionData) {
						const prefix = `[${this?._remoteAddress ?? 'unknown'}][${(this?._reconnectionToken ?? '').toString().slice(0, 8)}]`;
						const info = (msg) => {
							try {
								this?._log?.call(this, msg);
							} catch {
								console.log('[diagnostics-hooks] ExtensionHostConnection', prefix, msg);
							}
						};
						const error = (msg) => {
							try {
								this?._logError?.call(this, msg);
							} catch {
								console.warn('[diagnostics-hooks] ExtensionHostConnection', prefix, msg);
							}
						};
						try {
							connectionData?.socket?.onClose?.((hadError) => info(`Client socket closed (hadError=${hadError}).`));
							connectionData?.socket?.onEnd?.(() => info('Client socket ended.'));
						} catch (err) {
							error(`Failed to instrument client socket: ${err instanceof Error ? err.message : String(err)}`);
						}
						try {
							if (typeof extHostSocket?.on === 'function') {
								extHostSocket.on('close', (hadError) => info(`Extension host socket closed (hadError=${hadError}).`));
								extHostSocket.on('end', () => info('Extension host socket ended.'));
								extHostSocket.on('error', (err) => {
									const message = err instanceof Error ? err.message : String(err);
									error(`Extension host socket error: ${message}`);
								});
							}
						} catch (err) {
							error(`Failed to instrument extension host socket: ${err instanceof Error ? err.message : String(err)}`);
						}
						return originalPipeSockets.apply(this, arguments);
					};
					Object.defineProperty(loaded.ExtensionHostConnection, '__openvscodeDiagnosticsPatched', {
						value: true,
						writable: false,
						enumerable: false
					});
				}
		} catch (error) {
			console.warn('[diagnostics-hooks] Unable to patch RPCProtocol diagnostics:', error instanceof Error ? error.message : error);
		}
		return loaded;
	};
	} catch (error) {
		console.warn('[diagnostics-hooks] Unable to install RPC diagnostics hooks:', error instanceof Error ? error.message : error);
	}
})();

export {};

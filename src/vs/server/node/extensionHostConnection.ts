/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as net from 'net';
import { TLSSocket } from 'tls';
import { VSBuffer } from '../../base/common/buffer.js';
import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { FileAccess } from '../../base/common/network.js';
import { delimiter, join } from '../../base/common/path.js';
import { IProcessEnvironment, isWindows } from '../../base/common/platform.js';
import { removeDangerousEnvVariables } from '../../base/common/processes.js';
import { createRandomIPCHandle, NodeSocket, WebSocketNodeSocket } from '../../base/parts/ipc/node/ipc.net.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IRemoteExtensionHostStartParams } from '../../platform/remote/common/remoteAgentConnection.js';
import { getResolvedShellEnv } from '../../platform/shell/node/shellEnv.js';
import { IExtensionHostStatusService } from './extensionHostStatusService.js';
import { getNLSConfiguration } from './remoteLanguagePacks.js';
import { IServerEnvironmentService } from './serverEnvironmentService.js';
import { IPCExtHostConnection, SocketExtHostConnection, writeExtHostConnection } from '../../workbench/services/extensions/common/extensionHostEnv.js';
import { IExtHostReadyMessage, IExtHostReduceGraceTimeMessage, IExtHostSocketMessage } from '../../workbench/services/extensions/common/extensionHostProtocol.js';

export async function buildUserEnvironment(startParamsEnv: { [key: string]: string | null } = {}, withUserShellEnvironment: boolean, language: string, environmentService: IServerEnvironmentService, logService: ILogService, configurationService: IConfigurationService): Promise<IProcessEnvironment> {
	const nlsConfig = await getNLSConfiguration(language, environmentService.userDataPath);

	let userShellEnv: typeof process.env = {};
	if (withUserShellEnvironment) {
		try {
			userShellEnv = await getResolvedShellEnv(configurationService, logService, environmentService.args, process.env);
		} catch (error) {
			logService.error('ExtensionHostConnection#buildUserEnvironment resolving shell environment failed', error);
		}
	}

	const processEnv = process.env;

	const env: IProcessEnvironment = {
		...processEnv,
		...userShellEnv,
		...{
			VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
			VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
			VSCODE_NLS_CONFIG: JSON.stringify(nlsConfig)
		},
		...startParamsEnv
	};

	const binFolder = environmentService.isBuilt ? join(environmentService.appRoot, 'bin') : join(environmentService.appRoot, 'resources', 'server', 'bin-dev');
	const remoteCliBinFolder = join(binFolder, 'remote-cli'); // contains the `code` command that can talk to the remote server

	let PATH = readCaseInsensitive(env, 'PATH');
	if (PATH) {
		PATH = remoteCliBinFolder + delimiter + PATH;
	} else {
		PATH = remoteCliBinFolder;
	}
	setCaseInsensitive(env, 'PATH', PATH);

	if (!environmentService.args['without-browser-env-var']) {
		env.BROWSER = join(binFolder, 'helpers', isWindows ? 'browser.cmd' : 'browser.sh'); // a command that opens a browser on the local machine
	}

	removeNulls(env);
	return env;
}

class ConnectionData {
	constructor(
		public readonly socket: NodeSocket | WebSocketNodeSocket,
		public readonly initialDataChunk: VSBuffer
	) { }

	public socketDrain(): Promise<void> {
		return this.socket.drain();
	}

	public toIExtHostSocketMessage(): IExtHostSocketMessage {

		let skipWebSocketFrames: boolean;
		let permessageDeflate: boolean;
		let inflateBytes: VSBuffer;

		if (this.socket instanceof NodeSocket) {
			skipWebSocketFrames = true;
			permessageDeflate = false;
			inflateBytes = VSBuffer.alloc(0);
		} else {
			skipWebSocketFrames = false;
			permessageDeflate = this.socket.permessageDeflate;
			inflateBytes = this.socket.recordedInflateBytes;
		}

		return {
			type: 'VSCODE_EXTHOST_IPC_SOCKET',
			initialDataChunk: (<Buffer>this.initialDataChunk.buffer).toString('base64'),
			skipWebSocketFrames: skipWebSocketFrames,
			permessageDeflate: permessageDeflate,
			inflateBytes: (<Buffer>inflateBytes.buffer).toString('base64'),
		};
	}
}

export class ExtensionHostConnection extends Disposable {

	private _onClose = new Emitter<void>();
	readonly onClose: Event<void> = this._onClose.event;

	private readonly _createdAt: number = Date.now();
	private readonly _canSendSocket: boolean;
	private _disposed: boolean;
	private _remoteAddress: string;
	private _extensionHostProcess: cp.ChildProcess | null;
	private _connectionData: ConnectionData | null;

	constructor(
		private readonly _reconnectionToken: string,
		remoteAddress: string,
		socket: NodeSocket | WebSocketNodeSocket,
		initialDataChunk: VSBuffer,
		@IServerEnvironmentService private readonly _environmentService: IServerEnvironmentService,
		@ILogService private readonly _logService: ILogService,
		@IExtensionHostStatusService private readonly _extensionHostStatusService: IExtensionHostStatusService,
		@IConfigurationService private readonly _configurationService: IConfigurationService
	) {
		super();
		this._disposed = false;
		this._remoteAddress = remoteAddress;
		this._extensionHostProcess = null;
		this._connectionData = this._createConnectionData(socket, initialDataChunk);
		this._canSendSocket = (!isWindows || !this._environmentService.args['socket-path']) && ExtensionHostConnection._canSendSocketHandle(this._connectionData);

		this._log(`New connection established.`);
		this._log(`Initial data chunk length: ${initialDataChunk.byteLength} bytes.`);
	}

	override dispose(): void {
		this._cleanResources();
		super.dispose();
	}

	private get _logPrefix(): string {
		return `[${this._remoteAddress}][${this._reconnectionToken.substr(0, 8)}][ExtensionHostConnection] `;
	}

	private _log(_str: string): void {
		this._logService.info(`${this._logPrefix}${_str}`);
	}

	private _logError(_str: string): void {
		this._logService.error(`${this._logPrefix}${_str}`);
	}

	public isDisposed(): boolean {
		return this._disposed;
	}

	public getCreatedAt(): number {
		return this._createdAt;
	}

	private async _pipeSockets(extHostSocket: net.Socket, connectionData: ConnectionData): Promise<void> {

		const disposables = new DisposableStore();
		disposables.add(connectionData.socket);
		disposables.add(toDisposable(() => {
			extHostSocket.destroy();
		}));

		let cleaned = false;
		const stopAndCleanup = (reason: string) => {
			if (cleaned) {
				return;
			}
			cleaned = true;
			this._log(`Connection transport disposing (reason=${reason}).`);
			disposables.dispose();
		};

		disposables.add(connectionData.socket.onEnd(() => stopAndCleanup('client socket end')));
		disposables.add(connectionData.socket.onClose((hadError) => stopAndCleanup(`client socket close (hadError=${hadError})`)));

		disposables.add(Event.fromNodeEventEmitter<void>(extHostSocket, 'end')(() => stopAndCleanup('extHostSocket end')));
		disposables.add(Event.fromNodeEventEmitter<boolean>(extHostSocket, 'close')((hadError) => stopAndCleanup(`extHostSocket close (hadError=${hadError})`)));
		disposables.add(Event.fromNodeEventEmitter<Error>(extHostSocket, 'error')((err) => {
			const message = err instanceof Error ? err.message : String(err);
			this._logError(`<${this._extensionHostProcess?.pid ?? 'unknown'}> extHostSocket error: ${message}`);
			stopAndCleanup('extHostSocket error');
		}));

		disposables.add(connectionData.socket.onData((e) => extHostSocket.write(e.buffer)));
		disposables.add(Event.fromNodeEventEmitter<Buffer>(extHostSocket, 'data')((e) => {
			connectionData.socket.write(VSBuffer.wrap(e));
		}));

		if (connectionData.initialDataChunk.byteLength > 0) {
			extHostSocket.write(connectionData.initialDataChunk.buffer);
		}
	}

	private async _sendSocketToExtensionHost(extensionHostProcess: cp.ChildProcess, connectionData: ConnectionData): Promise<void> {
		// Make sure all outstanding writes have been drained before sending the socket
		await connectionData.socketDrain();
		this._log(`<${extensionHostProcess.pid}> Preparing to send connection socket to extension host.`);
		const msg = connectionData.toIExtHostSocketMessage();
		const socket = ExtensionHostConnection._getNodeSocket(connectionData);
		const socketHandleInfo = (() => {
			if (!socket) {
				return 'undefined';
			}
			const handleName = (socket as unknown as { _handle?: { constructor?: { name?: string } } })._handle?.constructor?.name ?? 'nohandle';
			return `${socket.constructor?.name ?? 'unknown'}:${handleName}`;
		})();
		this._log(`<${extensionHostProcess.pid}> Socket state destroyed=${socket?.destroyed} closed=${(socket as unknown as { closed?: boolean }).closed ?? 'unknown'} readable=${socket?.readable} writable=${socket?.writable} pending=${(socket as unknown as { pending?: boolean }).pending ?? 'unknown'} handle=${socketHandleInfo}`);
		if (!socket || socket.destroyed || (socket as unknown as { closed?: boolean }).closed === true || !ExtensionHostConnection._hasReusableHandle(socket)) {
			this._logError(`<${extensionHostProcess.pid}> Connection socket was closed before it could be handed off to the extension host.`);
			this._cleanResources();
			return;
		}
		extensionHostProcess.send(msg, socket, (err) => {
			if (err) {
				this._logError(`<${extensionHostProcess.pid}> Failed to send socket to extension host: ${err?.message ?? err}`);
			} else {
				this._log(`<${extensionHostProcess.pid}> Connection socket handed off to extension host.`);
			}
		});
	}

	public shortenReconnectionGraceTimeIfNecessary(): void {
		if (!this._extensionHostProcess) {
			return;
		}
		const msg: IExtHostReduceGraceTimeMessage = {
			type: 'VSCODE_EXTHOST_IPC_REDUCE_GRACE_TIME'
		};
		this._extensionHostProcess.send(msg);
	}

	public acceptReconnection(remoteAddress: string, _socket: NodeSocket | WebSocketNodeSocket, initialDataChunk: VSBuffer): void {
		this._remoteAddress = remoteAddress;
		this._log(`The client has reconnected.`);
		this._log(`Reconnection initial data chunk length: ${initialDataChunk.byteLength} bytes.`);
		const connectionData = this._createConnectionData(_socket, initialDataChunk);

		if (!this._extensionHostProcess) {
			// The extension host didn't even start up yet
			this._log(`Extension host process not yet running; storing connection data.`);
			this._connectionData = connectionData;
			return;
		}

		this._log(`Forwarding reconnection socket to extension host <${this._extensionHostProcess.pid}>.`);
		this._sendSocketToExtensionHost(this._extensionHostProcess, connectionData);
	}

	private _createConnectionData(socket: NodeSocket | WebSocketNodeSocket, initialDataChunk: VSBuffer): ConnectionData {
		const sanitizedChunk = this._sanitizeInitialData(initialDataChunk);
		return new ConnectionData(socket, sanitizedChunk);
	}

	private _sanitizeInitialData(initialDataChunk: VSBuffer): VSBuffer {
		if (!initialDataChunk.byteLength) {
			return initialDataChunk;
		}

		try {
			const raw = initialDataChunk.toString();
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				const currentPid = process.pid;
				const previousPid = (parsed as { parentPid?: unknown }).parentPid;
				if (typeof currentPid === 'number' && currentPid > 0) {
					if (previousPid !== currentPid) {
						const previousPidDescription = typeof previousPid === 'number' ? previousPid.toString() : String(previousPid ?? 'undefined');
						this._log(`Normalizing parentPid in init data from ${previousPidDescription} to ${currentPid}.`);
					}
					(parsed as { parentPid: number }).parentPid = currentPid;
				}
				return VSBuffer.fromString(JSON.stringify(parsed));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._logError(`Failed to normalize extension host init data: ${message}`);
		}
		return initialDataChunk;
	}

	private _cleanResources(): void {
		if (this._disposed) {
			// already called
			return;
		}
		this._disposed = true;
		this._log(`Cleaning resources (pendingConnectionData=${!!this._connectionData}, hasProcess=${!!this._extensionHostProcess}).`);
		if (this._connectionData) {
			this._log(`Closing pending connection data socket.`);
			this._connectionData.socket.end();
			this._connectionData = null;
		}
		if (this._extensionHostProcess) {
			this._log(`Killing extension host process <${this._extensionHostProcess.pid}> as part of cleanup.`);
			this._extensionHostProcess.kill();
			this._extensionHostProcess = null;
		}
		this._onClose.fire(undefined);
	}

	public async start(startParams: IRemoteExtensionHostStartParams): Promise<void> {
		try {
			let execArgv: string[] = process.execArgv ? process.execArgv.filter(a => !/^--inspect(-brk)?=/.test(a)) : [];
			if (startParams.port && !(<any>process).pkg) {
				execArgv = [
					`--inspect${startParams.break ? '-brk' : ''}=${startParams.port}`,
					'--experimental-network-inspection'
				];
			}

			const env = await buildUserEnvironment(startParams.env, true, startParams.language, this._environmentService, this._logService, this._configurationService);
			removeDangerousEnvVariables(env);
			this._log(`Starting extension host with debugPort=${startParams.port ?? "none"}, breakMode=${startParams.break ? "true" : "false"}.`);

			let extHostNamedPipeServer: net.Server | null;

			if (this._canSendSocket) {
				writeExtHostConnection(new SocketExtHostConnection(), env);
				extHostNamedPipeServer = null;
			} else {
				this._log(`Socket hand-off disabled, using named pipe transport (tls=${ExtensionHostConnection._isTlsConnection(this._connectionData)}).`);
				const { namedPipeServer, pipeName } = await this._listenOnPipe();
				writeExtHostConnection(new IPCExtHostConnection(pipeName), env);
				extHostNamedPipeServer = namedPipeServer;
			}

			const opts = {
				env,
				execArgv,
				silent: true
			};

			// Refs https://github.com/microsoft/vscode/issues/189805
			opts.execArgv.unshift('--dns-result-order=ipv4first');

			// Run Extension Host as fork of current process
			const args = ['--type=extensionHost', `--transformURIs`];
			const useHostProxy = this._environmentService.args['use-host-proxy'];
			args.push(`--useHostProxy=${useHostProxy ? 'true' : 'false'}`);
			if (this._configurationService.getValue<boolean>('extensions.supportNodeGlobalNavigator')) {
				args.push('--supportGlobalNavigator');
			}
			this._extensionHostProcess = cp.fork(FileAccess.asFileUri('bootstrap-fork').fsPath, args, opts);
			const pid = this._extensionHostProcess.pid;
			this._log(`<${pid}> Launched Extension Host Process.`);

		// Catch all output coming from the extension host process
		this._extensionHostProcess.stdout!.setEncoding('utf8');
		this._extensionHostProcess.stderr!.setEncoding('utf8');
		const onStdout = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stdout!, 'data');
		const onStderr = Event.fromNodeEventEmitter<string>(this._extensionHostProcess.stderr!, 'data');
		this._register(onStdout((e) => {
			const trimmed = e.trimEnd();
			if (trimmed.length) {
				this._log(`<${pid}><stdout> ${trimmed}`);
			}
		}));
		this._register(onStderr((e) => {
			const trimmed = e.trimEnd();
			if (trimmed.length) {
				this._logError(`<${pid}><stderr> ${trimmed}`);
			}
		}));

			// Lifecycle
		this._extensionHostProcess.on('error', (err) => {
			const lifetime = Date.now() - this._createdAt;
			this._logError(`<${pid}> Extension Host Process emitted 'error' after ${lifetime}ms`);
			if (err) {
				this._logService.error(err);
			}
				this._cleanResources();
			});

		this._extensionHostProcess.on('exit', (code: number, signal: string) => {
			this._extensionHostStatusService.setExitInfo(this._reconnectionToken, { code, signal });
			const lifetime = Date.now() - this._createdAt;
			if (code === 0 && !signal) {
				this._log(`<${pid}> Extension Host Process exited normally after ${lifetime}ms.`);
			} else {
				this._logError(`<${pid}> Extension Host Process exited unexpectedly after ${lifetime}ms (code: ${code}, signal: ${signal}).`);
			}
			this._log(`<${pid}> buffered stdout/stderr up to this point processed by log handlers.`);
			this._cleanResources();
		});

			if (extHostNamedPipeServer) {
				extHostNamedPipeServer.on('connection', (socket) => {
					extHostNamedPipeServer.close();
					this._pipeSockets(socket, this._connectionData!);
				});
			} else {
			const messageListener = (msg: IExtHostReadyMessage) => {
				if (msg.type === 'VSCODE_EXTHOST_IPC_READY') {
					this._log(`<${pid}> Extension host signalled IPC ready.`);
					this._extensionHostProcess!.removeListener('message', messageListener);
					this._sendSocketToExtensionHost(this._extensionHostProcess!, this._connectionData!);
					this._connectionData = null;
				}
			};
				this._extensionHostProcess.on('message', messageListener);
			}

		} catch (error) {
			const duration = Date.now() - this._createdAt;
			this._logError(`ExtensionHostConnection start failed after ${duration}ms`);
			if (error instanceof Error) {
				this._logService.error(error);
			} else if (error !== undefined) {
				this._logService.error(String(error));
			}
			this._extensionHostStatusService.setExitInfo(this._reconnectionToken, { code: -1, signal: '' });
		}
	}

	private static _getNodeSocket(connectionData: ConnectionData | null): net.Socket | null {
		if (!connectionData) {
			return null;
		}
		if (connectionData.socket instanceof NodeSocket) {
			return connectionData.socket.socket;
		}
		// WebSocketNodeSocket wraps a NodeSocket which itself wraps the actual socket.
		return connectionData.socket.socket?.socket ?? null;
	}

	private static _hasReusableHandle(socket: net.Socket): boolean {
		const handle = (socket as unknown as { _handle?: { constructor?: { name?: string } } })._handle;
		if (!handle) {
			return false;
		}
		const handleName = handle.constructor?.name;
		if (handleName === 'TLSWrap') {
			return false;
		}
		return true;
	}

	private static _canSendSocketHandle(connectionData: ConnectionData | null): boolean {
		if (this._isTlsConnection(connectionData)) {
			return false;
		}
		const socket = this._getNodeSocket(connectionData);
		if (!socket) {
			return false;
		}
		return this._hasReusableHandle(socket);
	}

	private static _isTlsConnection(connectionData: ConnectionData | null): boolean {
		if (!connectionData) {
			return false;
		}
		const socket = this._getNodeSocket(connectionData);
		if (!socket) {
			return false;
		}
		return socket instanceof TLSSocket || (socket as unknown as { encrypted?: boolean }).encrypted === true;
	}

	private _listenOnPipe(): Promise<{ pipeName: string; namedPipeServer: net.Server }> {
		return new Promise<{ pipeName: string; namedPipeServer: net.Server }>((resolve, reject) => {
			const pipeName = createRandomIPCHandle();

			const namedPipeServer = net.createServer();
			namedPipeServer.on('error', reject);
			namedPipeServer.listen(pipeName, () => {
				namedPipeServer?.removeListener('error', reject);
				resolve({ pipeName, namedPipeServer });
			});
		});
	}
}

function readCaseInsensitive(env: { [key: string]: string | undefined }, key: string): string | undefined {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	return env[pathKey];
}

function setCaseInsensitive(env: { [key: string]: unknown }, key: string, value: string): void {
	const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === key.toLowerCase());
	const pathKey = pathKeys.length > 0 ? pathKeys[0] : key;
	env[pathKey] = value;
}

function removeNulls(env: { [key: string]: unknown | null }): void {
	// Don't delete while iterating the object itself
	for (const key of Object.keys(env)) {
		if (env[key] === null) {
			delete env[key];
		}
	}
}

declare module "ws" {
	import { IncomingMessage } from "node:http";
	import { EventEmitter } from "node:events";

	export class WebSocket extends EventEmitter {
		send(data: any, cb?: (err?: Error) => void): void;
		close(code?: number, data?: string): void;
		on(event: "message", listener: (data: any, isBinary: boolean) => void): this;
		on(event: "close", listener: (code: number, reason: Buffer) => void): this;
		on(event: "error", listener: (err: Error) => void): this;
		on(event: string, listener: (...args: any[]) => void): this;
	}

	export interface ServerOptions {
		noServer?: boolean;
		port?: number;
		server?: any;
	}

	export class WebSocketServer extends EventEmitter {
		constructor(options?: ServerOptions);
		handleUpgrade(request: IncomingMessage, socket: any, head: any, callback: (ws: WebSocket) => void): void;
		close(cb?: (err?: Error) => void): void;
		on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
		on(event: string, listener: (...args: any[]) => void): this;
	}
}

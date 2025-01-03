import https from "https";
import fs from "fs";

import dotenv from "dotenv";
import {WebSocketServer, WebSocket} from "ws";
import {createServer, Socket} from "net";


// 加載環境變數
dotenv.config({
	path: [".env", ".env.local", ".env.prod"],
	override: true,
});

const controlHost = process.env.CONTROL_HOST || "127.0.0.1";
const controlPort = parseInt(process.env.CONTROL_PORT || "8000", 10);
const externalHost = process.env.EXTERNAL_HOST || "127.0.0.1";
const externalPort = parseInt(process.env.EXTERNAL_PORT || "9000", 10);
const verifyClientCert = parseInt(process.env.VERIFY_CLIENT_CERT || "1", 10) !== 0;

const MAX_BUFFER_SIZE = 1 * 1024 * 1024; // 1 MB
const PING_INTERVAL = 5000; // 每 5 秒發送一次 ping
const PING_TIMEOUT = 30000; // 30 秒沒收到 pong 就斷開

let currentClient: {
	ws: WebSocket;
	links: Map<number, { socket: Socket; buffer: Buffer[]; confirmed: boolean; bufferSize: number }>;
	pingTimeout?: NodeJS.Timeout;
	isAlive: boolean;
} | null = null;
const activeLinkIds: Set<number> = new Set();

// TLS options for server
const tlsOptions: https.ServerOptions = {
	key: fs.readFileSync(process.env.SERVER_KEY_PATH || "./server-key.pem"),
	cert: fs.readFileSync(process.env.SERVER_CERT_PATH || "./server-root-cert.pem"),
	ca: process.env.SERVER_CA_CERT_PATH ? fs.readFileSync(process.env.SERVER_CA_CERT_PATH) : undefined,
	requestCert: verifyClientCert,
	rejectUnauthorized: verifyClientCert,
};

// HTTPS server for TLS
const httpsServer = https.createServer(tlsOptions);

// 封包處理：將類型、link_id 和內容編碼為二進制
function encodeMessage(type: number, linkId: number, content: Buffer = Buffer.alloc(0)): Buffer {
	const typeBuffer = Buffer.alloc(4);
	const linkIdBuffer = Buffer.alloc(4);

	typeBuffer.writeUInt32BE(type, 0);
	linkIdBuffer.writeUInt32BE(linkId, 0);

	return Buffer.concat([typeBuffer, linkIdBuffer, content]);
}

// 解包處理：將二進制訊息解碼為物件
function decodeMessage(buffer: Buffer): { type: number; linkId: number; content: Buffer } {
	const type = buffer.readUInt32BE(0);
	const linkId = buffer.readUInt32BE(4);
	const content = buffer.slice(8);

	return { type, linkId, content };
}

// 隨機生成唯一的 link_id
function generateUniqueLinkId(): number {
	let linkId: number;
	do {
		linkId = Math.floor(Math.random() * 0xffffffff);
	} while (activeLinkIds.has(linkId));
	activeLinkIds.add(linkId);
	return linkId;
}

function heartbeat(ws: WebSocket) {
	if (!currentClient) return;
	currentClient.isAlive = true;

	// 清除舊的 timeout
	if (currentClient.pingTimeout) {
		clearTimeout(currentClient.pingTimeout);
	}

	// 設置新的 timeout
	currentClient.pingTimeout = setTimeout(() => {
		console.log("Client ping timeout, terminating connection");
		ws.terminate();
	}, PING_TIMEOUT);
}

// WebSocket server over HTTPS
const controlServer = new WebSocketServer({
	server: httpsServer,
	clientTracking: true
});

// 定期發送 ping
const interval = setInterval(() => {
	if (currentClient && currentClient.ws.readyState === WebSocket.OPEN) {
		if (!currentClient.isAlive) {
			console.log("Client not responding to ping, terminating connection");
			currentClient.ws.terminate();
			return;
		}
		currentClient.isAlive = false;
		currentClient.ws.ping();
	}
}, PING_INTERVAL);

controlServer.on("connection", (ws, req) => {
	if (verifyClientCert) {
		const cert = req.socket.getPeerCertificate();
		if (!cert) {
			console.log("No client certificate provided. Connection rejected.");
			ws.close(1001, "Client certificate required.");
			return;
		}
	}

	if (currentClient) {
		console.log("A client is already connected, rejecting new connection.");
		ws.close(1001, "A client is already connected.");
		return;
	}

	console.log(`Client connected: ${req.socket.remoteAddress}`);
	currentClient = { ws, links: new Map(), isAlive: true };

	// 設置初始 heartbeat
	heartbeat(ws);

	ws.on("pong", () => heartbeat(ws));
	ws.on("message", (message: Buffer) => handleControlData(message));
	ws.on("close", () => {
		console.log("Client disconnected.");
		if (currentClient?.pingTimeout) {
			clearTimeout(currentClient.pingTimeout);
		}
		currentClient?.links.forEach(({ socket }, linkId) => {
			socket.end();
			activeLinkIds.delete(linkId);
		});
		currentClient = null;
	});
});

const externalServer = createServer((externalSocket: Socket) => {
	const linkId = generateUniqueLinkId();
	console.log(`External connection received: link_id=${linkId}`);

	if (!currentClient) {
		console.log("No available client, closing connection.");
		externalSocket.end();
		activeLinkIds.delete(linkId);
		return;
	}

	currentClient.links.set(linkId, {
		socket: externalSocket,
		buffer: [],
		confirmed: false,
		bufferSize: 0,
	});

	currentClient.ws.send(encodeMessage(0, linkId)); // 0 表示 create_link

	externalSocket.on("data", (data) => {
		const link = currentClient?.links.get(linkId);
		if (link) {
			if (!link.confirmed) {
				// 暫存數據
				link.buffer.push(data);
				link.bufferSize += data.length;

				if (link.bufferSize > MAX_BUFFER_SIZE) {
					console.log(`Buffer exceeded for link_id=${linkId}. Closing connection.`);
					externalSocket.end();
					currentClient!.links.delete(linkId);
					activeLinkIds.delete(linkId);
				}
			} else {
				// 已確認，直接轉發
				currentClient!.ws.send(encodeMessage(2, linkId, data));
			}
		}
	});

	externalSocket.on("close", () => {
		currentClient?.links.delete(linkId);
		activeLinkIds.delete(linkId);
	});

	externalSocket.on("error", () => {
		currentClient?.links.delete(linkId);
		activeLinkIds.delete(linkId);
	});
});

externalServer.listen(externalPort, externalHost, () => {
	console.log(`External server listening on ${externalHost}:${externalPort}`);
});

httpsServer.listen(controlPort, controlHost, () => {
	console.log(`Control server with TLS listening on ${controlHost}:${controlPort}`);
});

function handleControlData(message: Buffer): void {
	if (!currentClient) return;

	const { type, linkId, content } = decodeMessage(message);

	if (type === 0) {
		// link_ready
		const link = currentClient.links.get(linkId);
		if (link) {
			console.log(`Link ready confirmed for link_id=${linkId}`);
			link.confirmed = true;

			// 發送緩存數據
			link.buffer.forEach((chunk) => {
				currentClient!.ws.send(encodeMessage(2, linkId, chunk));
			});
			link.buffer = [];
			link.bufferSize = 0;
		}
	} else if (type === 1) {
		// close_link
		const link = currentClient.links.get(linkId);
		if (link) {
			console.log(`Closing link_id=${linkId}`);
			link.socket.end();
			currentClient.links.delete(linkId);
			activeLinkIds.delete(linkId);
		}
	} else if (type === 2) {
		// stream_data
		const link = currentClient.links.get(linkId);
		if (link && link.confirmed) {
			console.log(`Forwarding stream_data to link_id=${linkId}`);
			link.socket.write(content);
		} else {
			console.error(`Link ID ${linkId} not ready or not found for stream_data.`);
		}
	} else {
		console.log(`Unknown type=${type} received.`);
	}
}
import https from "https";
import fs from "fs";
import net from "net";
import crypto from 'crypto';

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
const authorizedClientsPath = process.env.AUTHORIZED_CLIENTS || '';
const authorizedClients: string[] = [];

// Function to load authorized clients from the file
function loadAuthorizedClients() {
	try {
		const data = fs.readFileSync(authorizedClientsPath, 'utf-8');
		authorizedClients.splice(0, authorizedClients.length, ...data.split('\n').filter(line => line.trim() !== ''));
		console.log(`Authorized clients updated: ${authorizedClients}`);
	}
	catch (err) {
		console.error(`Error reading authorized clients file: ${err.message}`);
	}
}

if (!fs.existsSync(authorizedClientsPath)) {
	fs.writeFileSync(authorizedClientsPath, '', 'utf-8');
	console.log(`Authorized clients not found, created empty file: ${authorizedClientsPath}`);
}

// Watch for changes in the authorized clients file
fs.watch(authorizedClientsPath, (eventType) => {
	if (eventType === 'change') {
		console.log(`Authorized clients file changed. Reloading...`);
		loadAuthorizedClients();
	}
});

// Initial load of authorized clients
loadAuthorizedClients();



const SERVER_KEY_PATH = process.env.SERVER_KEY_PATH;
const SERVER_CERT_PATH = process.env.SERVER_CERT_PATH;
if ( !SERVER_KEY_PATH || !SERVER_CERT_PATH ) {
	console.error("SERVER_KEY_PATH or SERVER_CERT_PATH is not set.");
	process.exit(1);
}

const MAX_BUFFER_SIZE = 1 * 1024 * 1024; // 1 MB
const PING_INTERVAL = 5000; // 每 5 秒發送一次 ping
const PING_TIMEOUT = 30000; // 30 秒沒收到 pong 就斷開

// 新增 activeServers 來追蹤已綁定的服務器
const activeServers = new Map<string, {
	server: net.Server;
	clients: Set<WebSocket>;
}>();

const clients = new Map<WebSocket, {
	links: Map<number, { socket: Socket; buffer: Buffer[]; confirmed: boolean; bufferSize: number }>;
	pingTimeout?: NodeJS.Timeout;
	isAlive: boolean;
	boundServers: Set<string>;
}>();

const activeLinkIds: Set<number> = new Set();

// TLS options for server
const tlsOptions: https.ServerOptions = {
	key: fs.readFileSync(SERVER_KEY_PATH),
	cert: fs.readFileSync(SERVER_CERT_PATH),
	requestCert: true,
	rejectUnauthorized: false,
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
	const content = buffer.subarray(8);

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
	const client = clients.get(ws);
	if (!client) return;

	client.isAlive = true;

	if (client.pingTimeout) {
		clearTimeout(client.pingTimeout);
	}

	client.pingTimeout = setTimeout(() => {
		console.log("Client ping timeout, terminating connection");
		ws.terminate();
	}, PING_TIMEOUT);
}

// WebSocket server over HTTPS
const controlServer = new WebSocketServer({
	server: httpsServer,
	clientTracking: true
});

// 修改定期發送 ping 的邏輯
setInterval(() => {
	for (const [ws, client] of clients.entries()) {
		if (ws.readyState === WebSocket.OPEN) {
			if (!client.isAlive) {
				console.log("Client not responding to ping, terminating connection");
				ws.terminate();
				continue;
			}
			client.isAlive = false;
			ws.ping();
		}
	}
}, PING_INTERVAL);

function isWhitelisted(publicKey: Buffer): boolean {
	const publicKeyHash = crypto.createHash('sha1').update(publicKey).digest('hex');
	return authorizedClients.includes(publicKeyHash);
}

controlServer.on("connection", (ws, req) => {
	const cert = req.socket.getPeerCertificate();
	if (!cert) {
		console.log("No client certificate provided. Connection rejected.");
		ws.close(1001, "Client certificate required.");
		return;
	}

	const publicKey = cert.pubkey;
	if (!publicKey) {
		console.log('Connection rejected: No public key provided');
		ws.close(1001, "Client certificate required.");
		return;
	}

	if (!isWhitelisted(publicKey)) {
		console.log('Connection rejected: Public key not whitelisted');
		ws.close(1001, "Client certificate not whitelisted.");
		return;
	}

	console.log(`Client connected: ${req.socket.remoteAddress}`);

	// 將新客戶端加入 clients Map
	clients.set(ws, {
		links: new Map(),
		isAlive: true,
		boundServers: new Set()
	});

	heartbeat(ws);

	ws.on("pong", () => heartbeat(ws));
	ws.on("message", (message: Buffer) => handleControlData(ws, message));
	ws.on("close", () => {
		console.log("Client disconnected.");
		const client = clients.get(ws);

		if (client?.pingTimeout) {
			clearTimeout(client.pingTimeout);
		}

		// 處理客戶端綁定的服務器
		if (client) {
			for (const serverKey of client.boundServers) {
				const serverInfo = activeServers.get(serverKey);
				if (serverInfo) {
					serverInfo.clients.delete(ws);
					if (serverInfo.clients.size === 0) {
						console.log(`Closing server ${serverKey} - no clients remaining`);
						serverInfo.server.close();
						activeServers.delete(serverKey);
					}
				}
			}

			// 清理客戶端的連接
			client.links.forEach(({ socket }, linkId) => {
				socket.end();
				activeLinkIds.delete(linkId);
			});
		}

		clients.delete(ws);
	});
});

httpsServer.listen(controlPort, controlHost, () => {
	console.log(`Control server with TLS listening on ${controlHost}:${controlPort}`);
});

function handleControlData(ws: WebSocket, message: Buffer): void {
	const client = clients.get(ws);
	if (!client) return;

	const { type, linkId, content } = decodeMessage(message);

	if (type === 10) { // bind 事件
		const port = content.readUInt16BE(0);
		const host = content.subarray(2).toString('utf8');
		const serverKey = `${host}:${port}`;

		// 檢查服務器是否已存在
		const existingServer = activeServers.get(serverKey);
		if (existingServer) {
			// 如果服務器已存在，將當前客戶端加入到客戶端列表中
			existingServer.clients.add(ws);
			client.boundServers.add(serverKey);

			// 發送綁定成功響應
			ws.send(encodeMessage(11, linkId, Buffer.from(JSON.stringify({
				success: true
			}))));
			return;
		}

		// 創建新的服務器
		const server = createServer((socket: Socket) => {
			const newLinkId = generateUniqueLinkId();
			console.log(`New connection on ${serverKey}: link_id=${newLinkId}`);

			client.links.set(newLinkId, {
				socket,
				buffer: [],
				confirmed: false,
				bufferSize: 0,
			});

			ws.send(encodeMessage(0, newLinkId));

			socket.on("data", (data) => {
				const link = client.links.get(newLinkId);
				if (link) {
					if (!link.confirmed) {
						link.buffer.push(data);
						link.bufferSize += data.length;

						if (link.bufferSize > MAX_BUFFER_SIZE) {
							socket.end();
							client.links.delete(newLinkId);
							activeLinkIds.delete(newLinkId);
						}
					} else {
						ws.send(encodeMessage(2, newLinkId, data));
					}
				}
			});

			socket.on("close", () => {
				client.links.delete(newLinkId);
				activeLinkIds.delete(newLinkId);
			});

			socket.on("error", () => {
				client.links.delete(newLinkId);
				activeLinkIds.delete(newLinkId);
			});
		});

		server.listen(port, host, () => {
			console.log(`New server bound to ${serverKey}`);
			activeServers.set(serverKey, {
				server,
				clients: new Set([ws])
			});
			client.boundServers.add(serverKey);

			ws.send(encodeMessage(11, linkId, Buffer.from(JSON.stringify({
				success: true
			}))));
		});

		server.on("error", (err) => {
			console.error(`Failed to bind server ${serverKey}:`, err);
			ws.send(encodeMessage(11, linkId, Buffer.from(JSON.stringify({
				success: false,
				error: err.message
			}))));
		});
	} else if (type === 0) { // link_ready
		const link = client.links.get(linkId);
		if (link) {
			console.log(`Link ready confirmed for link_id=${linkId}`);
			link.confirmed = true;

			link.buffer.forEach((chunk) => {
				ws.send(encodeMessage(2, linkId, chunk));
			});
			link.buffer = [];
			link.bufferSize = 0;
		}
	} else if (type === 1) { // close_link
		const link = client.links.get(linkId);
		if (link) {
			console.log(`Closing link_id=${linkId}`);
			link.socket.end();
			client.links.delete(linkId);
			activeLinkIds.delete(linkId);
		}
	} else if (type === 2) { // stream_data
		const link = client.links.get(linkId);
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
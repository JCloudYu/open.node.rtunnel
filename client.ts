import fs from "fs";
import {createConnection, Socket} from "net";

import dotenv from "dotenv";
import WebSocket from "ws";

// 加載環境變數
dotenv.config({
	path: [".env", ".env.local", ".env.prod"],
	override: true,
});

const controlHost = process.env.REMOTE_HOST || "127.0.0.1";
const controlPort = parseInt(process.env.REMOTE_PORT || "8000", 10);
const localHost = process.env.LOCAL_HOST || "127.0.0.1";
const localPort = parseInt(process.env.LOCAL_PORT || "3000", 10);


let controlSocket: WebSocket | null = null;
const links: Map<number, Socket> = new Map();

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

// 配置 WebSocket 通訊
function connectToServer(): void {
	controlSocket = new WebSocket(`wss://${controlHost}:${controlPort}`, undefined, {
		rejectUnauthorized: false,
		requestCert: false,
		agent: false,
		key: fs.readFileSync(process.env.CLIENT_KEY_PATH || "client-key.pem"),
		cert: fs.readFileSync(process.env.CLIENT_CERT_PATH || "client-cert.pem"),
		ca: process.env.CLIENT_CA_CERT_PATH ? fs.readFileSync(process.env.CLIENT_CA_CERT_PATH) : undefined,
		headers: {
			'Connection': 'Upgrade',
			'Upgrade': 'websocket',
		}
	});

	controlSocket.on("open", () => {
		console.log("WebSocket connection established over TLS.");
	});

	controlSocket.on("message", (message: Buffer) => handleServerData(message));
	controlSocket.on("close", () => {
		console.log("WebSocket connection closed. Reconnecting...");
		links.forEach((socket) => socket.end());
		links.clear();
		setTimeout(connectToServer, 5000);
	});

	controlSocket.on("error", (err) => {
		console.error("WebSocket connection error:", err);
	});
}

// 處理伺服器數據
function handleServerData(message: Buffer): void {
	const { type, linkId, content } = decodeMessage(message);

	if (type === 0) {
		// create_link
		createLocalConnection(linkId);
	} else if (type === 2) {
		// stream_data
		const localSocket = links.get(linkId);
		if (localSocket) {
			localSocket.write(content);
		}
	} else {
		console.log(`Unknown type=${type} received.`);
	}
}

// 建立本地連線
function createLocalConnection(linkId: number): void {
	const localSocket = createConnection({ port: localPort, host: localHost }, () => {
		console.log(`Local connection established for link_id=${linkId}`);
		controlSocket?.send(encodeMessage(0, linkId)); // 回應 link_ready
	});

	localSocket.on("data", (data) => {
		controlSocket?.send(encodeMessage(2, linkId, data)); // 發送 stream_data
	});

	localSocket.on("close", () => {
		links.delete(linkId);
		controlSocket?.send(encodeMessage(1, linkId)); // 發送 close_link
	});

	localSocket.on("error", () => {
		links.delete(linkId);
		controlSocket?.send(encodeMessage(1, linkId)); // 發送 close_link
	});

	links.set(linkId, localSocket);
}

// 開始執行
connectToServer();
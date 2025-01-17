import fs from "fs";
import {createConnection, Socket} from "net";

import dotenv from "dotenv";
import WebSocket from "ws";
import ClipArgs from "clipargs";

// 加載環境變數
dotenv.config({
	path: [".env", ".env.local", ".env.prod"],
	override: true,
});


interface CommandLineArgs {
	ssl_key:string;
	ssl_cert:string;
	remote_host:string;
	remote_port:string;
};
const ARGV = ClipArgs
.string('ssl_key', '--ssl-key', '-k')
.string('ssl_cert', '--ssl-crt', '-c')
.string('remote_host', '--host', '-h')
.string('remote_port', '--port', '-p')
.parse<Partial<CommandLineArgs>>(process.argv.slice(2));

if (ARGV._.length <= 0) {
	console.error("Usage: client.ts [options] <proxy_rule>");
	process.exit(1);
}




const controlHost = ARGV.remote_host || process.env.REMOTE_HOST || "127.0.0.1";
const controlPort = parseInt(ARGV.remote_port || process.env.REMOTE_PORT || "8000", 10);



const CLIENT_KEY_PATH = ARGV.ssl_key || process.env.CLIENT_KEY_PATH;
const CLIENT_CERT_PATH = ARGV.ssl_cert || process.env.CLIENT_CERT_PATH;
if ( !CLIENT_KEY_PATH || !CLIENT_CERT_PATH ) {
	console.error("No valid client certificate and key provided.");
	process.exit(1);
}



// Parse proxy rule from command line argument
const [proxy_rule] = ARGV._;
const [bindHost, bindPortStr, localHost, localPortStr] = proxy_rule.split(':');
if (!bindHost || !bindPortStr || !localHost || !localPortStr) {
	console.error("Invalid proxy rule format. Expected: <bind_host>:<bind_port>:<local_host>:<local_port>");
	process.exit(1);
}

const bindPort = parseInt(bindPortStr, 10);
const localPort = parseInt(localPortStr, 10);
if (isNaN(bindPort) || isNaN(localPort)) {
	console.error("Invalid port number.");
	process.exit(1);
}




let controlSocket: WebSocket | null = null;
const links: Map<number, Socket> = new Map();



// 開始執行
connectToServer();

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

// 新增 bind 函數
function bindServer(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		if (!controlSocket) {
			resolve(false);
			return;
		}

		const linkId = Math.floor(Math.random() * 0xffffffff);
		const hostBuffer = Buffer.from(host, 'utf8');
		const bindBuffer = Buffer.alloc(2 + hostBuffer.length);
		bindBuffer.writeUInt16BE(port, 0);
		hostBuffer.copy(bindBuffer, 2);

		const handleBindResponse = (message: Buffer) => {
			const { type, content } = decodeMessage(message);
			if (type === 11) { // bind response
				const response = JSON.parse(content.toString());
				controlSocket!.removeListener("message", handleBindResponse);
				resolve(response.success);
			}
		};

		controlSocket.on("message", handleBindResponse);
		controlSocket.send(encodeMessage(10, linkId, bindBuffer));
	});
}

// 修改連接處理
async function connectToServer(): Promise<void> {
	let lastPingTime = Date.now(); // Update last ping time
	
	controlSocket = (new WebSocket(`wss://${controlHost}:${controlPort}`, undefined, {
		rejectUnauthorized: false,
//		requestCert: false,
		key: fs.readFileSync(CLIENT_KEY_PATH!),
		cert: fs.readFileSync(CLIENT_CERT_PATH!)
	}))
	.on("open", async()=>{
		console.log("WebSocket connection established over TLS.");
		lastPingTime = Date.now();

		// 連接成功後，嘗試綁定本地端口
		const success = await bindServer(bindHost, bindPort);
		if (success) {
			console.log(`Successfully bound to ${bindHost}:${bindPort}`);
		} else {
			console.error(`Failed to bind to ${bindHost}:${bindPort}`);
			process.exit(1);
		}
	})
	.on("ping", ()=>{
		controlSocket?.pong();
		lastPingTime = Date.now(); // Update last ping time
	})
	.on("message", (message: Buffer)=>handleServerData(message))
	.on("close", ()=>{
		console.log("WebSocket connection closed. Closing all local connections and exiting...");
		closeAllLocalConnections();
	})
	.on("error", (err)=>{
		console.error("WebSocket connection error:", err);
		closeAllLocalConnections();
	});

	// Check for ping timeout every second
	setInterval(()=>{
		if (Date.now() - lastPingTime > 30000) { // 30 seconds
			console.error("No ping received from server in 30 seconds. Closing all local connections and exiting...");
			closeAllLocalConnections();
		}
	}, 100);
}

// Close all local connections and exit
function closeAllLocalConnections() {
	links.forEach((socket)=>socket.end());
	links.clear();
	controlSocket?.close();
	process.exit(1);
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
	}
	else if (type !== 11) {
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
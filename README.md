# Project Overview

This project provides a secure and efficient tunneling system between a client and a server, enabling controlled and encrypted communication for forwarding network traffic. The system is designed with WebSocket over TLS for secure communication and includes features like client-server certificate validation, robust message handling, and client whitelisting.

## Key Features
- Secure WebSocket communication over TLS.
- Flexible tunneling rules for port forwarding.
- Environment variable configuration for adaptability.
- Resilient design with automatic reconnection and error handling.
- Client whitelisting based on public key hashes.

---

# How to Use

## 1. **Server (`server.ts`)**

The `server.ts` script runs a control server over WebSocket, responsible for managing client connections and port bindings.

### Running the Server
1. Ensure the necessary TLS certificates (`server-key.pem` and `server-cert.pem`) are available.
2. Configure `.env` file:
   - `CONTROL_HOST`: Host address (default: `127.0.0.1`).
   - `CONTROL_PORT`: Listening port (default: `8000`).
   - `SERVER_KEY_PATH`: Path to the server's private key.
   - `SERVER_CERT_PATH`: Path to the server's certificate.
   - `AUTHORIZED_CLIENTS`: Path to the file containing authorized client public key hashes.

3. Start the server:
   ```bash
   node server.ts
   ```

### Functionality
- Handles incoming client connections securely.
- Manages port bindings and ensures only authorized clients can connect.

---

## 2. **Client (`client.ts`)**

The `client.ts` script establishes a secure WebSocket connection to the server and sets up tunneling based on user-defined rules.

### Running the Client
1. Ensure the necessary TLS certificates (`client-key.pem` and `client-cert.pem`) are available.
2. Configure `.env` file:
   - `REMOTE_HOST`: Server host (default: `127.0.0.1`).
   - `REMOTE_PORT`: Server port (default: `8000`).
   - `CLIENT_KEY_PATH`: Path to the client's private key.
   - `CLIENT_CERT_PATH`: Path to the client's certificate.

3. Specify tunneling rules directly or via command line arguments:
   - Rule format: `<bind_host>:<bind_port>:<local_host>:<local_port>`
   - Example:
     ```bash
     node client.ts --ssl-key client-key.pem --ssl-crt client-cert.pem --host 127.0.0.1 --port 8000 127.0.0.1:8080:localhost:3000
     ```

### Functionality
- Establishes a WebSocket connection to the server.
- Sets up port forwarding based on provided tunneling rules.
- Handles automatic reconnections in case of disruptions.

---

# Configuration with `.env`
Both `server.ts` and `client.ts` rely on environment variables, which can be defined in a `.env` file. Key values include:

### For `server.ts`
- `CONTROL_HOST`: The IP address for the server to listen on.
- `CONTROL_PORT`: The port for the server to listen on.
- `SERVER_KEY_PATH`, `SERVER_CERT_PATH`: Paths to the TLS key and certificate.
- `AUTHORIZED_CLIENTS`: Path to the file containing authorized client public key hashes.

### For `client.ts`
- `REMOTE_HOST`: The server's IP address.
- `REMOTE_PORT`: The server's port.
- `CLIENT_KEY_PATH`, `CLIENT_CERT_PATH`: Paths to the TLS key and certificate.

---

# Notes
- Ensure proper certificate management to maintain the integrity and security of the communication.
- The server must be started before any clients attempt to connect.
- Logs are provided for troubleshooting both at the client and server levels.
- The server will only accept connections from clients whose public key hashes are listed in the `AUTHORIZED_CLIENTS` file.

---

### SSL Certificate Generation Logic
To use `server.ts` as the root Certificate Authority (CA) for generating client certificates, follow these steps:

1. **Generate Server Key and Certificate**
	```bash
	# Generate server private key and self-signed certificate in one command
	openssl req -x509 -newkey rsa:4096 -keyout server.key -out server.crt -nodes -subj "/CN=Server"
   ```

2. **Generate Client Key and Certificate**
   ```bash
   # Generate client private key and self-signed certificate in one command
   openssl req -x509 -newkey rsa:4096 -keyout client.key -out client.crt -nodes -subj "/CN=Client"
   ```

3. **Extract the public key from the client certificate and compute its SHA1 hash**
	```bash
	openssl x509 -in client.crt -pubkey -noout | openssl rsa -pubin -outform DER 2>/dev/null | sha1
	```

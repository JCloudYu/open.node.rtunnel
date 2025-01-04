
# Project Overview

This project provides a secure and efficient tunneling system between a client and a server, enabling controlled and encrypted communication for forwarding network traffic. The system is designed with WebSocket over TLS for secure communication and includes features like client-server certificate validation and robust message handling.

## Key Features
- Secure WebSocket communication over TLS.
- Flexible tunneling rules for port forwarding.
- Environment variable configuration for adaptability.
- Resilient design with automatic reconnection and error handling.

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
   - `SERVER_CA_CERT_PATH`: Path to the CA certificate (optional, for verifying clients).
   - `VERIFY_CLIENT_CERT`: `1` to enable client certificate verification; `0` to disable (default: `1`).

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
   - `CLIENT_CA_CERT_PATH`: Path to the CA certificate (optional, for verifying the server).

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
- `SERVER_KEY_PATH`, `SERVER_CERT_PATH`, `SERVER_CA_CERT_PATH`: Paths to the TLS certificates.
- `VERIFY_CLIENT_CERT`: Whether to verify client certificates (1: enabled, 0: disabled).

### For `client.ts`
- `REMOTE_HOST`: The server's IP address.
- `REMOTE_PORT`: The server's port.
- `CLIENT_KEY_PATH`, `CLIENT_CERT_PATH`, `CLIENT_CA_CERT_PATH`: Paths to the TLS certificates.

---

# Notes
- Ensure proper certificate management to maintain the integrity and security of the communication.
- The server must be started before any clients attempt to connect.
- Logs are provided for troubleshooting both at the client and server levels.

---

### SSL Certificate Generation Logic

To use `server.ts` as the root Certificate Authority (CA) for generating client certificates, follow these steps:

1. **Generate Server Key and Certificate**
   ```bash
   # Generate server private key
   openssl genrsa -out server-key.pem 2048

   # Generate server certificate (self-signed, acting as CA)
   openssl req -new -x509 -key server-key.pem -sha256 -days 365 -out server-cert.pem -subj "/CN=RootCA"
   ```

2. **Generate Client Key and Certificate**
   ```bash
   # Generate client private key
   openssl genrsa -out client-key.pem 2048

   # Generate a certificate signing request (CSR) for the client
   openssl req -new -key client-key.pem -out client-csr.pem -subj "/CN=Client"

   # Sign the client certificate with the server's CA
   openssl x509 -req -in client-csr.pem -CA server-cert.pem -CAkey server-key.pem -CAcreateserial -out client-cert.pem -days 365 -sha256
   ```

3. **Verify Certificates**
   ```bash
   # Verify client certificate
   openssl verify -CAfile server-cert.pem client-cert.pem
   ```

4. **Optional: Convert to Other Formats**
   - Convert certificates to `.pfx` or `.pem` as needed for compatibility.

   ```bash
   # Convert to PFX
   openssl pkcs12 -export -out client-cert.pfx -inkey client-key.pem -in client-cert.pem -certfile server-cert.pem
   ```

**Note**: Replace `365` with the desired validity period in days for certificates.

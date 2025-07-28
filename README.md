# wha.ts

A modern TypeScript library for interacting with the WhatsApp Web API.

## Overview

wha.ts provides a robust, type-safe interface to the WhatsApp Web protocol, allowing developers to build applications that can interact with WhatsApp. This library handles the complex authentication, encryption, and communication protocols required to interact with WhatsApp's services.

## Features

- 🔒 **End-to-end encryption** - All communication is properly encrypted using WhatsApp's security protocols
- 📱 **Multi-device support** - Works with WhatsApp's multi-device architecture
- 🧩 **Modular design** - Use only the components you need
- 🔍 **Type safety** - Full TypeScript support with comprehensive type definitions
- 🌐 **Cross-platform** - Works in both Node.js and browser environments
- 🧪 **Protocol Buffer integration** - Uses protocol buffers for efficient message serialization

## Installation

```bash
# Using bun
bun add @wha.ts/core

# Using npm
npm install @wha.ts/core

# Using yarn
yarn add @wha.ts/core
```

## Quick Start

Here's a simple example of connecting to WhatsApp and listening for connection updates:

```typescript
async function main() {
  // Set up storage for authentication state
  const storage = new FileSystemSimpleKeyValueStore("./example-storage");

  // Initialize authentication state
  const authState = await GenericAuthState.init(storage);

  // Create WhatsApp client
  const client = createWAClient({
    auth: authState,
    logger: console,
  });

  // Listen for connection updates
  client.addListener("connection.update", (update) => {
    console.log("Connection update:", update);
    
    // Handle QR code for authentication
    if (update.qr) {
      console.log("Scan this QR code to log in:", update.qr);
    }
    
    // Connection is open and ready
    if (update.connection === "open") {
      console.log("Connected to WhatsApp!");
    }
  });

  // Connect to WhatsApp
  await client.connect();
}

main().catch(console.error);
```

## Project Structure

This project is organized as a monorepo with the following packages:

- `@wha.ts/core` - Core functionality for WhatsApp communication
- `@wha.ts/extension` - Browser extension integrations
- `@wha.ts/binary` - Utilities for handling binary data
- `@wha.ts/proto` - Protocol Buffer definitions
- `example` - Example implementations
- `test` - Testing utilities

## Documentation

For more detailed documentation, see the following resources:

- [Connection and Pairing](./docs/connection-and-pairing.md)
- [Chrome Extension Inspector](./docs/chrome-extension-inspector.md)

## Development

### Prerequisites

- [Bun](https://bun.sh/) (for package management and running scripts)
- [Node.js](https://nodejs.org/) (v18 or higher recommended)

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/wha.ts.git
cd wha.ts

# Install dependencies
bun install
```

### Build

```bash
# Build all packages
bun run build

# Build specific packages
bun run build:core
bun run build:extension
```

### Linting and Formatting

```bash
# Check and fix code style issues
bun run lint

# Format code
bun run format
```

### Testing

```bash
# Run tests
bun test
```

## Contributing

Contributions are welcome! Please see the [CONTRIBUTING.md](./CONTRIBUTING.md) file for guidelines.

## License

[MIT](./LICENSE)

## Disclaimer

This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected with WhatsApp or any of its subsidiaries or its affiliates. The official WhatsApp website can be found at https://whatsapp.com.

This library is intended for legitimate purposes only. Users are responsible for ensuring their use complies with WhatsApp's Terms of Service.
# wha.ts - WhatsApp Web API TypeScript Library

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Project Overview
wha.ts is a modern TypeScript monorepo providing a robust, type-safe interface to the WhatsApp Web protocol. The library handles complex authentication, encryption, and communication protocols required to interact with WhatsApp's services using the Noise Protocol Framework (XX pattern) with Curve25519 and AES-GCM.

## Working Effectively

### Prerequisites and Dependencies
- Install Bun as the primary package manager: `curl -fsSL https://bun.sh/install | bash`
- Node.js v18+ is recommended but Bun handles most operations
- Repository uses workspace-based monorepo structure with 9 packages

### Bootstrap and Build Process
- **Install dependencies**: `bun install` - takes ~5 seconds
- **Build all packages**: `bun run build` - takes ~35 seconds. NEVER CANCEL - Set timeout to 60+ minutes for safety
- **Build specific packages**:
  - Core library: `bun run build:core` - takes ~5 seconds
  - Browser extension: `bun run build:extension` - takes ~30 seconds

### Development Commands
- **Lint code**: `bun run lint` - takes ~1 second, shows warnings but continues
- **Format code**: `bun run format` - takes <1 second
- **Generate protocol buffers**: `bun run proto:gen` - takes ~5 seconds
- **Run tests**: `bun test` - takes ~1 second. Tests may fail due to network requirements - this is expected
- **Run example**: `bun run example` - will fail with WebSocket errors in restricted environments, which is normal

### Package Structure
The monorepo contains these packages under `packages/`:
- `@wha.ts/core` - Main WhatsApp communication library
- `@wha.ts/proto` - Protocol Buffer definitions for WhatsApp messages  
- `@wha.ts/signal` - Signal protocol implementation for end-to-end encryption
- `@wha.ts/storage` - Storage abstractions for authentication state
- `@wha.ts/binary` - Binary data handling utilities
- `@wha.ts/utils` - Shared utility functions
- `@wha.ts/types` - TypeScript type definitions
- `@wha.ts/extension` - Browser extension integrations
- `example` - Example implementation showing library usage
- `test` - Testing utilities and test suites

## Validation and Testing

### Pre-commit Validation
Always run these commands before committing changes or the CI will fail:
- `bun run format` - Fix code formatting 
- `bun run lint` - Check for code issues (warnings are acceptable)
- `bun test` - Run test suite (some failures expected due to network restrictions)

### Manual Testing Scenarios
After making changes to core functionality, validate by:
- Running `bun run build` to ensure all packages compile correctly
- Running `bun run example` to test the client initialization (expect WebSocket connection errors in restricted environments)
- Checking that all `dist/` directories are properly generated with `.js` and `.d.ts` files

### Build Artifacts
- All packages generate `dist/` directories with ESM JavaScript and TypeScript definitions
- Extension package generates browser extension manifest and bundled files
- Build process uses `tsup` for TypeScript packages and `vite` for the browser extension

## Common Tasks and Navigation

### Key Files and Directories
- `packages/core/src/` - Main client implementation and connection management
- `packages/proto/src/` - Generated protobuf definitions and schemas
- `packages/signal/src/` - Encryption and Signal protocol implementation  
- `packages/storage/src/` - Authentication state and database abstractions
- `docs/noise-protocol.md` - Detailed technical documentation of encryption implementation
- `.github/workflows/copilot-setup-steps.yml` - CI configuration
- `biome.json` - Linting and formatting configuration
- `tsconfig.json` - TypeScript configuration with path mappings

### Protocol Buffer Workflow
- Protobuf definitions are in `packages/proto/whatsapp.proto`
- Generate code with: `bun run proto:gen`
- Fetch latest definitions: `bun run --filter @wha.ts/proto proto:fetch` (requires network access)

### Example Application
- Entry point: `packages/example/example.ts`  
- Web version: `packages/example/index.html`
- Shows complete client setup including QR code generation for authentication
- Demonstrates storage configuration and connection event handling

## Important Notes

### Network and Security Limitations
- Example applications require external WhatsApp server connections
- Tests may fail in restricted network environments - this is expected behavior
- The library implements WhatsApp's security protocols including Noise_XX_25519_AESGCM_SHA256

### Build Timing Expectations
- Initial `bun install`: ~5 seconds
- Full build (`bun run build`): ~35 seconds - NEVER CANCEL, allow 60+ minutes timeout
- Individual package builds: 5-30 seconds depending on package
- Linting and formatting: <1 second each

### Troubleshooting
- If builds fail, ensure all dependencies are installed with `bun install`
- Linting warnings about unused variables are acceptable and expected
- WebSocket connection failures in examples are normal in restricted environments
- Protocol buffer generation requires the `@bufbuild/buf` tool which is automatically installed

Always build and test your changes thoroughly - the project has complex TypeScript configurations and inter-package dependencies that require careful validation.
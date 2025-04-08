import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // globals: false, // default is false, which matches your bun:test usage
    // environment: 'node', // default is node, suitable for these tests
    // setupFiles: [], // Add setup files if needed later
    // reporters: ['default'], // Default reporter is usually fine
    // coverage: { // Optional: configure coverage if needed
    //   provider: 'v8', // or 'istanbul'
    //   reporter: ['text', 'json', 'html'],
    // },
  },
});
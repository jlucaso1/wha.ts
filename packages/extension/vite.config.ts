import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
	build: {
		emptyOutDir: true,
		minify: false,
		outDir: "dist",
		sourcemap: true,
	},
	plugins: [
		tsconfigPaths(),
		webExtension({
			manifest: "manifest.json",

			webExtConfig: {
				chromiumProfile: "./extension-storage",
				keepProfileChanges: true,
				profileCreateIfMissing: true,
				startUrl: "https://web.whatsapp.com/",
				target: "chromium",
			},
		}),
	],
	server: {
		hmr: {
			port: 5173,
		},
		port: 5173,
		strictPort: true,
	},
});
